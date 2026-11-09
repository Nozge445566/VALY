import { useEffect, useState, useCallback, useRef } from "react";
import { CameraView } from "@/components/CameraView";
import { ValuationCard } from "@/components/ValuationCard";
import { ScanAnim } from "@/components/ScanAnim";
import { HistoryList } from "@/components/HistoryList";
import { DailyLimit } from "@/components/DailyLimit";
import { PlansScreen } from "@/components/PlansScreen";
import { DAILY_LIMIT_ENABLED } from "@/lib/useDailyQuota";
import { useDailyQuota } from "@/lib/useDailyQuota";
import { estimate, NeedsPhotoError, PlanLimitError, type ValuationResult } from "@/lib/valuation";
import { NeedsPhoto } from "@/components/NeedsPhoto";
import { ensureSession, supabase, type ValuationRow } from "@/lib/supabase";
import { marketColumns } from "@/lib/market";
import { dataUrlToThumbnail, prepareGalleryPhoto } from "@/lib/image";
import { TEXTS } from "@/lib/texts";
import { currentLang } from "@/lib/i18n";
import { peekPendingPlan } from "@/lib/plans";
import {
  ShieldAlert,
  X,
} from "lucide-react";

type Stage = "welcome" | "scanning" | "result" | "history" | "info" | "plans" | "needsphoto";

interface SavedValuation {
  image: string;
  result: ValuationResult;
  rowId: string;
  /** Id of the stored valuation. Needed for sending back the real price. */
  runId: string | null;
}

