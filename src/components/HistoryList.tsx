import type { ValuationRow } from "@/lib/supabase";
import { detectCurrency, formatMoney } from "@/lib/currency";
import { uiLocale } from "@/lib/i18n";
import { historyBasisChip, historyCountryTag } from "@/lib/market";
import { TEXTS } from "@/lib/texts";
import { History, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

interface Props {
  rows: ValuationRow[];
  onDelete: (id: string) => void;
  loading: boolean;
}

export function HistoryList({ rows, onDelete, loading }: Props) {
  // One card open at a time: opening another closes the previous one.
  const [openId, setOpenId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // If the open card disappears (deleted, cleared), forget it.
  useEffect(() => {
    if (openId && !rows.some((r) => r.id === openId)) setOpenId(null);
  }, [rows, openId]);

  const toggle = (id: string) => {
    const opening = openId !== id;
    setOpenId(opening ? id : null);
    if (opening) {
      // Once the panel has opened, make sure it is fully in view (never jumps if it already is).
      window.setTimeout(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
        const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el?.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
      }, 300);
    }
  };

  // Closing with the X: the panel hides, so focus goes back to the row it belongs to.
  const closeFromPanel = (id: string) => {
    setOpenId(null);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"] button[aria-controls]`)
      ?.focus();
  };

  if (loading && rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-mist text-sm">
        {TEXTS.history.loading}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-dusk">
        <History size={28} className="mb-2" />
        <p className="text-sm">{TEXTS.history.empty}</p>
      </div>
    );
  }

  const device = detectCurrency();
  return (
    <ul ref={listRef} className="m-0 list-none p-0">
      {rows.map((row, idx) => {
        // Each row is shown in the currency it was made in (old rows have none: the device's, as before), and
        // with the country it was made for when that is not the device's own country.
        const cur = row.currency ?? undefined;
        const mid = splitMoney(Number(row.estimated_value_mid), cur);
        const lowN = splitMoney(Number(row.estimated_value_low), cur).num;
        const highN = splitMoney(Number(row.estimated_value_high), cur).num;
        const countryTag = historyCountryTag(row.market_country, device.country);
        const basisChip = historyBasisChip(row.market_basis, row.market_adjusted);
        const open = openId === row.id;
        const panelId = `history-name-${row.id}`;
        const date = new Date(row.created_at)
          .toLocaleDateString(uiLocale(), { day: "numeric", month: "short" })
          .replace(/\.$/, "");
        return (
          <li
            key={row.id}
            data-row={row.id}
            style={{ "--d": `${(0.15 + Math.min(idx, 12) * 0.07).toFixed(2)}s` } as CSSProperties}
            onKeyDown={(e) => {
              if (e.key === "Escape" && open) {
                e.stopPropagation();
                closeFromPanel(row.id);
              }
            }}
            className="vcard mb-[5px] w-[70%] min-w-[218px] rounded-[11px] bg-cream text-[#05070f]"
          >
            <button
              type="button"
              onClick={() => toggle(row.id)}
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={`${row.item_name}. ${open ? TEXTS.history.hideName : TEXTS.history.showName}`}
              className="flex w-full items-center gap-[9px] py-[5px] pl-[5px] pr-[13px] text-left"
            >
              <div
                className="h-7 w-7 shrink-0 overflow-hidden rounded-[7px]"
                style={{ background: "radial-gradient(120% 120% at 30% 0,#2c3a78 0,#0e1636 70%)" }}
              >
                {row.image_data_url && <img src={row.image_data_url} alt="" className="h-full w-full object-cover" />}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <div className="flex items-baseline justify-between gap-[6px] whitespace-nowrap">
                  <b className="overflow-hidden text-ellipsis text-[11.5px] font-normal leading-[15px]">{row.item_name}</b>
                  <em className="text-[14.5px] font-semibold not-italic leading-[15px] tracking-[-0.02em]">
                    {mid.num}
                    <small className="ml-[2px] text-[9.5px] font-medium tracking-[0.02em]">{mid.cur}</small>
                  </em>
                </div>
                <div className="flex items-baseline justify-between gap-[6px] whitespace-nowrap text-[10px] font-medium leading-[11px] tracking-[0.01em]">
                  <span>
                    {lowN}–{highN}
                  </span>
                  <i className="not-italic">
                    {countryTag ? `${countryTag} · ` : ""}
                    {basisChip ? `${basisChip.label} · ` : ""}
                    {date}
                  </i>
                </div>
              </div>
            </button>

            {/* Opens inside the same card: the whole name, and delete */}
            <div id={panelId} className="reveal" data-open={open} aria-hidden={!open}>
              <div>
                <div className="reveal-body mx-[13px] mb-[8px] border-t border-[#0b1229]/15 pt-[7px]">
                  <p
                    className="select-text break-words text-[12px] font-medium leading-snug"
                    style={{ textWrap: "pretty", hyphens: "auto" } as CSSProperties}
                  >
                    {row.item_name}
                  </p>
                  <div className="mt-[6px] flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => onDelete(row.id)}
                      tabIndex={open ? 0 : -1}
                      className="inline-flex items-center gap-1 text-[10.5px] font-medium text-[#0b1229]/65"
                    >
                      <Trash2 size={12} /> {TEXTS.history.delete}
                    </button>
                    <button
                      type="button"
                      onClick={() => closeFromPanel(row.id)}
                      tabIndex={open ? 0 : -1}
                      aria-label={TEXTS.history.close}
                      className="grid h-5 w-5 place-items-center rounded-full text-[#0b1229]/65"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** "1 200" and "kr" apart, so the currency can be small. */
function splitMoney(n: number, code: string | undefined): { num: string; cur: string } {
  try {
    const parts = new Intl.NumberFormat(uiLocale(), {
      style: "currency",
      currency: code ?? detectCurrency().code,
      maximumFractionDigits: 0,
    }).formatToParts(n);
    let num = "";
    let cur = "";
    for (const p of parts) {
      if (p.type === "currency") cur += p.value;
      else if (["integer", "group", "decimal", "fraction", "minusSign", "plusSign"].includes(p.type)) num += p.value;
    }
    return { num, cur: cur.trim() };
  } catch {
    return { num: formatMoney(n, code), cur: "" };
  }
}
