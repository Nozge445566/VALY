// The Brain, arrow by arrow.
//
//   0 to 1.5 s   Eyes:   Detail eye + Identification run in parallel on the photo.
//                        Detail eye -> Judge, and (with the Authenticity eye) the mandatory eye-evidence search.  Identification -> Memory only.
//   Memory       The Detail eye is never skipped: Memory looks up the item while the Detail eye finishes, and then
//                compares what the Detail eye sees now with what was stored (memory.ts, memoryGate).
//                HIT   (same item, same condition)  -> Check and exchange rates (Market Live and the Judge are skipped).
//                JUDGE (condition one grade away)   -> the Judge re-values the SAVED listings against this photo,
//                                                      with the Detail eye's report. No new search.
//                MISS  (anything else)              -> Market Live <-> Search AI.
//   1.5 to 6.5 s Brain:  Market Live -> Judge (the photo goes to the Judge directly as well).
//   Judge        -> Check and exchange rates (code) -> Answer at 7 s, hard limit.
//   Answer       -> Saved in Supabase (new valuations only; the handler does that).
//
// Protection (per-device rate limits, see protection.ts) sits in the handler, before any paid call.

export * from "./pipeline/eye-search.ts";
export * from "./pipeline/timing.ts";
export * from "./pipeline/assemble.ts";
export * from "./pipeline/logs.ts";
export * from "./pipeline/options.ts";
export * from "./pipeline/run.ts";
