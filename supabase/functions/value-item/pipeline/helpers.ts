import type { BrainResult, Risk } from "../types.ts";

export function riskFromFlag(flag: BrainResult["authenticityFlag"]): Risk {
  return flag === "high" ? "high" : flag === "check" ? "medium" : "low";
}
