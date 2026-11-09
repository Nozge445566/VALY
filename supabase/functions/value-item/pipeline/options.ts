import type { Fingerprint } from "../types.ts";
import type { FxTable } from "../fx.ts";
import type { LocalPlanFn } from "../search-ai.ts";
import type { NeighbourRow } from "../neighbour-prior.ts";
import type { OffsetTable } from "../../_shared/offsets.ts";
import type { StoredValuation } from "../memory.ts";

export interface MemoryPort {
  /** The newest saved valuations of this item (newest first). Which one may answer is decided by memory.ts. */
  find(key: string, maxAgeMs: number): Promise<StoredValuation[]>;
  /** Past kept results of similar items (same category + brand), for the neighbour prior. Optional; failure or timeout = no prior. */
  findNeighbours?(fp: Fingerprint, maxAgeMs: number): Promise<NeighbourRow[]>;
}

export interface RunOptions {
  fx: Promise<FxTable>;
  memory: MemoryPort | null;
  /**
   * When the request came in (ms, same clock as deps.now). The 7 s limit counts from here, not from
   * when the Brain starts, so Protection, parsing and everything before it are inside the limit.
   */
  startedAt?: number;
  /**
   * Calibration multiplier k for a bucket (category|strength). Not wired to the
   * database yet: without it k is 1.
   */
  calibrationK?: (bucket: string) => number | null | undefined;
  /**
   * Kept sold prices per local search, measured by the nightly learner (country -> number, only
   * countries with enough searches). Decides which countries count as thin-data (market-tiers.ts).
   * A function so the value is read when Market Live starts. Without it the starting list is used.
   */
  learnedSoldPerSearch?: () => ReadonlyMap<string, number> | undefined;
  /**
   * Learned price level and noise per country pair (l_price_offsets), read when the answer is assembled.
   * A function so a load that finished in the meantime is used. Without it: no shift, the guessed noise.
   */
  priceOffsets?: () => OffsetTable | undefined;
  /**
   * Connector: the learned dial per bucket (l_connector_policy), read when the plan is ready. A function so a load that
   * finished in the meantime is used; never awaited. Without it: no dial (every bucket counts as 1).
   */
  connectorPolicy?: () => ReadonlyMap<string, number> | undefined;
  /** Connector: uniform random number in [0,1) for the control-group draw. Tests pass a fixed one; the draw is logged. */
  connectorDraw?: () => number;
  /** The Search AI engine call. Without it the real in-process engine runs; tests pass a fake so nothing touches the network. */
  localPlan?: LocalPlanFn;
}
