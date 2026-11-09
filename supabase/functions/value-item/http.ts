// One place for all outgoing HTTP calls: timeout, retry on temporary errors, clear errors,
// and an optional outside signal so a caller can cancel a call (the stopper does this).

import { HttpError } from "./types.ts";
import type { Deps } from "./config.ts";

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

export interface PostOptions {
  timeoutMs: number;
  /** Extra tries after the first one, for temporary errors only. */
  retries: number;
  /** When this signal aborts, the call stops at once and is never retried. */
  signal?: AbortSignal;
}

export class AbortedError extends Error {
  constructor() {
    super("request was cancelled");
    this.name = "AbortedError";
  }
}

async function send(
  deps: Deps,
  url: string,
  init: RequestInit,
  opts: PostOptions,
): Promise<{ status: number; text: string; ok: boolean }> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (opts.signal?.aborted) throw new AbortedError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const onOutsideAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onOutsideAbort, { once: true });
    try {
      const res = await deps.fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      if (res.ok) return { status: res.status, text, ok: true };
      const err = new HttpError(res.status, text);
      if (!RETRY_STATUS.has(res.status) || attempt === opts.retries) throw err;
      lastError = err;
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 10
        ? retryAfter * 1000
        : 400 * 2 ** attempt;
      await deps.sleep(wait);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (opts.signal?.aborted) throw new AbortedError();
      const aborted = e instanceof Error && e.name === "AbortError";
      if (aborted) throw new Error(`request timed out after ${opts.timeoutMs} ms`);
      lastError = e;
      if (attempt === opts.retries) throw e;
      await deps.sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOutsideAbort);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("request failed");
}

export async function postJson(
  deps: Deps,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: PostOptions,
): Promise<unknown> {
  const got = await send(
    deps,
    url,
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
    opts,
  );
  try {
    return JSON.parse(got.text) as unknown;
  } catch {
    throw new HttpError(got.status, `response was not JSON: ${got.text.slice(0, 200)}`);
  }
}
