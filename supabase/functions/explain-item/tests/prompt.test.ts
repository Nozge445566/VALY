import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkParagraph, systemPrompt, wordCount, type ExplainInput } from "../prompt.ts";

const input: ExplainInput = {
  foremal: "Empirestol",
  identifiering_sakerhet: 0.9,
  tid_ursprung: "Sverige, troligen 1820-talet",
  material: "mahogny",
  skick: null,
  marknadsdata_finns: false,
  underlag_for_pris: ["auktionsresultat för liknande antikviteter (få)"],
  varde: 4500,
  intervall: [3500, 6000],
  valuta: "kr",
  hogt_varde_eller_antikt: true,
};

// 58 words, 3 sentences.
const GOOD =
  "Det här är en svensk stol i empirestil, troligen från 1820-talet och tillverkad i mahogny. Vi känner igen formen och byggsättet, men det finns få nyligen sålda liknande stolar att jämföra med, så priset bygger mest på vad liknande antikviteter brukar uppnå på auktion. Vi tror att den ligger runt 4 500 kr, men en expert kan säga mer om äkthet och skick.";

describe("explain-item/prompt.ts", () => {
  it("accepts a good paragraph", () => {
    const n = wordCount(GOOD);
    assert.ok(n >= 45 && n <= 75, `words: ${n}`);
    assert.deepEqual(checkParagraph(GOOD, input), []);
  });

  it("rejects a number that is not in the input", () => {
    const bad = GOOD.replace("4 500", "5 200");
    assert.ok(checkParagraph(bad, input).some((e) => e.startsWith("unknown number")));
  });

  it("accepts the value written with or without separators, and the range ends", () => {
    assert.deepEqual(checkParagraph(GOOD.replace("4 500", "4500"), input), []);
    assert.deepEqual(checkParagraph(GOOD.replace("4 500 kr", "4\u00a0500 kr, någonstans mellan 3 500 och 6 000 kr"), input).filter((e) => e.startsWith("unknown")), []);
  });

  it("rejects the wrong length, lists, several paragraphs, exclamation marks, emoji and quotes", () => {
    assert.ok(checkParagraph("För kort.", input).length > 0);
    assert.ok(checkParagraph(GOOD + "\n\n" + GOOD, input).length > 0);
    assert.ok(checkParagraph("- " + GOOD, input).some((e) => e.includes("single plain paragraph")));
    assert.ok(checkParagraph(GOOD.replace("skick.", "skick!"), input).includes("exclamation mark"));
    assert.ok(checkParagraph(GOOD + " ✨", input).includes("emoji"));
    assert.ok(checkParagraph(`"${GOOD}"`, input).includes("quotes around the text"));
  });

  it("the prompt carries the exact numbers and the language", () => {
    const p = systemPrompt("sv", input, (n) => String(n));
    assert.ok(p.includes("4500") && p.includes("3500") && p.includes("6000") && p.includes("svenska"));
    assert.ok(systemPrompt("en", input, (n) => String(n)).includes("engelska"));
  });
});
