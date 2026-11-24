// Surge — a momentum paper bot for the pump.fun bonding-curve replay.
//
// Idea: a fresh bonding curve is mostly noise and bundled dumps. A curve earns
// a buy only once it has lived a while and its tape shows buyers arriving
// faster than sellers: net SOL flowing in over a lookback window, several
// different wallets buying, price climbing and sitting close to the window
// high, and the inflow speeding up (second half of the window stronger than
// the first). The first ticket is deliberately small; the bot only adds size
// while the trade is already working, so a false start costs a few cents and
// a real runner gets real size. Every position is sold whole on the first of
// a hard stop, a trailing stop off its best value, a fade in flow, or a time
// cap — no hoping, no averaging down.
//
// A separate pacing loop keeps the run above the guardrails (200 fills over
// 20 coins): if the bot's own fills or coins fall behind the elapsed share of
// the session, it opens tiny probe round trips on liquid curves and closes
// them as soon as the buy lands.
//
// Deterministic by construction: no clock, no Math.random, no environment —
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface SurgeConfig {
  /** Lookback window for the entry signal, in slots. */
  lookback: number;
  /** Minimum net SOL (buys minus sells) inside the lookback. */
  minNetInflow: number;
  /** Minimum buy trades inside the lookback. */
  minBuys: number;
  /** Minimum distinct buying wallets inside the lookback. */
  minWallets: number;
  /** Minimum price rise over the lookback, as a fraction (0.04 = +4%). */
  minRise: number;
  /** Maximum price rise over the lookback — skip curves that already ran away. */
  maxRise: number;
  /** Second-half net inflow must be at least this multiple of first-half net. */
  accelRatio: number;
  /** Last price must be at least this fraction of the window high. */
  nearTop: number;
  /** Largest single wallet's share of window buy SOL (1 = no limit). */
  maxWalletShare: number;
  /** Real SOL reserve bounds for an entry. */
  minCurveSol: number;
  maxCurveSol: number;
  /** Slots after creation before an entry is allowed. */
  minCurveAge: number;
  /** Total SOL a position may grow to. */
  stakeCap: number;
  /** Smallest buy worth sending. */
  minTicket: number;
  /** Slippage allowed on buys, bps; sells always go out at 10000. */
  buySlippageBps: number;
  /** Sell when value falls this far below cost. */
  stopLoss: number;
  /** Sell when value falls this far below its peak. */
  trailDrop: number;
  /** Trailing stop only arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Lookback for the fade exit, in slots. */
  fadeLookback: number;
  /** Exit when net flow over the fade lookback is below minus this (SOL). */
  fadeOutflow: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  whaleSell: number;
  /** Exit after holding this many slots (unless comfortably up). */
  maxHoldSlots: number;
  /** The time cap does not apply while value is above cost * (1 + holdIfUp). */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve can be bought again. */
  reentryGap: number;
  /** Most entries per curve over the whole run. */
  maxEntriesPerCurve: number;
  /** Add to a winner while the signal still holds, up to stakeCap. */
  pyramidOn: boolean;
  /** First ticket of a position (SOL). */
  firstTicket: number;
  /** Each add-on ticket (SOL). */
  addTicket: number;
  /** Add only once price is this far above the last add's decision price. */
  addPriceStep: number;
  /** Add only while position value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Add only while net inflow over the lookback is at least this (SOL). */
  addMinInflow: number;
  /** Most SOL per single buy order. */
  maxTicket: number;
  /** Most momentum positions open at once (rest of the cap is for probes). */
  maxLive: number;
  /** Most SOL at cost across all positions at once. */
  maxTotalExposure: number;
  /** Guardrail pacing targets. */
  paceCoins: number;
  paceFills: number;
  paceWindowSecs: number;
  probeTicket: number;
  maxProbesLive: number;
}

