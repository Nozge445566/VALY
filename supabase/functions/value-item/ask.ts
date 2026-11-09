// "Ask once, parse, check": the guard around every model step. There is no time for a second
// try inside 7 seconds, so an invalid answer fails the step and the pipeline degrades instead.

import { StepError } from "./types.ts";
import { extractJsonObjects } from "./json.ts";
import type { Validation } from "./validate.ts";

export async function askOnce<T>(opts: {
  step: string;
  ask: () => Promise<string>;
  validate: (raw: unknown) => Validation<T>;
}): Promise<T> {
  const text = await opts.ask();
  const objects = extractJsonObjects(text);
  let errors: string[] = ["no JSON object found in the answer"];
  for (let i = objects.length - 1; i >= 0; i--) {
    const v = opts.validate(objects[i]);
    if (v.ok) return v.value;
    if (i === objects.length - 1) errors = v.errors;
  }
  throw new StepError(opts.step, "answer failed validation", errors);
}
