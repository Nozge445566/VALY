import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callClaude } from "../claude.ts";
import { claudeReply, json, makeDeps, testConfig } from "./helpers.ts";

describe("callClaude", () => {
  it("retries once without temperature if the model refuses it, and remembers that", async () => {
    let calls = 0;
    const { deps } = makeDeps(async (call) => {
      calls++;
      if ("temperature" in (call.body ?? {})) return json({ error: { message: "temperature is not supported for this model" } }, 400);
      return claudeReply({ ok: true });
    });
    const req = { model: "model-without-temperature", system: "s", content: [], maxTokens: 10, temperature: 0.2, timeoutMs: 2000 };
    const first = await callClaude(deps, testConfig(), req);
    assert.equal(first.text, '{"ok":true}');
    assert.equal(calls, 2);
    await callClaude(deps, testConfig(), req);
    assert.equal(calls, 3, "the second valuation must not waste a round trip");
  });

  it("sends the thinking setting, and drops it once if the model refuses it", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { deps } = makeDeps(async (call) => {
      bodies.push(call.body ?? {});
      if ("thinking" in (call.body ?? {})) return json({ error: { message: "thinking.type: not supported" } }, 400);
      return claudeReply({ ok: true });
    });
    const req = { model: "model-thinking-test", system: "s", content: [], maxTokens: 10, thinking: { type: "disabled" }, timeoutMs: 2000 };
    const first = await callClaude(deps, testConfig(), req);
    assert.equal(first.text, '{"ok":true}');
    assert.deepEqual(bodies[0].thinking, { type: "disabled" });
    assert.equal("temperature" in bodies[0], false, "no temperature unless asked for");
    assert.equal(bodies.length, 2);
    await callClaude(deps, testConfig(), req);
    assert.equal(bodies.length, 3, "remembered: the next call does not waste a round trip");
  });

  it("remembers a refused thinking setting per setting: the Judge's effort never switches off the Eyes' disabled", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { deps } = makeDeps(async (call) => {
      bodies.push(call.body ?? {});
      if ("output_config" in (call.body ?? {})) return json({ error: { message: "output_config.effort: not supported" } }, 400);
      return claudeReply({ ok: true });
    });
    const base = { model: "shared-haiku", system: "s", content: [], maxTokens: 10, timeoutMs: 2000 };
    await callClaude(deps, testConfig(), { ...base, thinking: { type: "adaptive" }, effort: "high" });
    assert.equal(bodies.length, 2, "refused once, then sent without");
    await callClaude(deps, testConfig(), { ...base, thinking: { type: "disabled" } });
    assert.deepEqual(bodies[2].thinking, { type: "disabled" }, "the Eyes' setting is still sent");
  });

  it("does not retry other errors (there is no time)", async () => {
    let calls = 0;
    const { deps } = makeDeps(async () => {
      calls++;
      return json({ error: "overloaded" }, 529);
    });
    await assert.rejects(callClaude(deps, testConfig(), { model: "m2", system: "s", content: [], maxTokens: 10, temperature: 0, timeoutMs: 2000 }));
    assert.equal(calls, 1);
  });
});
