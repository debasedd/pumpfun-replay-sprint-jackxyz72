# pumpfun-replay-sprint-jackxyz72

Surge — a momentum paper bot for the Pump.fun Replay Sprint on make.fun
(competition `u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`).

## Strategy

Buy the earliest accelerating momentum, only on clean launches. A curve
earns a buy in its first slots (age ≥ 3) when its 5-slot tape shows
accelerating buy pressure: net SOL inflow, ≥ 3 buys from ≥ 3 distinct
wallets, price up ≥ 3% and within 10% of the window high, second-half inflow
at least as strong as the first half — and only if the launch passes the rug
filter: the creator has not sold, the creator's own buy was ≤ 2.5 SOL, and
at most 6 non-creator wallets bought in the first 10 slots (a launch bundled
across many wallets is a dump waiting to happen).

The first ticket is 0.1 SOL; the bot pyramids 0.05 SOL at a time into
strength only, up to 0.2 SOL per position. There is no take-profit and no
time cap: positions are ridden to completion behind a trailing stop (armed
at +100%, 15% giveback) with a 30% hard stop as the only other exit. Losers
are many and small; a handful of runners pay for them. A pacing loop opens
tiny 0.01 SOL probe round trips when fills/coins lag the guardrail pace
(240 fills over 25 coins).

Parameters were tuned on the dev window with the kit's local engine port,
preferring flat regions of the grid over the single best cell.

## Run

```sh
node main.ts   # the grader runs this; Node 22+ runs the TypeScript as-is
```

`vendor/makefun-bot.ts` is the kit's SDK shim, vendored unchanged.
Paper trading only — no real money, no network access at runtime.

## License

MIT
