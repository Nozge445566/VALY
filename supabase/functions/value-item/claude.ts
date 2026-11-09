// Claude (Anthropic Messages API) client. Used by the Detail eye, Identification and the Judge.
// No web search tool here: live listings come from Market Live (Serper), never from a model.

import { HttpError } from "./types.ts";
import type { BrainConfig, Deps } from "./config.ts";
import { AbortedError, postJson } from "./http.ts";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export type ClaudeBlock = { type: string; [key: string]: unknown };

export interface ClaudeRequest {
  model: string;
  system: string;
  content: ClaudeBlock[];
  maxTokens: number;
  /** Leave out for the 5.5 models: they only accept their default and answer 400 to anything else. */
  temperature?: number;
  /** "disabled" or "adaptive". Haiku 5.5 takes adaptive thinking only (budget_tokens is rejected). Thinking tokens count toward maxTokens (see eyes.ts, judge.ts). */
  thinking?: { type: string };
  /** Optional effort level ("low" | "medium" | "high"), sent as output_config.effort. */
  effort?: string;
  timeoutMs: number;
  /** Extra tries for temporary errors. The Brain uses 0: it has no time to wait. */
  retries?: number;
  /** Cancels the call at once when aborted. */
  signal?: AbortSignal;
}

export interface ClaudeReply {
  text: string;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export function imageBlock(mediaType: string, base64: string): ClaudeBlock {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
}

export function textBlock(text: string): ClaudeBlock {
  return { type: "text", text };
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function textOfReply(data: unknown): string {
  const content = rec(data)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => rec(b))
    .filter((b): b is Record<string, unknown> => b !== null && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Models that refused a temperature setting. Remembered, so the failed first try (a wasted round
 * trip) happens once per model and not on every valuation. Time is tight inside 7 seconds.
 */
const noTemperature = new Set<string>();

/** Models that refused the thinking / effort setting. Remembered like noTemperature: the request is then sent without it. */
const noThinkingControl = new Set<string>();

/** Refusals are remembered per exact setting, not per model: the Judge (adaptive + effort) and the Eyes (disabled) share one model, and one must never switch off the other's control. */
const controlKey = (req: ClaudeRequest): string => `${req.model}|${JSON.stringify(req.thinking ?? null)}|${req.effort ?? ""}`;

function thinkingRefused(e: unknown): boolean {
  return e instanceof HttpError && e.status === 400 && /thinking|effort|output_config|between_tools/i.test(e.body);
}

/** Adds the thinking and effort fields to a request body (nothing if the model refused them before). */
function applyThinking(body: Record<string, unknown>, req: ClaudeRequest): void {
  if (noThinkingControl.has(controlKey(req))) return;
  if (req.thinking) body.thinking = req.thinking;
  if (req.effort) body.output_config = { effort: req.effort };
}

export async function callClaude(deps: Deps, cfg: BrainConfig, req: ClaudeRequest): Promise<ClaudeReply> {
  const headers = { "x-api-key": cfg.anthropicKey, "anthropic-version": API_VERSION };
  let useTemperature = !noTemperature.has(req.model);

  for (let attempt = 0; attempt < 3; attempt++) {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.content }],
    };
    if (useTemperature && req.temperature !== undefined) body.temperature = req.temperature;
    applyThinking(body, req);

    try {
      const data = await postJson(deps, API_URL, headers, body, {
        timeoutMs: req.timeoutMs,
        retries: req.retries ?? 0,
        signal: req.signal,
      });
      const stopReason = typeof rec(data)?.stop_reason === "string" ? (rec(data)?.stop_reason as string) : null;
      if (stopReason === "refusal") throw new Error("the model declined to answer");
      const usage = rec(rec(data)?.usage);
      return {
        text: textOfReply(data),
        stopReason,
        inputTokens: numberOrNull(usage?.input_tokens),
        outputTokens: numberOrNull(usage?.output_tokens),
      };
    } catch (e) {
      // Some models do not accept a temperature setting. Retry once without it.
      if (useTemperature && e instanceof HttpError && e.status === 400 && /temperature/i.test(e.body)) {
        useTemperature = false;
        noTemperature.add(req.model);
        continue;
      }
      // Wrong thinking / effort setting for this model: retry once without it, so a bad setting never costs the answer.
      if ((req.thinking || req.effort) && !noThinkingControl.has(controlKey(req)) && thinkingRefused(e)) {
        noThinkingControl.add(controlKey(req));
        continue;
      }
      throw e;
    }
  }
  throw new Error("the model did not answer");
}

// ---------------------------------------------------------------- streaming (the Judge)

/** What the stream showed about the model's thinking. For diagnosis only (the Scout logs it): nothing decides on it. */
export interface StreamTrace {
  /** ms after the request started until the model began a thinking block (null: it never did). */
  thinkingStartMs: number | null;
  /** How many characters of thinking text the API actually sent. 0 with a started block = the API does not return it. */
  thinkingChars: number;
  /** ms after the request started until the first character of the answer text (null: none arrived). */
  firstTextMs: number | null;
}