// Tuned on the dev window, favouring flat regions of the parameter grid over
// the single best cell, so the bot survives an unseen final window.
export const DEFAULT_CONFIG: SurgeConfig = {
  lookback: 40,
  minNetInflow: 0.8,
  minBuys: 4,
  minWallets: 4,
  minRise: 0.04,
  maxRise: 2.0,
  accelRatio: 0.8,
  nearTop: 0.93,
  maxWalletShare: 0.9,
  minCurveSol: 1.5,
  maxCurveSol: 80,
  minCurveAge: 300,
  stakeCap: 1.5,
  minTicket: 0.01,
  buySlippageBps: 1500,
  stopLoss: 0.25,
  trailDrop: 0.35,
  trailArm: 0.08,
  fadeLookback: 12,
  fadeOutflow: 0.5,
  whaleSell: 5,
  maxHoldSlots: 1200,
  holdIfUp: 0.2,
  reentryGap: 200,
  maxEntriesPerCurve: 2,
  pyramidOn: true,
  firstTicket: 0.08,
  addTicket: 0.25,
  addPriceStep: 0,
  addIfUp: -0.02,
  addMinInflow: 0.5,
  maxTicket: 1000,
  maxLive: 5,
  maxTotalExposure: 6,
  paceCoins: 25,
  paceFills: 240,
  paceWindowSecs: 14_400,
  probeTicket: 0.01,
  maxProbesLive: 1,
};

const SOL = 1e9;
const CURVE_TAKE = 0.0125;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: number;
  wallet: string;
  price: number;
}

interface CurveLog {
  born: number | null;
  ticks: Tick[];
  entries: number;
  lastExitSlot: number;
}

interface OpenTrade {
  openedSlot: number;
  bestValue: number;
  spent: number;
  closing: boolean;
  sawFill: boolean;
  lastAddPrice: number;
  latestValue: number;
}

interface WindowStats {
  net: number;
  buys: number;
  wallets: number;
  rise: number;
  nearTop: boolean;
  accelerating: boolean;
  concentrated: boolean;
}

