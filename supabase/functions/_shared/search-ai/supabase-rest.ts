// database access over REST. `fetchImpl` is INJECTED (tests use a fake).
// Same endpoints, same query strings, same error text. SERVICE ROLE key: never in the browser or app code.

import type { Json, SearchDb } from "./nightly.ts";
import type { Row } from "./learner.ts";

export class SupabaseError extends Error {}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class SupabaseRest implements SearchDb {
  base: string;
  key: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
  constructor(url: string, serviceKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutSeconds = 20.0) {
    this.base = url.replace(/\/+$/, "") + "/rest/v1";
    this.key = serviceKey;
    this.timeoutMs = timeoutSeconds * 1000;
    this.fetchImpl = fetchImpl;
  }

  async request(method: string, path: string, body: unknown = null, headers: Record<string, string> = {}): Promise<any> {
    const h: Record<string, string> = { apikey: this.key, Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", ...headers };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    let text: string;
    try {
      res = await this.fetchImpl(this.base + path, { method, headers: h, body: body !== null ? JSON.stringify(body) : undefined, signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      throw new SupabaseError(`${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new SupabaseError(`${method} ${path} -> ${res.status}: ${Array.from(text).slice(0, 300).join("")}`);
    return text ? JSON.parse(text) : null;
  }

  async fetchLogs(sinceIso: string, page = 1000, maxRows = 200_000): Promise<Row[]> {
    const rows: Row[] = [];
    let offset = 0;
    while (offset < maxRows) {
      const q = new URLSearchParams({ created_at: `gte.${sinceIso}`, order: "created_at.asc,id.asc", limit: String(page), offset: String(offset) }).toString();
      const got: Row[] = await this.request("GET", `/l_search_log?${q}`);
      rows.push(...got);
      if (got.length < page) break;
      offset += page;
    }
    return rows;
  }

  async activePolicy(): Promise<Json | null> {
    const got = await this.request("GET", "/l_search_policy?active=is.true&limit=1");
    return got && got.length ? got[0] : null;
  }

  async policyBefore(version: number): Promise<Json | null> {
    const got = await this.request("GET", `/l_search_policy?version=lt.${version}&order=version.desc&limit=1`);
    return got && got.length ? got[0] : null;
  }

  async deactivate(version: number, note: string): Promise<void> {
    await this.request("PATCH", `/l_search_policy?version=eq.${version}`, { active: false, note });
  }

  async activate(version: number, metrics: Json, note: string): Promise<void> {
    await this.request("PATCH", `/l_search_policy?version=eq.${version}`, { active: true, metrics, note });
  }

  async insertPolicy(policy: Json, metrics: Json, note: string): Promise<number> {
    const got = await this.request("POST", "/l_search_policy", { policy, metrics, note, active: true }, { Prefer: "return=representation" });
    return Math.trunc(Number(got[0].version));
  }
}
