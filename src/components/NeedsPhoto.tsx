import { Camera } from "lucide-react";
import { TEXTS } from "@/lib/texts";

interface Props {
  /** The photo the user just sent, so they see what the valuation engine saw. */
  image: string | null;
  /** The engine's own specific sentence (what to photograph), already in the user's language. */
  message: string;
  onRetake: () => void;
}

/** Shown when the item cannot be valued from this photo. Calm and useful: what to photograph next, one clear button. */
export function NeedsPhoto({ image, message, onRetake }: Props) {
  const t = TEXTS.needsPhotoScreen;
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center font-display" role="status">
      {image ? (
        <img src={image} alt="" className="mb-5 h-28 w-28 rounded-2xl border border-[var(--rule)] object-cover opacity-80" />
      ) : (
        <div className="mb-5 grid h-16 w-16 place-items-center rounded-full border border-[var(--rule)] bg-plate text-cream">
          <Camera size={26} strokeWidth={1.5} />
        </div>
      )}
      <h2 className="text-[1.6rem] font-medium leading-tight tracking-[-0.03em] text-cream">{t.title}</h2>
      <p className="mt-3 max-w-xs text-[0.95rem] leading-relaxed text-mist">{t.lead}</p>
      <p className="mt-3 max-w-xs text-[0.95rem] leading-relaxed text-cream">{message}</p>
      <div className="mt-5 w-full max-w-xs text-left">
        <p className="text-xs uppercase tracking-wide text-dusk">{t.tipsTitle}</p>
        <ul className="mt-2 space-y-1.5 text-sm text-mist">
          {t.tips.map((tip) => (
            <li key={tip} className="flex gap-2">
              <span aria-hidden="true" className="text-dusk">–</span>
              <span>{tip}</span>
            </li>
          ))}
        </ul>
      </div>
      <button type="button" onClick={onRetake} className="btn-cream mt-7 max-w-xs font-display">
        {t.retake}
      </button>
    </div>
  );
}
