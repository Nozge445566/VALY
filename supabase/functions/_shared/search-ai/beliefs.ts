// Search AI's second job: it learns HOW MUCH EACH SOURCE CAN BE TRUSTED, and the statistical selector (value-item/select-ads.ts)
// uses that when it picks the ads for the Judge. The two are one loop, two cogs:
//
//     selector (math)  --- per-source inlier evidence (sum of r_i) --->  SourceBook (Search AI)
//     SourceBook       --- Beta(alpha, beta) reliability per source ---> selector's prior rel_i
//
// A cleaner source gets a higher rel_i, so its ads are trusted more and picked more, which produces cleaner evidence about it.
// A dirty source decays the same way. With little data the selector runs on the math alone (the prior); as evidence builds up the
// learned beliefs take over more and more.
//
// Design notes (read before changing):
//  * The book stores EVIDENCE (a = inlier mass, b = outlier mass) per (site, kind), never the belief itself. belief = prior + evidence,
//    so changing a prior never corrupts what was learned, and database updates are commutative increments (safe for concurrent instances).
//  * EMPIRICAL-BAYES PRIOR. A site nobody has seen is not given the fixed default once the book knows the market: its prior is the
//    default blended with what all learned sites of that kind look like (strength POOL_STRENGTH pseudo-observations).
//  * ANTI-FEEDBACK. r_i was computed WITH the old belief, so raw evidence would reinforce itself. Per site and search at most
//    EVIDENCE_CAP_PER_CALL ads count, evidence decays (FORGET per update, markets drift), and the total weight per source is capped at
//    MAX_WEIGHT, so one noisy search can never lock a source in.
//  * Everything here is pure and synchronous except flush()/refresh(), which are best-effort and never throw.
import { DEFAULT_BELIEF, type SourceBelief } from "../../value-item/select-ads.ts";

export type Kind = "sold" | "asking";
export interface Evidence {
  site: string;
  kind: Kind;
  n: number;
  inlierMass: number;
}
export interface BeliefRow {
  site: string;
  kind: string;
  alpha: number; // evidence only (inlier mass)
  beta: number; // evidence only (outlier mass)
}

export const POOL_STRENGTH = 20; // the pooled prior is worth this many observations
export const POOL_MIN_EVIDENCE = 30; // below this many learned observations of a kind the plain default prior is used
export const EVIDENCE_CAP_PER_CALL = 4; // ads of one site that count from ONE search
export const FORGET = 0.995; // per update; half-life about 140 updates of that source
export const MAX_WEIGHT = 400; // a + b never exceeds this (the belief stays able to move)
export const REFRESH_SECONDS = 300;
export const MAX_PENDING = 2000;

const keyOf = (site: string, kind: string): string => `${kind === "sold" ? "sold" : "asking"}|${site.toLowerCase()}`;

export interface BeliefDb {
  loadSourceBeliefs(): Promise<BeliefRow[]>;
  addSourceBelief(site: string, kind: string, dAlpha: number, dBeta: number, forget: number, maxWeight: number): Promise<void>;
}

export class SourceBook {
  private ev = new Map<string, { site: string; kind: Kind; a: number; b: number }>();
  private pending = new Map<string, { site: string; kind: Kind; a: number; b: number }>();
  private loadedAt: number | null = null;
  private inflight: Promise<void> | null = null;

  /** The prior of a source this book has not seen: the default, blended with what the learned sources of that kind look like. */
  priorFor(kind: Kind): SourceBelief {
    const def = DEFAULT_BELIEF(kind);
    let a = 0;
    let b = 0;
    for (const e of this.ev.values()) if (e.kind === kind) { a += e.a; b += e.b; }
    if (a + b < POOL_MIN_EVIDENCE) return def;
    const mean = (a + def.alpha) / (a + b + def.alpha + def.beta);
    const m = Math.min(0.99, Math.max(0.5, mean));
    return { alpha: POOL_STRENGTH * m, beta: POOL_STRENGTH * (1 - m) };
  }

  /** What the selector asks for: Beta belief = prior + this source's evidence. */
  belief(f: { site: string; kind: string }): SourceBelief {
    const kind: Kind = f.kind === "sold" ? "sold" : "asking";
    const p = this.priorFor(kind);
    const e = this.ev.get(keyOf(f.site, kind));
    return e ? { alpha: p.alpha + e.a, beta: p.beta + e.b } : p;
  }

  /** What the selector reports after a selection. Updates the book at once (in this process) and queues the database increment. */
  record(evidence: readonly Evidence[], strength = 1): void {
    for (const x of evidence) {
      if (!x.site || !(x.n > 0)) continue;
      const kind: Kind = x.kind === "sold" ? "sold" : "asking";
      const k = keyOf(x.site, kind);
      // cap, keeping the observed inlier RATE
      const n = Math.min(x.n, EVIDENCE_CAP_PER_CALL);
      const rate = Math.min(1, Math.max(0, x.inlierMass / x.n));
      const dA = n * rate * strength;
      const dB = (n - n * rate) * strength;
      const cur = this.ev.get(k) ?? { site: x.site.toLowerCase(), kind, a: 0, b: 0 };
      let a = cur.a * FORGET + dA;
      let b = cur.b * FORGET + dB;
      if (a + b > MAX_WEIGHT) { const s = MAX_WEIGHT / (a + b); a *= s; b *= s; }
      this.ev.set(k, { ...cur, a, b });
      const q = this.pending.get(k) ?? { site: x.site.toLowerCase(), kind, a: 0, b: 0 };
      this.pending.set(k, { ...q, a: q.a + dA, b: q.b + dB });
    }
    if (this.pending.size > MAX_PENDING) this.pending.clear(); // never grow without bound if the database is away
  }

