import { ArrowUpRight } from "lucide-react";
import { rowSubline, rowTitle, type MarketRow } from "@/lib/marketData";
import { TEXTS } from "@/lib/texts";

/** Up to three rows, each a link out to the ad (or the site's search). Image only when the source allows it: never an empty box. */
export function MarketRows({ rows }: { rows: MarketRow[] }) {
  return (
    <ul className="mt-4 list-none p-0">
      {rows.map((row, i) => {
        const sub = rowSubline(row) ?? (row.kind === "search" ? TEXTS.insight.searchItem : null);
        return (
          <li key={row.href} style={i > 0 ? { borderTop: "1px solid rgba(245,237,220,.10)" } : undefined}>
            <a
              href={row.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${rowTitle(row)}, ${TEXTS.insight.opensAtSource}`}
              className="flex items-center gap-3 py-3 text-cream transition hover:opacity-80"
            >
              {row.image && <img src={row.image} alt="" width={56} height={56} loading="lazy" referrerPolicy="no-referrer" className="h-14 w-14 shrink-0 object-cover" style={{ borderRadius: 12 }} />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-medium">{rowTitle(row)}</span>
                {sub && <span className="mt-0.5 block truncate text-[12px] text-mist">{sub}</span>}
              </span>
              <ArrowUpRight size={16} aria-hidden="true" className="shrink-0 text-mist" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
