// Where the user's country comes from: the app's `country`, else the region of `locale`, else the
// Cloudflare header, else unknown (null, which the Brain treats as "ZZ": everything is local).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { headerCountry, parseRequest } from "../handler.ts";

// A PNG signature followed by padding: long enough and well-formed for parseDataUrl.
const IMG = "data:image/png;base64," + "iVBORw0KGgo" + "A".repeat(200);
const country = (body: Record<string, unknown>, fallback: string | null) => {
  const r = parseRequest({ image: IMG, ...body }, fallback);
  assert.ok("req" in r, JSON.stringify(r));
  return r.req.input.country;
};
const hdr = (v?: string) => new Request("https://x.test", { headers: v === undefined ? {} : { "cf-ipcountry": v } });

describe("request country chain", () => {
  it("the app's own country wins over the header", () => {
    assert.equal(country({ country: "se" }, "DE"), "SE");
  });
  it("without it, the region of the locale", () => {
    assert.equal(country({ locale: "sv-SE" }, "DE"), "SE");
    assert.equal(country({ locale: "pt-BR" }, null), "BR");
  });
  it("without either, the Cloudflare header", () => {
    assert.equal(country({}, "DE"), "DE");
    assert.equal(country({ country: "Sweden", locale: "sv" }, "DE"), "DE", "a malformed country is ignored");
  });
  it("with nothing at all it stays unknown (null)", () => {
    assert.equal(country({}, null), null);
  });
  it("headerCountry: only real codes; XX (unknown) and T1 (Tor) are not countries", () => {
    assert.equal(headerCountry(hdr("se")), "SE");
    for (const v of ["XX", "T1", "", "SWE", undefined]) assert.equal(headerCountry(hdr(v)), null);
  });
});
