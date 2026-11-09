// Language of the app. One rule: if the phone's language is Swedish the app is Swedish, everything else is English.
// No setting, no switch. Safe to import in Node (tests): without a browser it answers English.

export type Lang = "sv" | "en";

/** "sv", "sv-SE", "sv-FI", "SV_se" -> sv. Anything else (also empty or broken) -> en. */
export function langOfLocale(locale: string | null | undefined): Lang {
  if (typeof locale !== "string") return "en";
  return /^sv([-_]|$)/i.test(locale.trim()) ? "sv" : "en";
}

/** The phone's first (preferred) language, or "" when there is no browser. */
export function deviceLocale(): string {
  if (typeof navigator === "undefined") return "";
  return navigator.languages?.[0] ?? navigator.language ?? "";
}

let cached: Lang | null = null;

/** The app language, decided once from the phone's preferred language. */
export function currentLang(): Lang {
  if (!cached) cached = langOfLocale(deviceLocale());
  return cached;
}

/**
 * The locale used for words, dates, numbers and country names, so a German phone never gets a German date inside an
 * English sentence. Swedish phones: sv-SE. English phones keep their own region (en-US, en-GB, en-AU ...). Others: en-GB.
 */
export function uiLocale(): string {
  if (currentLang() === "sv") return "sv-SE";
  const device = deviceLocale();
  return /^en-[A-Za-z]{2}$/i.test(device) ? device : "en-GB";
}

/** Picks the text for the current language. */
export function pick<T>(texts: { sv: T; en: T }, lang: Lang = currentLang()): T {
  return texts[lang];
}
