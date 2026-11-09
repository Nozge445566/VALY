// Supabase Edge Function "explain-item": writes the one paragraph under "How we valued it" (sv: "Så värderade vi"), and checks which ad links are still alive.
//
// Why a function of its own: the valuation answers within 7 seconds and must not wait for a second model call. The app asks for
// the paragraph as soon as the valuation is in hand and keeps it per scan, so it is ready when the person taps.
//
// POST { action: "explain", lang, input: ExplainInput }  ->  { text }          (a failed check retries at most twice; then 502)
// POST { action: "links",   urls: string[] }              ->  { dead: string[] } (only a clear 404/410 counts as dead)
//
// Secrets: ANTHROPIC_API_KEY (required). EXPLAIN_MODEL (optional, default claude-haiku-5-5).

import { loadConfig } from "../value-item/config.ts";
import { callClaude, textBlock } from "../value-item/claude.ts";
import { checkParagraph, systemPrompt, type ExplainInput } from "./prompt.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const MAX_ATTEMPTS = 3; // the first try and at most two more
const MODEL_TIMEOUT_MS = 8000;
const LINK_TIMEOUT_MS = 2500;
const MAX_URLS = 6;

const deps = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  log: (message: string, extra?: unknown) => console.error(`[Explain] ${message}`, extra ?? ""),
};

const str = (v: unknown, max = 80): string | null => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The app's input, read defensively: a wrong shape is a 400, never a guess. Free text is trimmed and bounded. */
function readInput(raw: unknown): ExplainInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const range = Array.isArray(r.intervall) ? r.intervall : [];
  const foremal = str(r.foremal, 120);
  const varde = num(r.varde);
  const lo = num(range[0]);
  const hi = num(range[1]);
  const valuta = str(r.valuta, 8);
  if (!foremal || varde === null || lo === null || hi === null || !valuta) return null;
  const conf = num(r.identifiering_sakerhet);
  return {
    foremal,
    identifiering_sakerhet: conf === null ? null : Math.max(0, Math.min(1, conf)),
    tid_ursprung: str(r.tid_ursprung),
    material: str(r.material),
    skick: str(r.skick),
    marknadsdata_finns: r.marknadsdata_finns === true,
    underlag_for_pris: (Array.isArray(r.underlag_for_pris) ? r.underlag_for_pris : []).map((x) => str(x, 120)).filter((x): x is string => !!x).slice(0, 5),
    varde,
    intervall: [lo, hi],
    valuta,
    hogt_varde_eller_antikt: r.hogt_varde_eller_antikt === true,
  };
}

async function explain(lang: "sv" | "en", input: ExplainInput): Promise<string | null> {
  const cfg = loadConfig((k) => Deno.env.get(k));
  const model = (Deno.env.get("EXPLAIN_MODEL") ?? "").trim() || "claude-haiku-5-5";
  const fmt = (n: number) => new Intl.NumberFormat(lang === "sv" ? "sv-SE" : "en-GB", { maximumFractionDigits: 0 }).format(n);
  const system = systemPrompt(lang, input, fmt);
  // Null fields are left out of the input: missing fields must not be mentioned in the text.
  const payload = JSON.stringify(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null)));
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await callClaude(deps, cfg, {
        model,
        system,
        content: [textBlock(payload)],
        maxTokens: 400,
        thinking: { type: "disabled" },
        timeoutMs: MODEL_TIMEOUT_MS,
        retries: 0,
      });
      const text = reply.text.trim();
      const errors = checkParagraph(text, input);
      if (errors.length === 0) return text;
      deps.log("paragraph rejected", errors);
    } catch (e) {
      deps.log("model call failed", e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

/** Only http(s) links to public hosts are ever contacted, and only a clear "gone" (404/410) counts as dead: many shops answer bots with 403. */
async function deadLinks(urls: string[]): Promise<string[]> {
  const dead: string[] = [];
  await Promise.all(
    urls.map(async (u) => {
      let url: URL;
      try {
        url = new URL(u);
      } catch {
        return;
      }
      if (!/^https?:$/.test(url.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname)) return;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), LINK_TIMEOUT_MS);
      try {
        const res = await fetch(url, { method: "GET", redirect: "follow", signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 (compatible; ValyLinkCheck/1.0)", range: "bytes=0-0" } });
        if (res.status === 404 || res.status === 410) dead.push(u);
      } catch {
        // unreachable or slow: unknown, not dead
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return dead;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  if (body.action === "links") {
    const urls = (Array.isArray(body.urls) ? body.urls : []).filter((u): u is string => typeof u === "string").slice(0, MAX_URLS);
    return json(200, { dead: await deadLinks(urls) });
  }
  if (body.action === "explain") {
    const input = readInput(body.input);
    if (!input) return json(400, { error: "invalid input" });
    const text = await explain(body.lang === "en" ? "en" : "sv", input);
    return text ? json(200, { text }) : json(502, { error: "no paragraph" });
  }
  return json(400, { error: "unknown action" });
});