export default function App() {
  const [stage, setStage] = useState<Stage>("welcome");
  const [error, setError] = useState<string | null>(null);
  // Set when the SERVER refused because the plan's monthly/daily limit is used (hard limit, never trusts the client).
  const [planLimit, setPlanLimit] = useState<"limit_total" | "limit_month" | "limit_day" | null>(null);
  const [needsPhoto, setNeedsPhoto] = useState<{ image: string; message: string } | null>(null);
  const [current, setCurrent] = useState<SavedValuation | null>(null);
  const currentRef = useRef<SavedValuation | null>(null);
  const [rows, setRows] = useState<ValuationRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(true);
  const uploadRef = useRef<HTMLInputElement>(null);
  const quota = useDailyQuota();

  const loadRows = useCallback(async () => {
    setRowsLoading(true);
    let uid: string;
    try {
      uid = await ensureSession();
    } catch (e) {
      setError(e instanceof Error ? e.message : TEXTS.errors.session);
      setRowsLoading(false);
      return;
    }
    // The database already limits this to the user's own rows (RLS). The filter says so out loud, too.
    const { data, error } = await supabase
      .from("valuations")
      .select("*")
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      setError(TEXTS.errors.loadHistory);
    } else {
      setRows((data as ValuationRow[]) ?? []);
    }
    setRowsLoading(false);
  }, []);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  // Back from Stripe Checkout: show the plans screen (it re-reads the plan) and clean the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      try {
        sessionStorage.setItem("valy.checkout", "1");
      } catch {
        // private mode: the plan simply shows after the next look
      }
      setStage("plans");
    }
    // Back from sign-in with a plan waiting: open Prisplan, it continues to checkout by itself.
    else if (peekPendingPlan()) setStage("plans");
    if (params.has("checkout")) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const commitCurrent = useCallback((next: SavedValuation | null) => {
    currentRef.current = next;
    setCurrent(next);
  }, []);

  /** The photo is all the user gives. It goes straight to the valuation engine. */
  async function handleCapture(photo: string) {
    // Register the shot at once. Resizing below takes a moment, and the camera view is already closing.
    setStage("scanning");
    setError(null);
    let image = photo;
    try {
      // 1024 px: the Detail eye reads logos, stamps and seams, which need more pixels than 720.
      image = await dataUrlToThumbnail(photo, 1024);
    } catch {
      // keep the original photo
    }
    await startValuation(image);
  }

  function resetToCamera() {
    setStage("welcome");
    commitCurrent(null);
  }

  /**
   * A photo from the gallery. Camera photos are not changed; a gallery photo is sent exactly as it is when it is small enough,
   * and as a smaller copy (made here, in memory) only when it is too big. The original in the gallery is never touched.
   */
  async function handleUploadFile(file: File | undefined) {
    if (!file) return;
    if (quota.limitReached) {
      setStage("welcome");
      return;
    }
    setStage("scanning"); // shrinking a big photo takes a moment
    setError(null);
    let toSend: string;
    try {
      toSend = await prepareGalleryPhoto(file);
    } catch {
      setError(TEXTS.errors.readPhoto);
      setStage("welcome");
      return;
    }
    // What the user sees and what is kept in History stays the same small picture as before; only what is sent differs.
    let shown = toSend;
    try {
      shown = await dataUrlToThumbnail(toSend, 1024);
    } catch {
      // keep the photo as it is
    }
    await startValuation(shown, toSend);
  }

  /** `image` is shown and saved in History. `toSend` is what goes to the server (the same picture unless a gallery photo is sent at full size). */
  async function startValuation(image: string, toSend: string = image) {
    // Safety net: the camera and upload are already closed at the limit, this covers a stale tab.
    if (quota.limitReached) {
      setStage("welcome");
      return;
    }
    setStage("scanning");
    setError(null);
    try {
      const { result, runId, repeat } = await estimate(toSend);
      // Counted once the valuation is in hand, so a failed scan never costs one (estimate throws before this line).
      // A repeat (same item, same device, within the server's rolling 24 hours) is free, exactly as the server counts it.
      quota.record(repeat);

      // History keeps a small copy (512 px): the list loads up to 50 rows at once, and full-size photos made that many MB.
      let stored = image;
      try {
        stored = await dataUrlToThumbnail(image, 512);
      } catch {
        // keep the photo as it is
      }
      const baseRow = {
        image_data_url: stored,
        item_name: result.itemName,
        category: result.category,
        brand: result.recognizedBrand,
        condition: result.detectedCondition,
        estimated_value_low: result.low,
        estimated_value_mid: result.mid,
        estimated_value_high: result.high,
      };
      // The market the price was made for is saved with it, so an old Swedish valuation is never read as a German one.
      // If the database does not have these columns yet (migrations 20261101120000 / 20261103100000 not applied), save without them.
      const marketRow = { ...baseRow, ...marketColumns(result) };
      await ensureSession(); // the row is stamped with this user's id by the database
      let { data, error: insertError } = await supabase.from("valuations").insert(marketRow).select("id").single();
      if (insertError && /market_country|market_basis|market_adjusted|currency/i.test(insertError.message)) {
        ({ data, error: insertError } = await supabase.from("valuations").insert(baseRow).select("id").single());
      }

      if (insertError || !data) {
        throw new Error(insertError?.message ?? TEXTS.errors.save);
      }

      const rowId = (data as { id: string }).id;
      commitCurrent({ image, result, rowId, runId });
      setStage("result");
      loadRows();
    } catch (e) {
      if (e instanceof PlanLimitError) {
        if (DAILY_LIMIT_ENABLED) setPlanLimit(e.code);
        else setError(e.message);
        setStage("welcome");
        return;
      }
      if (e instanceof NeedsPhotoError) {
        // Not a failure and not counted: a calm screen that says what to photograph next.
        setNeedsPhoto({ image, message: e.message });
        setStage("needsphoto");
        return;
      }
      setError(e instanceof Error ? e.message : TEXTS.errors.generic);
      setStage("welcome");
    }
  }

  async function handleDelete(id: string) {
    const prev = rows;
    setRows((r) => r.filter((row) => row.id !== id));
    if (currentRef.current?.rowId === id) commitCurrent(null);
    const { error } = await supabase.from("valuations").delete().eq("id", id);
    if (error) {
      setRows(prev);
      setError(TEXTS.errors.deleteOne);
    }
  }

  async function handleClearHistory() {
    if (rows.length === 0) return;
    if (!confirm(TEXTS.history.confirmClear)) return;
    const prev = rows;
    setRows([]);
    if (currentRef.current) commitCurrent(null);
    let uid: string;
    try {
      uid = await ensureSession();
    } catch {
      setRows(prev);
      setError(TEXTS.errors.session);
      return;
    }
    const { error } = await supabase.from("valuations").delete().eq("user_id", uid);
    if (error) {
      setRows(prev);
      setError(TEXTS.errors.clearAll);
    }
  }

  // The tab bar is on every screen except scanning.
  const showNav = stage === "welcome" || stage === "history" || stage === "info" || stage === "plans" || stage === "result";

  return (
    <div
      lang={currentLang()}
      className="relative mx-auto flex h-[100dvh] w-full max-w-[30rem] flex-col overflow-hidden"
      style={{ containerType: "inline-size" }}
    >
      {stage === "plans" && (
        <div className="vaur" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      )}
      {stage !== "welcome" && stage !== "result" && stage !== "history" && (
        <header
          className={`relative shrink-0 ${stage === "plans" ? "pb-0" : "pb-2"} pt-[max(env(safe-area-inset-top),1.625rem)] text-center text-[1.0625rem] text-cream ${
            stage === "info" ? "font-extrabold" : stage === "plans" ? "font-medium tracking-[-0.01em]" : "font-display font-medium"
          }`}
          style={stage === "info" ? { fontFamily: MANROPE } : stage === "plans" ? { fontFamily: '"IBM Plex Sans","Helvetica Neue",Helvetica,Arial,sans-serif' } : undefined}
        >
          Valy
        </header>
      )}

      {error && (
        <div className="px-5 mb-1">
          <div className="flex items-start gap-2 rounded-2xl border border-[#d9a58a]/30 bg-[#d9a58a]/10 px-4 py-3 text-sm text-[#ecd3c4]">
            <ShieldAlert size={18} className="mt-0.5 shrink-0" />
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-mist hover:text-cream"
              aria-label={TEXTS.app.dismiss}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      <main className={`relative min-h-0 flex-1 overflow-y-auto ${stage === "welcome" || stage === "result" || stage === "history" ? "" : "px-5 pb-2"}`}>
        {stage === "welcome" && (
          <div className="h-full">
            {quota.limitReached || (DAILY_LIMIT_ENABLED && planLimit) ? (
              <DailyLimit
                resetsAt={quota.resetsAt}
                planLimit={quota.limitReached ? (quota.lifetime ? "limit_total" : quota.monthMax > 0 && quota.max === quota.monthMax ? "limit_month" : null) : planLimit}
                onViewHistory={() => setStage("history")}
                onViewPlans={() => {
                  setPlanLimit(null);
                  setStage("plans");
                }}
              />
            ) : (
              <CameraView onCapture={handleCapture} onGalleryFile={handleUploadFile} />
            )}
          </div>
        )}

        {stage === "needsphoto" && needsPhoto && (
          <NeedsPhoto
            image={needsPhoto.image}
            message={needsPhoto.message}
            onRetake={() => {
              setNeedsPhoto(null);
              setStage("welcome");
            }}
          />
        )}

        {stage === "scanning" && (
          <div className="flex h-full items-center justify-center pb-[10cqw]">
            <ScanAnim />
          </div>
        )}

        {stage === "result" && current && (
          <div className="h-full">
          <ValuationCard
            image={current.image}
            result={current.result}
            onScanAgain={resetToCamera}
            quota={quota.showCounter ? { left: quota.left, max: quota.max, month: quota.monthMax > 0 && quota.max === quota.monthMax, total: quota.lifetime } : null}
          />
          </div>
        )}

        {stage === "history" && (
          <div
            className="relative flex h-full flex-col pt-[max(env(safe-area-inset-top),16.5cqw)]"
            style={{ fontFamily: '"IBM Plex Sans","Helvetica Neue",Helvetica,Arial,sans-serif' }}
          >
            <div className="vaur" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="relative flex items-baseline justify-between pl-[18px] pr-5 text-[14px] text-mist">
              <span className="font-semibold">{TEXTS.history.title}</span>
              <button type="button" onClick={handleClearHistory} className="text-[12px] text-cream">
                {TEXTS.history.clear}
              </button>
            </div>
            <div className="vlist relative min-h-0 flex-1 overflow-y-auto px-3 pb-10 pt-[18px] no-scrollbar">
              <HistoryList rows={rows} onDelete={handleDelete} loading={rowsLoading} />
            </div>
          </div>
        )}

        {stage === "info" && <InfoScreen />}

        {stage === "plans" && <PlansScreen />}

      </main>

      {showNav && (
        <nav
          className="relative shrink-0 border-t border-[rgba(245,237,220,0.10)] pb-[env(safe-area-inset-bottom)]"
          style={{ background: "linear-gradient(rgba(11,18,41,0), rgba(6,10,24,0.72))" }}
        >
          <div className="flex h-[88px] items-start justify-around px-[6px] pt-[10px]">
            <NavButton
              active={stage === "welcome" || stage === "result"}
              onClick={() => setStage("welcome")}
              icon={<NavIcon><path d="M4 9.500V4h5.500" /><path d="M20 14.500V20h-5.500" /></NavIcon>}
              label={TEXTS.app.nav.scan}
            />
            <NavButton
              onClick={() => (quota.limitReached || (DAILY_LIMIT_ENABLED && planLimit) ? setStage("welcome") : uploadRef.current?.click())}
              icon={<NavIcon><path d="M4 20h16" /><path d="M12 20V4" /></NavIcon>}
              label={TEXTS.app.nav.upload}
            />
            <NavButton
              active={stage === "history"}
              onClick={() => setStage("history")}
              icon={<NavIcon><path d="M8 4v10" /><path d="M8 14l8 6" /></NavIcon>}
              label={TEXTS.app.nav.history}
            />
            <NavButton
              active={stage === "plans"}
              onClick={() => setStage("plans")}
              icon={<NavIcon><path d="M14 4 10 20" /><path d="M5 12h14" /></NavIcon>}
              label={TEXTS.app.nav.plans}
            />
            <NavButton
              active={stage === "info"}
              onClick={() => setStage("info")}
              icon={<NavIcon miter><path d="M8 20V4l8 8" /></NavIcon>}
              label={TEXTS.app.nav.info}
            />
          </div>
        </nav>
      )}

      <input
        ref={uploadRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          handleUploadFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

const MANROPE = 'Manrope,"Helvetica Neue",Helvetica,Arial,sans-serif';

function InfoScreen() {
  return (
    <div className="vinfo flex h-full flex-col items-center justify-center text-center" style={{ fontFamily: MANROPE, fontWeight: 500 }}>
      <h2 className="mb-7 text-[28px] font-extrabold tracking-[-0.03em] text-cream">{TEXTS.app.infoTitle}</h2>
      <div className="plate w-full px-7 py-9 text-left">
        <p className="text-[16px] font-semibold leading-[1.65] text-cream">{TEXTS.app.info1}</p>
        <p className="mt-6 text-[14.5px] font-medium leading-[1.75] text-mist" style={{ textWrap: "pretty", hyphens: "auto" } as React.CSSProperties}>
          {TEXTS.app.info2}
        </p>
        <div className="hairline my-7" />
        <p className="text-[12px] font-semibold leading-[1.6] text-dusk">{TEXTS.app.info3}</p>
      </div>
    </div>
  );
}

/** The thin-line tab icons from the start design. */
function NavIcon({ miter, children }: { miter?: boolean; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin={miter ? "miter" : "round"}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Tab: icon in a pill (lit when active) with the name below. */
function NavButton({
  active,
  onClick,
  icon,
  label,
}: {
  active?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={`flex flex-1 flex-col items-center gap-[5px] transition active:scale-90 ${
        active ? "text-cream" : "text-[#6f7ca3] hover:text-cream"
      }`}
    >
      <span
        className="flex h-[30px] w-[52px] items-center justify-center rounded-[15px]"
        style={
          active
            ? {
                background: "rgba(245,237,220,0.11)",
                boxShadow: "inset 0 0 0 1px rgba(245,237,220,0.08), 0 0 18px rgba(143,155,187,0.18)",
              }
            : undefined
        }
      >
        {icon}
      </span>
      <span
        className="text-[10.5px] font-medium tracking-[0.02em]"
        style={{ fontFamily: '-apple-system,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif' }}
      >
        {label}
      </span>
    </button>
  );
}
