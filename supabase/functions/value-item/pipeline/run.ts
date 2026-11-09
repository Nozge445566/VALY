import type { BrainInput, BrainRun } from "../types.ts";
import type { BrainConfig, Deps } from "../config.ts";
import type { RunOptions } from "./options.ts";
import { createRunState } from "./state.ts";
import { eyesStage } from "./stages/eyes.ts";
import { memoryStage } from "./stages/memory.ts";
import { marketStage } from "./stages/market.ts";
import { judgeStage } from "./stages/judge.ts";
import { finishStage } from "./stages/finish.ts";

export async function runBrain(input: BrainInput, cfg: BrainConfig, deps: Deps, opts: RunOptions): Promise<BrainRun> {
  return await runBrainCore(input, cfg, deps, opts);
}

/**
 * The stages run in order and share one RunState. A stage returns null to continue or a finished BrainRun to stop early.
 * Each stage keeps the original await order and starts its promises at the same moments as before.
 */
async function runBrainCore(input: BrainInput, cfg: BrainConfig, deps: Deps, opts: RunOptions): Promise<BrainRun> {
  const rs = createRunState(input, cfg, deps, opts);

  const early = (await eyesStage(rs)) ?? (await memoryStage(rs)) ?? (await marketStage(rs)) ?? (await judgeStage(rs));
  if (early) return early;
  return await finishStage(rs);
}
