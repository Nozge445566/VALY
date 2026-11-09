// the nightly run (no network; db and clock are injected).
// Python traps handled: json.dumps formatting (pyJsonDumps), isoformat() (+00:00), Python truthiness, null not undefined,
// result key order (action first, then named key, then spread of info / metrics).

import { FIXED_TEMPLATES } from "../../value-item/fixed-templates.ts";
import { decideRollback, isoformat, learn, parseTime } from "./learner.ts";
import { policyFromJson, policyToJson } from "./policy.ts";
import type { Row } from "./learner.ts";

export const LOOKBACK_DAYS = 60;
const DAY_MS = 86_400_000;

export type Json = Record<string, any>;

/** Same method names as supabase_rest.py (camelCase). All may be sync or async. */
export interface SearchDb {
  fetchLogs(sinceIso: string): Promise<Row[]> | Row[];
  activePolicy(): Promise<Json | null> | Json | null;
  policyBefore(version: number): Promise<Json | null> | Json | null;
  deactivate(version: number, note: string): Promise<void> | void;
  activate(version: number, metrics: Json, note: string): Promise<void> | void;
  insertPolicy(policy: Json, metrics: Json, note: string): Promise<number> | number;
}

export function knownPatterns(): Set<string> {
  return new Set(FIXED_TEMPLATES.map((t) => t.pattern));
}

/** Python truthiness for the values this file meets. */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** Python repr() of a float (only the cases that can occur: finite numbers). */
function pyFloat(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-4 || a >= 1e16)) {
    const [m, e] = x.toExponential().split("e");
    const sign = e.startsWith("-") ? "-" : "+";
    return `${m}e${sign}${e.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  return String(x);
}

/**
 * Python json.dumps(value) with default settings: separators ", " and ": ", ensure_ascii=True.
 * JSON has no int/float split, so keys listed in `floatKeys` print as Python floats (1.0, not 1).
 */
export function pyJsonDumps(value: unknown, floatKeys: ReadonlySet<string> = new Set(), key: string | null = null): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return key !== null && floatKeys.has(key) ? pyFloat(value) : Number.isInteger(value) ? String(value) : pyFloat(value);
  if (typeof value === "string") {
    let out = '"';
    for (const ch of value) {
      const c = ch.codePointAt(0)!;
      if (ch === '"') out += '\\"';
      else if (ch === "\\") out += "\\\\";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch === "\b") out += "\\b";
      else if (ch === "\f") out += "\\f";
      else if (c < 0x20 || (c > 0x7e && c <= 0xffff)) out += "\\u" + c.toString(16).padStart(4, "0");
      else if (c > 0xffff) {
        const v = c - 0x10000;
        out += "\\u" + (0xd800 + (v >> 10)).toString(16) + "\\u" + (0xdc00 + (v & 0x3ff)).toString(16);
      } else out += ch;
    }
    return out + '"';
  }
  if (Array.isArray(value)) return "[" + value.map((v) => pyJsonDumps(v, floatKeys, null)).join(", ") + "]";
  const o = value as Json;
  return "{" + Object.keys(o).map((k) => pyJsonDumps(k) + ": " + pyJsonDumps(o[k], floatKeys, k)).join(", ") + "}";
}

const INFO_FLOAT_KEYS: ReadonlySet<string> = new Set(["recent_rate", "baseline_rate"]);

export async function run(db: SearchDb, now: Date): Promise<Json> {
  const activeRow = await db.activePolicy();
  const active = activeRow ? policyFromJson(Math.trunc(Number(activeRow.version)), activeRow.policy) : null;
  const since = isoformat(new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS));
  const rows = await db.fetchLogs(since);

  // 1. Drift watch first: a bad live policy must not survive the night.
  if (activeRow && active) {
    const m = pyTruthy(activeRow.metrics) ? activeRow.metrics : {};
    const activated = new Date(parseTime(pyTruthy(m.activated_at) ? m.activated_at : activeRow.created_at));
    const [rollback, info] = decideRollback(rows, active.version, activated);
    if (rollback) {
      await db.deactivate(active.version, `rolled_back: yield dropped (${pyJsonDumps(info, INFO_FLOAT_KEYS)})`);
      const previous = await db.policyBefore(active.version);
      if (previous) {
        const metrics: Json = { ...(pyTruthy(previous.metrics) ? previous.metrics : {}) };
        metrics.activated_at = isoformat(now);
        await db.activate(Math.trunc(Number(previous.version)), metrics, "re-activated after drift rollback");
        return { action: "rolled_back", to_version: previous.version, ...info };
      }
      return { action: "rolled_back_to_fixed_templates", ...info };
    }
  }

  // 2. Learn, test offline on past searches, and only then go live.
  const result = learn(rows, active, now, knownPatterns());
  if (!result.deploy || result.policy === null) return { action: "kept", reason: result.note, ...result.metrics };
  if (activeRow) await db.deactivate(Math.trunc(Number(activeRow.version)), "replaced by a newer version");
  const metrics: Json = { ...result.metrics, activated_at: isoformat(now) };
  const version = await db.insertPolicy(policyToJson(result.policy), metrics, result.note);
  return { action: "deployed", version, ...result.metrics };
}
