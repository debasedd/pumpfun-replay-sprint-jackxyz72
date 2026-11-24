// Surge — momentum paper bot for the Pump.fun Replay Sprint.
// The grader runs `node /bot/main.ts`; the strategy lives in surge.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createSurgeBot, DEFAULT_CONFIG } from './surge.ts';

await runBot(createSurgeBot(DEFAULT_CONFIG));
