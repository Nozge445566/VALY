import type { BrainResult, Identification, Risk } from "../types.ts";
import type { JudgeAReport } from "../judge-a.ts";

export function riskFromFlag(flag: BrainResult["authenticityFlag"]): Risk {
  return flag === "high" ? "high" : flag === "check" ? "medium" : "low";
}
/** Identification with Judge-A's bounded facts filled in ONLY where Identification gave none (never overrides). Pure apart from awaiting. */
export async function identWithJudgeA(ident: Identification | null, jaP: Promise<JudgeAReport | null>): Promise<Identification | null> {
  if (!ident) return ident;
  const hasAnchor = ident.new_price_usd != null && ident.new_price_basis != null && ident.new_price_basis !== "none";
  if (hasAnchor) return ident;
  const ja = await jaP;
  if (!ja || ja.new_price_usd === null || ja.new_price_basis === "none") return ident;
  return { ...ident, new_price_usd: ja.new_price_usd, new_price_basis: ja.new_price_basis, rarity: ident.rarity ?? ja.rarity ?? null, age_class: ident.age_class ?? ja.age_class ?? null, material: ident.material ?? ja.material ?? null } as Identification;
}
