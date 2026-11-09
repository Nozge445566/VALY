// State behind the link on the result page: which link (never both), whether it can show, and its content.

import { useEffect, useState } from "react";
import type { ValuationResult } from "./valuation";
import { insightKind, marketRows, type InsightKind, type MarketRow } from "./marketData.ts";
import { fetchDeadLinks, fetchExplanation } from "./explain.ts";
import { formatMoney } from "./currency";
import { TEXTS } from "./texts.ts";

/** One paragraph per scan: asked for once when the valuation is in hand, kept for as long as the result is on screen or reused. */
const explanations = new WeakMap<ValuationResult, Promise<string | null>>();

function explanationFor(r: ValuationResult): Promise<string | null> {
  let p = explanations.get(r);
  if (!p) {
    p = fetchExplanation({
      itemName: r.itemName,
      currency: r.currency,
      low: r.low,
      mid: r.mid,
      high: r.high,
      conditionLabel: TEXTS.conditions[r.detectedCondition] ?? null,
      comparableCount: r.comparables.length,
      explain: r.explain,
    });
    explanations.set(r, p);
  }
  return p;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export type Insight =
  | { kind: "market"; rows: MarketRow[] }
  | { kind: "explain"; text: string }
  | null;

/** null = no link (offline, or the paragraph is not ready or could not be written). Exactly one kind otherwise. */
export function useInsight(result: ValuationResult): Insight {
  const online = useOnline();
  const kind: InsightKind = insightKind(result);
  const [dead, setDead] = useState<ReadonlySet<string>>(() => new Set());
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDead(new Set());
    setText(null);
    if (!online) return;
    if (kind === "market") {
      void fetchDeadLinks(result.marketAds.map((a) => a.url)).then((d) => live && setDead(d));
    } else {
      void explanationFor(result).then((t) => live && setText(t));
    }
    return () => {
      live = false;
    };
  }, [result, kind, online]);

  if (!online) return null;
  if (kind === "market") {
    return { kind, rows: marketRows(result.marketAds, result.itemName, { dead, formatPrice: (n) => formatMoney(n, result.currency) }) };
  }
  return text ? { kind, text } : null;
}
