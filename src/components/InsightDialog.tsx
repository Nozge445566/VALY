import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { TEXTS } from "@/lib/texts";

interface Props {
  title: string;
  /** The item's name, under the title. */
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}

const FOCUSABLE = 'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The box in the middle of the result page (the person never leaves the page). A real modal dialog: the page behind it is inert,
 * focus is trapped and returned to the link on close, Esc and a press outside close it. Position: absolute, so it covers the page
 * it sits in and nothing else.
 */
export function InsightDialog({ title, subtitle, onClose, children }: Props) {
  const titleId = useId();
  const overlay = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // The page behind the box cannot be reached by keyboard or screen reader while it is open.
    const siblings = Array.from(overlay.current?.parentElement?.children ?? []).filter((el) => el !== overlay.current) as HTMLElement[];
    const wasInert = siblings.map((el) => el.hasAttribute("inert"));
    siblings.forEach((el) => el.setAttribute("inert", ""));
    closeBtn.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !box.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !box.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      siblings.forEach((el, i) => {
        if (!wasInert[i]) el.removeAttribute("inert");
      });
      opener?.focus?.();
    };
  }, []);

  return (
    <div
      ref={overlay}
      className="absolute inset-0 z-30 flex items-center justify-center"
      style={{ background: "rgba(3,5,13,.58)", backdropFilter: "blur(7px)", WebkitBackdropFilter: "blur(7px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="vinfo relative max-h-[78%] overflow-y-auto no-scrollbar"
        style={{
          width: "min(calc(100% - 44px), 440px)",
          background: "rgba(18,26,62,.94)",
          border: "1px solid rgba(245,237,220,.14)",
          borderRadius: 26,
          boxShadow: "0 24px 60px rgba(0,0,0,.5)",
          padding: "20px 18px",
        }}
      >
        <button
          ref={closeBtn}
          type="button"
          onClick={onClose}
          aria-label={TEXTS.insight.close}
          className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-cream"
          style={{ background: "rgba(245,237,220,.09)" }}
        >
          <X size={14} aria-hidden="true" />
        </button>
        <h2 id={titleId} className="px-8 text-center font-display text-[18px] font-medium text-cream" style={{ letterSpacing: "-0.02em" }}>
          {title}
        </h2>
        <p className="mt-1 px-6 text-center text-[13px] text-mist">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}
