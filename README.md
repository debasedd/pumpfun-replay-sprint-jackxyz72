# pumpfun-replay-sprint-jackxyz72

Surge — a momentum paper bot for the Pump.fun Replay Sprint on make.fun
(competition `u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`).

## Strategy

A curve earns a buy only once it is mature (300+ slots old) and its tape shows
accelerating buy pressure over a 40-slot lookback: net SOL inflow ≥ 0.8,
≥ 4 buys from ≥ 4 distinct wallets, price up 4–200% and sitting within 7% of
the window high, second-half inflow at least 0.8× first-half inflow, and no
single wallet dominating buys. The first ticket is small (0.08 SOL); the bot
pyramids into strength only, up to a 1.5 SOL stake per position. Positions are
sold whole on a 25% stop-loss, a 35% trailing stop (armed at +8%), a fade in
flow, a whale sell, or a 1200-slot time cap. A pacing loop opens tiny
0.01 SOL probe round trips when fills/coins lag the guardrail pace
(240 fills over 25 coins).

## Run

```sh
node main.ts   # the grader runs this; Node 22+ runs the TypeScript as-is
```

`vendor/makefun-bot.ts` is the kit's SDK shim, vendored unchanged.
Paper trading only — no real money, no network access at runtime.

## License

MIT
