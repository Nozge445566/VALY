// Usage: node --experimental-strip-types scripts/backtest.ts runs.jsonl [--sim N]
// runs.jsonl: one JSON per line {"stored": <l_runs.steps.interval>, "truthUsd": <l_feedback sold price>}.
// Prints coverage / median abs ln error / pinball / conformal k. Nothing is written anywhere.
import { readFileSync } from "node:fs";
import { conformalK, score, simulate } from "../backtest.ts";
const args = process.argv.slice(2);
const simAt = args.indexOf("--sim");
const recs = simAt >= 0 ? simulate({ runs: Number(args[simAt + 1]) || 300 }) : readFileSync(args[0], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log(JSON.stringify({ score: score(recs), conformalK80: conformalK(recs, 0.8) }, null, 2));
