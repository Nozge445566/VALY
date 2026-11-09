import { useEffect, useState } from "react";
import { continueWithEmail, continueWithProvider, isSignedIn, type AccountResult } from "@/lib/account";
import { TEXTS } from "@/lib/texts";

/** Quiet link under the plans, same style as "See plans". Opens a small inline panel: Apple, Google or email. */
export function AccountLink({ openSignal = 0 }: { openSignal?: number }) {
  const T = TEXTS.account;
  const [open, setOpen] = useState(false);
  const [signed, setSigned] = useState(false);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<AccountResult | "busy" | null>(null);
  useEffect(() => {
    void isSignedIn().then(setSigned);
  }, []);
  // PlansScreen bumps this when a signed-out person picks a paid plan.
  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);

  const run = async (go: () => Promise<AccountResult>) => {
    setState("busy");
    setState(await go());
  };

  if (signed) return <p className="mt-[14px] text-center text-[13.5px] text-dusk">{T.signedIn}</p>;
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-[14px] text-[13.5px] font-medium text-mist transition hover:text-cream">
        {T.open}
      </button>
    );
  const busy = state === "busy";
  return (
    <div className="plate mt-4 w-full max-w-[20.5rem] px-6 py-6" style={{ borderRadius: "1.5rem" }}>
      <h3 className="text-[1.05rem] font-medium tracking-[-0.01em] text-cream">{T.title}</h3>
      <p className="mt-1 text-[0.8125rem] text-mist">{T.sub}</p>
      <div className="mt-5 space-y-3">
        <button type="button" disabled={busy} onClick={() => run(() => continueWithProvider("apple"))} className="btn-cream !h-12 !text-[0.95rem]">
          {T.apple}
        </button>
        <button type="button" disabled={busy} onClick={() => run(() => continueWithProvider("google"))} className="btn-cream !h-12 !text-[0.95rem]">
          {T.google}
        </button>
      </div>
      <div className="hairline my-5" />
      <input
        className="input"
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder={T.emailPlaceholder}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button
        type="button"
        disabled={busy || !/^\S+@\S+\.\S+$/.test(email.trim())}
        onClick={() => run(() => continueWithEmail(email.trim()))}
        className="mt-3 w-full text-[0.875rem] font-medium text-mist transition hover:text-cream disabled:opacity-50"
      >
        {T.email}
      </button>
      <p className="mt-3 min-h-[1.25rem] text-center text-[0.8rem] text-mist" aria-live="polite">
        {state === "sent" ? T.sent : state === "error" ? T.error : ""}
      </p>
    </div>
  );
}
