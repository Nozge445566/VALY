// Judge prompt tests. (The unused learned-level hint, levelHintsOf, was removed in v5.1: dead code since the Judge
// stopped receiving usd_in_target_market. The interval engine still applies the learned shifts itself.)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeSystemPrompt, judgeUserText } from "../judge-prompt.ts";
import { offsetTable } from "../../_shared/offsets.ts";
import type { OffsetRow } from "../../_shared/offsets.ts";
import type { Finding } from "../types.ts";
import { SAMPLE_DETAILS } from "./helpers.ts";

const f = (id: number, priceUsd: number, origin: string, tier: "local" | "regional" | "global"): Finding => ({
  id, searchId: "s1", title: `Item ${id}`, snippet: "", url: `https://x.test/${id}`, site: "x.test", kind: "sold",
  price: priceUsd, currency: "USD", priceUsd, gl: origin.toLowerCase(), origin, tier,
});

const row = (over: Partial<OffsetRow> = {}): OffsetRow => ({ origin: "US", user_country: "SE", offset_ln: -0.2, extra_std: 0.2, n: 45, baseline_ln: 0, ...over });
const table = offsetTable([row()]);
const findings = [f(1, 100, "SE", "local"), f(2, 100, "US", "global"), f(3, 100, "DE", "regional")];

describe("Judge prompt (labels only)", () => {
  const stats = { findingCount: 3, soldCount: 3, soldTarget: 5, stopReason: "done" };
  it("asks for labels and forbids prices and confidence", () => {
    const p = judgeSystemPrompt({ country: "SE", lang: "en" } as never, stats, null);
    assert.match(p, /You are the Judge/);
    assert.match(p, /relative_value/);
    assert.match(p, /Never write a price/);
    assert.doesNotMatch(p, /"price":/);
    assert.doesNotMatch(p, /"confidence":/);
  });
  it("shows both eyes and the ads to the Judge", () => {
    const t = judgeUserText(SAMPLE_DETAILS, findings, false, { signs: [], era: "1970s", risk_hint: "low", search_terms: [] });
    assert.match(t, /EYE 1, DETAIL EYE/);
    assert.match(t, /EYE 3, AUTHENTICITY EYE/);
    assert.match(t, /1970s/);
    assert.doesNotMatch(t, /usd_in_target_market/);
  });
});
