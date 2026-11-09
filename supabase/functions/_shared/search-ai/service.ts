// The learned-strategy cache of the Search AI (PolicyHolder): refreshes lazily, keeps the old policy on failure.
// Pure except for: the injected db, the injected clock, the injected logger.
// Math.random / Date.now are used ONLY at the call site (local-engine.ts), never here.

import { emptyPolicy, policyFromJson, type Policy } from "./policy.ts";

export const DEFAULT_REFRESH_SECONDS = 300;

export interface PolicyDb { activePolicy(): Promise<Record<string, any> | null> }

export class PolicyHolder {
  policy: Policy = emptyPolicy(0);
  loadedAt: number | null = null; // epoch seconds, like time.time()
  private lastTry: number | null = null;
  private inflight: Promise<void> | null = null;
  private db: PolicyDb | null;
  private nowSeconds: () => number;
  private everySeconds: number;
  private log: (m: string) => void;
  constructor(db: PolicyDb | null, nowSeconds: () => number, everySeconds = DEFAULT_REFRESH_SECONDS, log: (m: string) => void = () => {}) {
    this.db = db; this.nowSeconds = nowSeconds; this.everySeconds = everySeconds; this.log = log;
  }

  get(): Policy { return this.policy; }

  // Same as PolicyHolder.refresh(): on failure KEEP the old policy and log it.
  async refresh(): Promise<void> {
    if (this.db === null) return;
    this.lastTry = this.nowSeconds();
    try {
      const row = await this.db.activePolicy();
      this.policy = row ? policyFromJson(Math.trunc(Number(row.version)), row.policy) : emptyPolicy(0);
      this.loadedAt = this.nowSeconds();
    } catch (e) {
      this.log(`[search-ai] policy refresh failed, keeping the old one: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Edge Functions can be stateless: refresh lazily when the policy is older than the interval.
  async ensureFresh(): Promise<Policy> {
    const due = this.lastTry === null || this.nowSeconds() - this.lastTry >= this.everySeconds;
    if (due) {
      this.inflight ??= this.refresh().finally(() => { this.inflight = null; });
      await this.inflight;
    } else if (this.inflight) await this.inflight;
    return this.policy;
  }
}
