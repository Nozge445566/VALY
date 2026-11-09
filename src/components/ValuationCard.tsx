import type { ValuationResult } from "@/lib/valuation";
import { detectCurrency } from "@/lib/currency";
import { currentLang, uiLocale } from "@/lib/i18n";
import { TEXTS } from "@/lib/texts";
import { useEffect, useRef, useState } from "react";
import { InsightDialog } from "@/components/InsightDialog";
import { MarketRows } from "@/components/MarketRows";
import { useInsight } from "@/lib/useInsight";
import { Info } from "lucide-react";

interface Props {
  image: string | null;
  result: ValuationResult;
  onScanAgain: () => void;
  /** Today's valuations left. null until the counter should show (it starts at the second result). */
  quota?: { left: number; max: number; month?: boolean; total?: boolean } | null;
}

/** Splits an amount into number and currency, so the number can be big and the currency small and light. */
function moneyParts(n: number, code: string): { lead: string; num: string; trail: string } {
  try {
    const parts = new Intl.NumberFormat(uiLocale(), {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).formatToParts(n);
    let lead = "";
    let num = "";
    let trail = "";
    for (const part of parts) {
      if (part.type === "currency") {
        if (num === "") lead += part.value;
        else trail += part.value;
      } else if (["integer", "group", "decimal", "fraction", "minusSign", "plusSign"].includes(part.type)) {
        num += part.value;
      }
      // spaces ("literal") are left out: the layout adds its own spacing
    }
    return { lead: lead.trim(), num, trail: trail.trim() };
  } catch {
    return { lead: "", num: String(Math.round(n)), trail: code };
  }
}

export function ValuationCard({ image: _image, result, onScanAgain, quota }: Props) {
  const code = result.currency ?? detectCurrency().code;
  const mid = moneyParts(result.mid, code);
  const low = moneyParts(result.low, code);
  const high = moneyParts(result.high, code);

  // The number counts up from the low end to the middle value (as in the design).
  const [shown, setShown] = useState(() => result.low);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(result.mid);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const D = 1800;
    const step = (now: number) => {
      if (start === null) start = now;
      const p = Math.min(Math.max((now - start) / D, 0), 1);
      const e = 1 - Math.pow(1 - p, 4);
      setShown(Math.round(result.low + (result.mid - result.low) * e));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    setShown(result.low);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [result.low, result.mid]);
  const shownNum = moneyParts(shown, code).num;

  // The one small link above the button: "Se marknadsdata" or "Se hur vi värderade" (never both), and the box it opens.
  const insight = useInsight(result);
  const [open, setOpen] = useState(false);
  const shownAt = useRef(performance.now());
  useEffect(() => {
    if (!insight) setOpen(false); // e.g. the connection dropped while the box was open
  }, [insight]);
  // Fades in last, about 1.6 s after the result appeared, like the other elements; later if its content was not ready yet.
  const linkDelay = Math.max(0, 1600 - (performance.now() - shownAt.current));

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div className="vaur" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>

      {quota && (
        <div className="absolute right-[5cqw] top-[max(env(safe-area-inset-top),1.25rem)] z-10">
          <QuotaMeter left={quota.left} max={quota.max} />
        </div>
      )}

      {/* The value */}
      <div className="absolute inset-x-0 top-[33cqw] flex items-baseline justify-center px-[8cqw] font-display" style={{ fontFeatureSettings: '"tnum" 1' }}>
        {mid.lead && <span className="mr-1 text-[22px] text-mist">{mid.lead}</span>}
        <span
          className="whitespace-nowrap font-medium leading-none"
          style={{
            fontSize: "36.5cqw",
            letterSpacing: "-0.07em",
            background: "linear-gradient(#fffaf0 20%,#cfc3a6)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            padding: "0 6px 8px 0",
          }}
        >
          {shownNum}
        </span>
        {mid.trail && <span className="ml-1 text-[22px] tracking-[-0.02em] text-mist">{mid.trail}</span>}
      </div>

      {/* The range */}
      <div className="absolute inset-x-[8cqw] top-1/2 -mt-[7px] font-display">
        <div className="vln">
          <div className="vcore" />
          <div className="vtk" style={{ left: 0 }} />
          <div className="vtk" style={{ right: 0 }} />
          <div className="vgl" />
        </div>
        <div className="vends">
          <span style={{ left: "0.5px", transform: "translateX(-50%)" }}>{low.num}</span>
          <span style={{ right: "0.5px", transform: "translateX(50%)" }}>{high.num}</span>
        </div>
      </div>

      {/* Extras: kept below the range so the design stays clean */}
      {(result.needsMoreInfo || (quota && quota.left <= 0)) && (
        <div className={`absolute inset-x-[5cqw] ${insight ? "bottom-[calc(28px+56px+20px+30px)]" : "bottom-[calc(28px+56px+14px)]"} top-[calc(50%+54px)] space-y-3 overflow-y-auto no-scrollbar`}>
          {result.needsMoreInfo && (
            <div className="flex gap-2.5 rounded-2xl border border-[var(--rule)] bg-cream/[0.06] px-4 py-3 text-sm text-cream">
              <Info size={18} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">{TEXTS.betterPhoto}</p>
                <p className="mt-0.5 text-mist">{result.needsMoreInfo}</p>
              </div>
            </div>
          )}
          {quota && quota.left <= 0 && (
            <div className="rounded-2xl border border-[var(--rule)] bg-cream/[0.06] px-4 py-3 text-sm leading-relaxed text-cream">
              {quota.total ? TEXTS.quota.doneNoteTotal : quota.month ? TEXTS.quota.doneNoteMonth : TEXTS.quota.doneNote}
            </div>
          )}
          <p className="pb-1 text-center text-[0.75rem] text-dusk">{TEXTS.guidanceOnly}</p>
        </div>
      )}

      {insight && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(28px+56px+14px)] flex justify-center">
          <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="vlink pointer-events-auto" style={{ animationDelay: `${Math.round(linkDelay)}ms` }}>
            {insight.kind === "market" ? TEXTS.insight.seeMarket : TEXTS.insight.seeHow}
          </button>
        </div>
      )}

      <button type="button" onClick={onScanAgain} className="vnext btn-cream absolute inset-x-[8cqw] bottom-[28px] !w-auto font-display">
        {TEXTS.nextItem}
      </button>

      {open && insight && (
        <InsightDialog
          title={insight.kind === "market" ? TEXTS.insight.marketTitle : TEXTS.insight.howTitle}
          subtitle={result.itemName}
          onClose={() => setOpen(false)}
        >
          {insight.kind === "market" ? (
            <MarketRows rows={insight.rows} />
          ) : (
            <p className="mt-4 pt-4 text-[15px] text-cream" style={{ lineHeight: 1.6, borderTop: "1px solid rgba(245,237,220,.10)" }}>
              {insight.text}
            </p>
          )}
        </InsightDialog>
      )}
    </div>
  );
}

/** Daily allowance, top right of the value box: "14 av 15", "13 av 15" ... */
function QuotaMeter({ left, max }: { left: number; max: number }) {
  const of = currentLang() === "sv" ? "av" : "of";
  return (
    <span className="rounded-full bg-cream/[0.08] px-4 py-2 text-base font-medium tabular-nums tracking-wide text-cream">
      {left} {of} {max}
    </span>
  );
}
