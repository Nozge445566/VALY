import { useEffect, useState } from "react";
import { PLANS, clearPendingPlan, fetchPlan, openPortal, peekPendingPlan, readPlan, setPendingPlan, startCheckout, type PlanId } from "@/lib/plans";
import { TEXTS } from "@/lib/texts";
import { AccountLink } from "@/components/AccountLink";
import { isSignedIn } from "@/lib/account";
import { uiLocale } from "@/lib/i18n";
import { detectCurrency, formatMoney } from "@/lib/currency";
import { fetchConvertedPrices, type ConvertedPrices } from "@/lib/planPrices";

const sek = (n: number) =>
  new Intl.NumberFormat(uiLocale(), { style: "currency", currency: "SEK", maximumFractionDigits: 0 }).format(n);

const PLEX = '"IBM Plex Sans","Helvetica Neue",Helvetica,Arial,sans-serif';

type Paid = Exclude<PlanId, "free">;

/**
 * Plan picker: one plate with a row per plan (name and price, then scans per month and per day).
 * The chosen card is cream (Pro from the start), one cream button below says "Välj <plan>", "Logga in" under it.
 */
export function PlansScreen() {
  const T = TEXTS.plans;
  const [note, setNote] = useState(false);
  const [signal, setSignal] = useState(0);
  const [current, setCurrent] = useState<PlanId>(readPlan);
  const [selected, setSelected] = useState<PlanId>(() => {
    const c = readPlan();
    return c === "free" ? "pro" : c;
  });

  // Prices in the phone's currency, refreshed like the valuations' exchange rates (every 5 minutes and when the app is opened again).
  const [converted, setConverted] = useState<ConvertedPrices | null>(null);
  useEffect(() => {
    const code = detectCurrency().code;
    if (code === "SEK") return;
    let alive = true;
    const load = async () => {
      const c = await fetchConvertedPrices(code, PLANS.map((p) => p.priceMonth));
      if (alive && c) setConverted(c);
    };
    void load();
    const timer = setInterval(load, 5 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const price = (i: number, sekAmount: number) => (converted ? formatMoney(converted.amounts[i], converted.currency) : sek(sekAmount));

  async function checkout(plan: Paid) {
    setNote(false);
    const url = await startCheckout(plan, "monthly");
    if (url) window.location.assign(url);
    else setNote(true); // billing not live yet
  }

  useEffect(() => {
    let alive = true;
    // Arriving from Stripe: the webhook can land a second after the redirect, so look a few more times until the plan changes.
    let fromCheckout = false;
    try {
      fromCheckout = sessionStorage.getItem("valy.checkout") === "1";
    } catch {
      // storage blocked: one look is enough
    }
    let tries = 0;
    const look = async () => {
      const p = await fetchPlan();
      if (!alive) return;
      setCurrent(p);
      if (p !== "free") setSelected(p);
      if (fromCheckout && p === "free" && tries++ < 6) setTimeout(look, 2000);
      else if (fromCheckout) {
        try {
          sessionStorage.removeItem("valy.checkout");
        } catch {
          // ignore
        }
      }
    };
    void look();
    // Back from sign-in with a plan waiting: carry on to checkout without a second tap.
    void (async () => {
      const pending = peekPendingPlan();
      if (!pending || !(await isSignedIn()) || !alive) return;
      clearPendingPlan();
      setSelected(pending);
      await checkout(pending);
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function confirm() {
    if (selected === current) return;
    // Back to Gratis means cancelling: that happens in the customer portal.
    if (selected === "free") {
      const url = await openPortal();
      if (url) window.location.assign(url);
      else setNote(true);
      return;
    }
    if (!(await isSignedIn())) {
      setPendingPlan(selected);
      setNote(false);
      setSignal((n) => n + 1);
      return;
    }
    await checkout(selected);
  }

  const same = selected === current;

  const BG: Record<string, string> = { free: "#171b25", pro: "#272c3a", premium: "#3a4156", business: "#4e5873" };

  return (
    <div className="relative flex h-full min-h-[34rem] flex-col pb-[20px]" style={{ fontFamily: PLEX }}>
      <p className="mt-[22px] text-[10.5px] font-medium uppercase tracking-[0.22em] text-dusk">{T.eyebrow}</p>
      <h2 className="mt-[7px] text-[27px] font-medium leading-[32px] tracking-[-0.03em] text-cream">{T.title}</h2>

      <div className="mt-[18px] flex min-h-[22rem] flex-1 flex-col gap-[9px]">
        {PLANS.map((p, i) => {
          const paid = p.id !== "free";
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={p.id === selected}
              onClick={() => {
                setSelected(p.id);
                setNote(false);
              }}
              className="vcard flex min-h-0 flex-1 flex-col justify-center rounded-[20px] border border-cream px-[22px] text-left tabular-nums text-cream"
              style={{ background: BG[p.id], "--d": `${(0.15 + i * 0.07).toFixed(2)}s` } as React.CSSProperties}
            >
              <div className="flex items-baseline justify-between text-[18px] font-medium leading-[22px] tracking-[-0.02em]">
                <span>
                  {T.names[p.id]}
                  {paid && p.id === current && (
                    <small className="ml-2 text-[11.5px] font-normal tracking-normal text-cream/60">{T.current}</small>
                  )}
                </span>
                <span>
                  {price(i, p.priceMonth)}
                  {paid && <small className="ml-1 text-[11.5px] font-normal tracking-normal text-cream/60">{T.perMonth}</small>}
                </span>
              </div>
              <div className="my-[10px] mt-[11px] h-px bg-cream/[0.16]" />
              <div className="flex justify-between text-[13px] leading-[18px] text-cream/[0.62]">
                <span>{p.lifetime ? T.rowTotal : T.rowMonth}</span>
                <span className="text-cream">{T.scans(p.scansPerMonth)}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-[14px] flex flex-col items-center">
        <button
          type="button"
          disabled={same}
          onClick={confirm}
          className="btn-cream !h-[52px] !text-[16px] disabled:opacity-60"
        >
          {same ? T.keep : T.select(T.names[selected])}
        </button>
        {note && (
          <p className="mt-2 text-center text-[0.8rem] text-mist" aria-live="polite">
            {T.comingSoon}
          </p>
        )}
        {converted && (
          <p className="mt-2 text-center text-[0.72rem] text-mist">{T.fxNote(converted.currency)}</p>
        )}
        <AccountLink openSignal={signal} />
      </div>
    </div>
  );
}