export interface StreamReply extends ClaudeReply {
  /** false when the deadline cut the answer off. The text then holds what was written so far. */
  complete: boolean;
  trace?: StreamTrace;
}

/** Reads the server-sent events of a streamed answer. Returns when the stream ends or fails. */
async function readStream(
  res: Response,
  onText: (t: string) => void,
  meta: { stopReason: string | null; outputTokens: number | null; inputTokens: number | null; thinkingStartAt: number | null; thinkingChars: number; firstTextAt: number | null },
  now: () => number,
): Promise<void> {
  if (!res.body) throw new Error("the model sent no stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        let ev: Record<string, unknown> | null = null;
        try {
          ev = rec(JSON.parse(line.slice(5).trim()));
        } catch {
          continue;
        }
        if (!ev) continue;
        if (ev.type === "content_block_delta") {
          const d = rec(ev.delta);
          if (d && d.type === "text_delta" && typeof d.text === "string") {
            if (meta.firstTextAt === null && d.text.length > 0) meta.firstTextAt = now();
            onText(d.text);
          } else if (d && d.type === "thinking_delta" && typeof d.thinking === "string") {
            if (meta.thinkingStartAt === null) meta.thinkingStartAt = now();
            meta.thinkingChars += d.thinking.length;
          }
        } else if (ev.type === "content_block_start") {
          if (rec(ev.content_block)?.type === "thinking" && meta.thinkingStartAt === null) meta.thinkingStartAt = now();
        } else if (ev.type === "message_start") {
          meta.inputTokens = numberOrNull(rec(rec(ev.message)?.usage)?.input_tokens);
        } else if (ev.type === "message_delta") {
          const d = rec(ev.delta);
          if (d && typeof d.stop_reason === "string") meta.stopReason = d.stop_reason;
          meta.outputTokens = numberOrNull(rec(ev.usage)?.output_tokens) ?? meta.outputTokens;
        } else if (ev.type === "error") {
          throw new Error(`the model stopped: ${JSON.stringify(ev.error ?? {}).slice(0, 200)}`);
        }
      }
    }
  }
}

/**
 * Like callClaude, but streamed. The answer is built up as it is written. When `timeoutMs` runs
 * out the call is stopped and what was written so far is returned (complete: false). This is how
 * the Judge can use every millisecond up to the hard limit, and never go past it.
 */
export async function callClaudeStream(deps: Deps, cfg: BrainConfig, req: ClaudeRequest): Promise<StreamReply> {
  const headers = {
    "x-api-key": cfg.anthropicKey,
    "anthropic-version": API_VERSION,
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  let useTemperature = !noTemperature.has(req.model);
  const started = deps.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = req.timeoutMs - (deps.now() - started);
    if (remaining <= 50) throw new Error(`request timed out after ${req.timeoutMs} ms`);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remaining);
    const onOutside = () => controller.abort();
    req.signal?.addEventListener("abort", onOutside, { once: true });

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.content }],
      stream: true,
    };
    if (useTemperature && req.temperature !== undefined) body.temperature = req.temperature;
    applyThinking(body, req);

    let text = "";
    const meta = {
      stopReason: null as string | null, outputTokens: null as number | null, inputTokens: null as number | null,
      thinkingStartAt: null as number | null, thinkingChars: 0, firstTextAt: null as number | null,
    };
    const traceOf = (): StreamTrace => ({
      thinkingStartMs: meta.thinkingStartAt === null ? null : meta.thinkingStartAt - started,
      thinkingChars: meta.thinkingChars,
      firstTextMs: meta.firstTextAt === null ? null : meta.firstTextAt - started,
    });
    try {
      const res = await deps.fetch(API_URL, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok) {
        const errBody = await res.text();
        if (useTemperature && res.status === 400 && /temperature/i.test(errBody)) {
          useTemperature = false;
          noTemperature.add(req.model);
          continue;
        }
        const refused = new HttpError(res.status, errBody);
        if ((req.thinking || req.effort) && !noThinkingControl.has(controlKey(req)) && thinkingRefused(refused)) {
          noThinkingControl.add(controlKey(req));
          continue;
        }
        throw refused;
      }
      await readStream(res, (t) => (text += t), meta, deps.now);
      if (meta.stopReason === "refusal") throw new Error("the model declined to answer");
      return { text, stopReason: meta.stopReason, inputTokens: meta.inputTokens, outputTokens: meta.outputTokens, complete: true, trace: traceOf() };
    } catch (e) {
      if (req.signal?.aborted) throw new AbortedError();
      if (timedOut) {
        // Out of time: hand back what was written. The caller decides if it is enough.
        return { text, stopReason: "deadline", inputTokens: meta.inputTokens, outputTokens: meta.outputTokens, complete: false, trace: traceOf() };
      }
      throw e;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onOutside);
    }
  }
  throw new Error("the model did not answer");
}
