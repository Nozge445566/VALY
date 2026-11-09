// Pulls JSON objects out of model text. Models sometimes add a sentence before or after
// the JSON, or wrap it in a markdown fence. We never trust that: we scan for balanced
// {...} blocks and try to parse each one.

function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** All top-level JSON objects found in the text, in order. */
export function extractJsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    const end = findBalancedEnd(text, start);
    if (end === -1) {
      i = start + 1;
      continue;
    }
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        out.push(value as Record<string, unknown>);
        i = end + 1;
        continue;
      }
    } catch {
      // not valid JSON; look at nested candidates instead
    }
    i = start + 1;
  }
  return out;
}

/** The finished top-level fields of an object that has no closing brace, closed again. */
function closeAtLastField(text: string, start: number): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastCut = -1; // position of the last top-level comma: everything before it is finished
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      // A nested value (like the price object) that has just closed is finished even if its comma has not arrived yet.
      if (depth === 1) lastCut = i + 1;
    } else if (ch === "," && depth === 1) lastCut = i;
  }
  if (lastCut === -1) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, lastCut) + "}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Reads an object that may have been cut off in the middle (the time ran out while the model was
 * still writing). A finished object wins. Otherwise we cut back to the last finished top-level
 * field and close the object, so everything the model had finished writing is kept and nothing
 * half-written is. (Objects nested inside an unfinished outer object are NOT the answer.)
 */
export function parseTruncatedObject(text: string): Record<string, unknown> | null {
  let lastComplete: Record<string, unknown> | null = null;
  let i = 0;
  for (;;) {
    const start = text.indexOf("{", i);
    if (start === -1) return lastComplete;
    const end = findBalancedEnd(text, start);
    if (end === -1) return lastComplete ?? closeAtLastField(text, start);
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (typeof value === "object" && value !== null && !Array.isArray(value)) lastComplete = value as Record<string, unknown>;
    } catch {
      // not valid JSON: ignore this block
    }
    i = end + 1;
  }
}
