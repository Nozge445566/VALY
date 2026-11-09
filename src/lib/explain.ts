// Talks to the "explain-item" function: the written "Så värderade vi" paragraph and the check for dead ad links.
// Both are best effort. A failure is never an error banner: the link simply does not show (explanation) or the row stays (links).

import { currentLang, uiLocale } from "./i18n.ts";
import { buildExplainInput, type ExplainSource } from "./marketData.ts";

const FUNCTION_NAME = "explain-item";
const EXPLAIN_TIMEOUT_MS = 20_000;
const LINKS_TIMEOUT_MS = 4_000;

async function call(body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const baseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!baseUrl || !anonKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/functions/v1/${FUNCTION_NAME}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One paragraph for this scan, or null when it could not be written (the link is then hidden). */
export async function fetchExplanation(source: ExplainSource): Promise<string | null> {
  const data = await call({ action: "explain", lang: currentLang(), input: buildExplainInput(source, uiLocale()) }, EXPLAIN_TIMEOUT_MS);
  const text = data?.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/** The links that are gone for sure (404/410). Anything unknown counts as alive. */
export async function fetchDeadLinks(urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const data = await call({ action: "links", urls }, LINKS_TIMEOUT_MS);
  const dead = Array.isArray(data?.dead) ? (data.dead as unknown[]).filter((u): u is string => typeof u === "string" && urls.includes(u)) : [];
  return new Set(dead);
}