export function createSurgeBot(cfg: SurgeConfig = DEFAULT_CONFIG): Bot {
  const logs = new Map<Pubkey, CurveLog>();
  const open = new Map<Pubkey, OpenTrade>();
  // Probe round trips in flight: false while the buy is pending, true once selling.
  const probes = new Map<Pubkey, boolean>();
  let ownFills = 0;
  const ownCoins = new Set<Pubkey>();
  let sessionStart: number | null = null;
  let sessionNow: number | null = null;
  const retain = Math.max(cfg.lookback, cfg.fadeLookback) + 5;

  const logOf = (mint: Pubkey): CurveLog => {
    let log = logs.get(mint);
    if (log === undefined) {
      log = { born: null, ticks: [], entries: 0, lastExitSlot: -1e12 };
      logs.set(mint, log);
    }
    return log;
  };

  // Summarise one curve's tape over the lookback window ending at `now`.
  const windowStats = (log: CurveLog, now: number): WindowStats | null => {
    const start = now - cfg.lookback;
    const half = now - cfg.lookback / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netFirst = 0;
    let netSecond = 0;
    let firstPrice = -1;
    let high = 0;
    let lastPrice = 0;
    const perWallet = new Map<string, number>();
    for (const tick of log.ticks) {
      if (tick.slot <= start) {
        firstPrice = tick.price;
        continue;
      }
      if (firstPrice < 0) firstPrice = tick.price;
      const signed = tick.isBuy ? tick.sol : -tick.sol;
      if (tick.slot <= half) netFirst += signed;
      else netSecond += signed;
      if (tick.isBuy) {
        buySol += tick.sol;
        buys++;
        perWallet.set(tick.wallet, (perWallet.get(tick.wallet) ?? 0) + tick.sol);
      } else {
        sellSol += tick.sol;
      }
      if (tick.price > high) high = tick.price;
      lastPrice = tick.price;
    }
    if (firstPrice <= 0 || lastPrice <= 0) return null;
    let biggest = 0;
    for (const v of perWallet.values()) if (v > biggest) biggest = v;
    return {
      net: buySol - sellSol,
      buys,
      wallets: perWallet.size,
      rise: lastPrice / firstPrice - 1,
      nearTop: lastPrice >= high * cfg.nearTop,
      accelerating: netSecond > 0 && netSecond >= cfg.accelRatio * netFirst,
      concentrated: biggest > cfg.maxWalletShare * buySol,
    };
  };

  // Net SOL flow (buys minus sells) over the last `span` slots.
  const recentFlow = (log: CurveLog, now: number, span: number): number => {
    let net = 0;
    for (let i = log.ticks.length - 1; i >= 0; i--) {
      const tick = log.ticks[i]!;
      if (tick.slot <= now - span) break;
      net += tick.isBuy ? tick.sol : -tick.sol;
    }
    return net;
  };

  const entryOk = (log: CurveLog, now: number, curveSol: number): boolean => {
    if (curveSol < cfg.minCurveSol || curveSol > cfg.maxCurveSol) return false;
    if (log.born === null || now - log.born < cfg.minCurveAge) return false;
    const stats = windowStats(log, now);
    if (stats === null) return false;
    if (stats.buys < cfg.minBuys || stats.wallets < cfg.minWallets) return false;
    if (stats.net < cfg.minNetInflow) return false;
    if (stats.rise < cfg.minRise || stats.rise > cfg.maxRise) return false;
    if (!stats.nearTop || !stats.accelerating || stats.concentrated) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const whaleSells = new Set<Pubkey>();
      const active = new Set<Pubkey>();

      for (const fill of batch.fills) {
        if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
          ownFills++;
          ownCoins.add(fill.mint);
        }
      }
      for (const event of batch.events) {
        if (event.block_time !== null) {
          if (sessionStart === null) sessionStart = event.block_time;
          if (sessionNow === null || event.block_time > sessionNow) sessionNow = event.block_time;
        }
        if (event.event === 'CreateEvent') {
          logOf(event.mint).born = event.slot;
        } else if (event.event === 'TradeEvent') {
          const log = logOf(event.mint);
          const sol = Number(event.sol_amount) / SOL;
          log.ticks.push({
            slot: event.slot,
            isBuy: event.is_buy,
            sol,
            wallet: event.user,
            price: Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves),
          });
          active.add(event.mint);
          if (!event.is_buy && sol >= cfg.whaleSell) whaleSells.add(event.mint);
        }
      }
      for (const mint of active) {
        const log = logs.get(mint)!;
        let drop = 0;
        while (drop < log.ticks.length && log.ticks[drop]!.slot <= now - retain) drop++;
        if (drop > 0) log.ticks.splice(0, drop);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingCount = new Map<Pubkey, number>();
      for (const pending of state.pending.values()) {
        pendingCount.set(pending.order.mint, (pendingCount.get(pending.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const perBatchCap = state.hello.caps.max_orders_per_batch;
      const txFee = Number(state.txFeeLamports()) / SOL;

      // 1. Exits first: sell whole positions on stop / trail / fade / whale / time.
      for (const [mint, trade] of open) {
        const position = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (position === undefined) {
          if (!pendingCount.has(mint)) {
            open.delete(mint);
            const log = logOf(mint);
            if (trade.sawFill) log.lastExitSlot = now;
            else log.entries--;
          }
          continue;
        }
        trade.sawFill = true;
        if (curve === undefined || curve.complete) continue;
        const mark = marks.get(mint);
        const vq = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const rq = mark ? Number(mark.real_quote_reserves) : Number(curve.real_quote_reserves);
        const tokens = Number(position.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / SOL) * (1 - CURVE_TAKE) - txFee;
        const cost = Number(position.cost_lamports) / SOL;
        if (value > trade.bestValue) trade.bestValue = value;
        trade.latestValue = value;
        const log = logOf(mint);
        let shouldExit = trade.closing;
        if (!shouldExit && value < cost * (1 - cfg.stopLoss)) shouldExit = true;
        if (!shouldExit && trade.bestValue >= cost * (1 + cfg.trailArm) && value < trade.bestValue * (1 - cfg.trailDrop)) shouldExit = true;
        if (!shouldExit && recentFlow(log, now, cfg.fadeLookback) < -cfg.fadeOutflow) shouldExit = true;
        if (!shouldExit && whaleSells.has(mint)) shouldExit = true;
        if (!shouldExit && now - trade.openedSlot > cfg.maxHoldSlots && value < cost * (1 + cfg.holdIfUp)) shouldExit = true;
        if (!shouldExit) continue;
        trade.closing = true;
        if (pendingCount.has(mint)) {
          let sellFlying = false;
          for (const pending of state.pending.values()) {
            if (pending.order.mint === mint && pending.order.side === 'sell') sellFlying = true;
          }
          if (sellFlying) continue;
        }
        if (orders.length >= perBatchCap) break;
        orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
      }

      // 2. Probe round trips: dump the probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const position = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (position === undefined) {
          if (!pendingCount.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingCount.has(mint)) continue;
        if (orders.length >= perBatchCap) break;
        orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // 3. Entries and pyramid adds.
      let freeSol = Number(state.freeCashLamports()) / SOL;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = cfg.maxLive - open.size;
      let exposure = 0;
      for (const [mint, trade] of open) {
        exposure += Math.max(trade.spent, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / SOL);
      }
      for (const mint of active) {
        if (orders.length >= perBatchCap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingCount.has(mint) || probes.has(mint)) continue;
        const log = logs.get(mint)!;
        const trade = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const curveSol = Number(curve.real_quote_reserves) / SOL;
        let ticket: number;
        if (trade === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (log.entries >= cfg.maxEntriesPerCurve || now - log.lastExitSlot < cfg.reentryGap) continue;
          if (!entryOk(log, now, curveSol)) continue;
          ticket = Math.min(cfg.firstTicket, cfg.stakeCap);
        } else {
          // Pyramid into strength only: already up, price stepped up from the
          // last add, and inflow still positive.
          if (!cfg.pyramidOn || trade.closing || !trade.sawFill || trade.spent >= cfg.stakeCap - cfg.minTicket) continue;
          const position = state.positions.get(mint);
          if (position === undefined) continue;
          if (price < trade.lastAddPrice * (1 + cfg.addPriceStep)) continue;
          if (trade.latestValue < (Number(position.cost_lamports) / SOL) * (1 + cfg.addIfUp)) continue;
          if (recentFlow(log, now, cfg.lookback) < cfg.addMinInflow) continue;
          if (curveSol > cfg.maxCurveSol) continue;
          ticket = Math.min(cfg.addTicket, cfg.stakeCap - trade.spent);
        }
        const sizeCap = Math.floor(Number(state.maxBuyLamports(mint))) / SOL;
        let amount = Math.min(sizeCap, ticket, cfg.maxTicket, cfg.maxTotalExposure - exposure);
        if (amount > freeSol - txFee) amount = freeSol - txFee;
        if (amount < cfg.minTicket) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * SOL)), max_slippage_bps: cfg.buySlippageBps });
        freeSol -= amount + txFee;
        exposure += amount;
        if (trade === undefined) {
          open.set(mint, { openedSlot: now, bestValue: 0, spent: amount, closing: false, sawFill: false, lastAddPrice: price, latestValue: 0 });
          log.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          trade.spent += amount;
          trade.lastAddPrice = price;
        }
      }

      // 4. Guardrail pacing: open a probe when fills or coins lag the session pace.
      if (probes.size < cfg.maxProbesLive && slotsLeft > 0 && sessionStart !== null && sessionNow !== null) {
        const pace = Math.min(1, (sessionNow - sessionStart) / cfg.paceWindowSecs);
        const coinsBehind = ownCoins.size < Math.ceil(cfg.paceCoins * pace);
        const fillsBehind = ownFills < Math.ceil(cfg.paceFills * pace);
        if (coinsBehind || fillsBehind) {
          const minReserve = (cfg.probeTicket * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of active) {
            if (orders.length >= perBatchCap || probes.size >= cfg.maxProbesLive) break;
            if (open.has(mint) || probes.has(mint) || pendingCount.has(mint) || state.positions.has(mint)) continue;
            if (coinsBehind && !fillsBehind && ownCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / SOL < minReserve * 1.5) continue;
            if (freeSol < cfg.probeTicket + 2 * txFee) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(cfg.probeTicket * SOL)), max_slippage_bps: cfg.buySlippageBps });
            probes.set(mint, false);
            freeSol -= cfg.probeTicket + txFee;
          }
        }
      }
      return orders;
    },
  };
}
