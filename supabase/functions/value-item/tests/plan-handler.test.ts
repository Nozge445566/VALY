import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleRequest } from "../handler.ts";
import { DEFAULT_LIMITS } from "../protection.ts";
import { FAKE_DATA_URL, fakeEngine, fakeStore, json, makeDeps } from "./helpers.ts";
import type { Call } from "./helpers.ts";

type PU = { plan: "free" | "pro" | "premium" | "business"; usedMonth: number; usedDay: number; usedTotal: number; userId: string | null };

function setup(pu: PU, enabled: boolean) {
  const { deps, calls } = makeDeps(() => json({}, 404));
  const store = fakeStore() as ReturnType<typeof fakeStore> & { planAndUsage?: () => Promise<PU> };
  store.planAndUsage = async () => pu;
  const ctx = {
    getConfig: () => (globalThis as { __cfg?: never }).__cfg as never,
    store, deps, limits: DEFAULT_LIMITS, planLimitsEnabled: enabled,
    background: () => undefined, localPlan: fakeEngine({ ok: false, reason: "no_data" }),
  };
  return { ctx, calls, store };
}
const req = () =>
  new Request("https://x.test/v", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: FAKE_DATA_URL, deviceId: "device-0123456789abcdef" }) });
const paid = (calls: Call[]) => calls.filter((c) => c.url.includes("anthropic") || c.url.includes("serper")).length;

describe("plan limits in the handler", () => {
  it("free with 20 used: 429 limit_total, no paid call, no attempt written", async () => {
    const { testConfig } = await import("./helpers.ts");
    const { ctx, calls, store } = setup({ plan: "free", usedMonth: 10, usedDay: 0, usedTotal: 20, userId: "u1" }, true);
    ctx.getConfig = () => testConfig() as never;
    const res = await handleRequest(req(), ctx as never);
    const body = (await res.json()) as { code: string; plan: string };
    assert.equal(res.status, 429);
    assert.equal(body.code, "limit_total");
    assert.equal(paid(calls), 0);
    assert.equal(store.usageCalls.length, 0);
  });
  it("pro with 300 this month: limit_month", async () => {
    const { testConfig } = await import("./helpers.ts");
    const { ctx } = setup({ plan: "pro", usedMonth: 300, usedDay: 5, usedTotal: 300, userId: "u1" }, true);
    ctx.getConfig = () => testConfig() as never;
    const res = await handleRequest(req(), ctx as never);
    assert.equal(((await res.json()) as { code: string }).code, "limit_month");
  });
  it("switch off: the plan is not checked", async () => {
    const { testConfig } = await import("./helpers.ts");
    const { ctx } = setup({ plan: "free", usedMonth: 99, usedDay: 99, usedTotal: 99, userId: null }, false);
    ctx.getConfig = () => testConfig() as never;
    const res = await handleRequest(req(), ctx as never);
    assert.notEqual(((await res.json().catch(() => ({}))) as { code?: string }).code, "limit_total");
  });
});