  /** Replace the in-memory evidence with the database's (it is the sum over all instances). Pending local increments are re-applied on top. */
  load(rows: readonly BeliefRow[]): void {
    const next = new Map<string, { site: string; kind: Kind; a: number; b: number }>();
    for (const r of rows) {
      const a = Number(r.alpha);
      const b = Number(r.beta);
      if (!r.site || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) continue;
      const kind: Kind = r.kind === "sold" ? "sold" : "asking";
      next.set(keyOf(r.site, kind), { site: r.site.toLowerCase(), kind, a, b });
    }
    for (const [k, p] of this.pending) {
      const c = next.get(k) ?? { site: p.site, kind: p.kind, a: 0, b: 0 };
      next.set(k, { ...c, a: c.a + p.a, b: c.b + p.b });
    }
    this.ev = next;
  }

  /** Send the queued increments. Best effort: a failed row stays queued for the next flush. Never throws. */
  async flush(db: BeliefDb | null): Promise<void> {
    if (!db || this.pending.size === 0) return;
    const batch = [...this.pending.entries()];
    for (const [k] of batch) this.pending.delete(k);
    const results = await Promise.allSettled(batch.map(([, p]) => db.addSourceBelief(p.site, p.kind, p.a, p.b, FORGET, MAX_WEIGHT)));
    results.forEach((res, i) => {
      if (res.status === "rejected") {
        const [k, p] = batch[i];
        const q = this.pending.get(k);
        this.pending.set(k, q ? { ...q, a: q.a + p.a, b: q.b + p.b } : p);
      }
    });
  }

  /** Lazy refresh from the database, at most every REFRESH_SECONDS. Never throws, never blocks longer than the db's own timeout. */
  async ensureFresh(db: BeliefDb | null, nowSeconds: number): Promise<void> {
    if (!db) return;
    if (this.loadedAt !== null && nowSeconds - this.loadedAt < REFRESH_SECONDS) return;
    this.loadedAt = nowSeconds; // set first: a failing database is not retried on every request
    this.inflight ??= (async () => {
      try { this.load(await db.loadSourceBeliefs()); } catch { /* keep what we have */ }
    })().finally(() => { this.inflight = null; });
    await this.inflight;
  }

  /** For tests and the admin view. */
  snapshot(): { site: string; kind: Kind; a: number; b: number; reliability: number }[] {
    return [...this.ev.values()].map((e) => ({ ...e, reliability: this.belief(e).alpha / (this.belief(e).alpha + this.belief(e).beta) }));
  }
}

/** The shape market-live.ts needs. A SourceBook satisfies it; tests can pass a fake. */
export interface SourceBeliefs {
  belief(f: { site: string; kind: string }): SourceBelief | undefined;
  record(evidence: readonly Evidence[], strength?: number): void;
}

// ---------------------------------------------------------------- the Judge as a second teacher
// The selector's r_i is the statistics' opinion of an ad. The Judge saw the ad next to the real item and the Identification, so its label is
// a stronger and independent signal: it breaks the circle "the belief produced r_i, r_i updates the belief". Same Evidence shape, higher strength.
export const JUDGE_STRENGTH = 2;
const P_SAME: Record<string, number> = { certain: 1, likely: 0.85, unsure: 0.5, unlikely: 0.15, no: 0 };
export interface JudgeLabelLike { id: number; match: string; p_same?: string; ad_reliability?: string }
export interface FindingLike { id: number; site: string; kind: string; priceUsd: number }

/** Per (site, kind): how many priced ads the Judge looked at and how much of that it considered the right item and a clean listing. Pure. */
export function judgeEvidence(findings: readonly FindingLike[], labels: readonly JudgeLabelLike[]): Evidence[] {
  const byId = new Map(labels.map((l) => [l.id, l]));
  const out = new Map<string, Evidence>();
  for (const f of findings) {
    const l = byId.get(f.id);
    if (!l || !(f.priceUsd > 0)) continue;
    const base = l.match === "same" ? 1 : l.match === "similar" ? 0.7 : 0;
    const same = l.p_same !== undefined && l.p_same in P_SAME ? P_SAME[l.p_same] : 1;
    const clean = l.ad_reliability === "low" ? 0.5 : 1;
    const kind: Kind = f.kind === "sold" ? "sold" : "asking";
    const k = keyOf(f.site, kind);
    const e = out.get(k) ?? { site: f.site, kind, n: 0, inlierMass: 0 };
    e.n += 1;
    e.inlierMass += base * Math.max(0.2, same) * clean;
    out.set(k, e);
  }
  return [...out.values()];
}
