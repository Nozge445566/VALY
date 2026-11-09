// The language of the words the Brain writes for the person: Swedish or English. Nothing else.
//
// The app decides it from the phone (Swedish phone -> "sv", everything else -> "en") and sends `lang`. Without it we
// look at `locale`. Unknown or missing: English. Every text that reaches the screen from the Brain lives here (or is
// written by the Judge, which is told the language in judge-prompt.ts), so a new wording is changed in one place.
//
// Tone: calm, short, human. Like a product from a good team, not a translation.

export type Lang = "sv" | "en";

export function langOfLocale(locale: unknown): Lang {
  return typeof locale === "string" && /^sv([-_]|$)/i.test(locale.trim()) ? "sv" : "en";
}

/** From the request body: an explicit `lang` wins, else the `locale`. Never throws. */
export function langOfBody(body: unknown): Lang {
  if (typeof body !== "object" || body === null) return "en";
  const b = body as Record<string, unknown>;
  if (b["lang"] === "sv" || b["lang"] === "en") return b["lang"];
  return langOfLocale(b["locale"]);
}

type Grade = "new" | "like-new" | "good" | "fair" | "poor";

const en = {
  labels: {
    item: "Item", condition: "Condition", details: "Details", market: "Market", why: "Why", uncertain: "Uncertain",
    improve: "To improve accuracy", construction: "Construction and era", textCheck: "Text check", authenticity: "Authenticity", checked: "Checked", memory: "Memory", fx: "Exchange rate",
  },
  grade: { new: "Looks unused", "like-new": "Like new", good: "Good", fair: "Fair", poor: "Poor" } as Record<Grade, string>,
  likely: (brand: string, model: string | null) => ` Likely ${brand}${model ? " " + model : ""}.`,
  market: {
    matched: (kept: number, total: number, sold: number, sites: string) =>
      `${kept} of ${total} live listings matched this exact item (${sold} sold)${sites ? ` on ${sites}` : ""}.`,
    fewerSold: (target: number) => ` Fewer than ${target} sold prices were found, so confidence is lower.`,
    fromMemory: (kept: number, days: number) =>
      `${kept} listing${kept === 1 ? "" : "s"} saved ${days < 1 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`} from an earlier valuation of this item were checked against your photo. The prices were not refreshed.`,
    empty: "No priced listings were found in time, so this estimate rests on what is known about similar items.",
    disabled: "Live listings are not set up, so this estimate rests on what is known about similar items.",
    failed: "The live market check was not available this time, so this estimate rests on what is known about similar items.",
  },
  authHigh: "The risk of a fake or replica looks high. Check authenticity before you pay.",
  authCheck: "A fake or replica cannot be ruled out. Check authenticity before you pay.",
  movedCloser: "The estimate was moved closer to what comparable items actually sold for.",
  veryWide: "The range is very wide because the value of this item is hard to pin down.",
  fxUnknownCurrency: (code: string) => `No exchange rate is available for ${code}, so the amounts are shown in US dollars (USD).`,
  fxStale: (hours: number) => `Exchange rates are about ${hours} h old (live rates were not reachable), so the conversion can differ slightly.`,
  fxFallback: "Live exchange rates were not available, so the currency conversion may be slightly out of date.",
  memoryHit: "This item was recognized from an earlier valuation of the same item. Its condition was checked against your photo.",
  memoryUnverified: "This item was valued before, but its condition looks different now and could not be re-checked in time, so confidence is lower.",
  needsPhoto: "I can't tell what this is. Take a clear, well-lit photo of the item on its own, close enough to see details.",
  closerPhoto: "Take a closer photo of any label, stamp, logo or model number.",
  emergency: { unknown: "The listings were not checked against the photo.", reason: "Quick estimate from raw listing prices." },
  estimate: { unknown: "Estimate without market data, based on marks, material and era.", reason: "No comparable listings were found, so this is a wide estimate from the item's typical new price, age, condition and rarity.", neighbourUnknown: "Estimate without market data, based on similar items valued before.", neighbourReason: "No comparable listings were found, so this is a very wide estimate from similar items valued before. A clearer photo of marks or a label would help a lot.", noAnchor: "No market data and unclear item. Take a clear photo of any maker's mark, hallmark, label or model number." },
  errors: {
    invalid: "Invalid request.",
    photoUnreadable: "The photo could not be read. Use a JPEG, PNG, WebP or GIF image.",
    usePost: "Use POST.",
    tooLarge: "The photo is too large.",
    notSetUp: "The valuation service is not set up yet.",
    tooSlow: "The valuation took too long. Please try again.",
    couldNotValue: "The item could not be valued right now. Please try again, or use a clearer photo.",
    wentWrong: "Something went wrong while valuing the item. Please try again.",
    user_limit: "You have made many valuations in a short time. Please wait a while and try again.",
    attempt_limit: "You have made many valuations in a short time. Please wait a while and try again.",
    ip_limit: "Many valuations were made from this network in a short time. Please wait a while and try again.",
    day_limit: "The service has reached its daily limit. Please try again tomorrow.",
    limit_total: "You have used your 20 free scans. Pick a plan to keep going.",
    limit_month: "You have used this month's scans. Pick a plan to keep going.",
    limit_day: "You have reached today's scan limit. It renews tomorrow.",
  },
};

export type ServerTexts = typeof en;

const sv: ServerTexts = {
  labels: {
    item: "Föremål", condition: "Skick", details: "Detaljer", market: "Marknad", why: "Därför", uncertain: "Osäkert",
    improve: "För bättre träffsäkerhet", construction: "Konstruktion och epok", textCheck: "Textkoll", authenticity: "Äkthet", checked: "Kontrollerat", memory: "Minne", fx: "Växelkurs",
  },
  grade: { new: "Ser oanvänd ut", "like-new": "Som ny", good: "Bra", fair: "Okej", poor: "Sliten" },
  likely: (brand, model) => ` Troligen ${brand}${model ? " " + model : ""}.`,
  market: {
    matched: (kept, total, sold, sites) =>
      `${kept} av ${total} aktuella annonser matchade exakt det här föremålet (${sold} sålda)${sites ? ` på ${sites}` : ""}.`,
    fewerSold: (target) => ` Vi hittade färre än ${target} sålda priser, så tillförlitligheten är lägre.`,
    fromMemory: (kept, days) =>
      `${kept} annons${kept === 1 ? "" : "er"} som sparades ${days < 1 ? "i dag" : `för ${days} dag${days === 1 ? "" : "ar"} sedan`} från en tidigare värdering av det här föremålet jämfördes med ditt foto. Priserna har inte uppdaterats.`,
    empty: "Vi hittade inga annonser med pris i tid, så uppskattningen bygger på vad som är känt om liknande föremål.",
    disabled: "Aktuella annonser är inte aktiverade, så uppskattningen bygger på vad som är känt om liknande föremål.",
    failed: "Marknadskollen fungerade inte den här gången, så uppskattningen bygger på vad som är känt om liknande föremål.",
  },
  authHigh: "Risken för en kopia eller förfalskning ser hög ut. Kontrollera äktheten innan du betalar.",
  authCheck: "Det går inte att utesluta en kopia eller förfalskning. Kontrollera äktheten innan du betalar.",
  movedCloser: "Uppskattningen har flyttats närmare vad liknande föremål faktiskt har sålts för.",
  veryWide: "Spannet är mycket brett eftersom värdet på det här föremålet är svårt att fastställa.",
  fxUnknownCurrency: (code: string) => `Ingen växelkurs finns för ${code}, så beloppen visas i amerikanska dollar (USD).`,
  fxStale: (hours: number) => `Växelkurserna är ungefär ${hours} timmar gamla (aktuella kurser gick inte att hämta), så omräkningen kan avvika något.`,
  fxFallback: "Aktuella växelkurser var inte tillgängliga, så valutaomräkningen kan vara något gammal.",
  memoryHit: "Föremålet kändes igen från en tidigare värdering av samma föremål. Skicket kontrollerades mot ditt foto.",
  memoryUnverified: "Föremålet har värderats förut, men skicket ser annorlunda ut nu och hann inte kontrolleras på nytt, så tillförlitligheten är lägre.",
  needsPhoto: "Jag kan inte se vad det här är. Ta ett tydligt, välbelyst foto av enbart föremålet, så nära att detaljerna syns.",
  closerPhoto: "Ta ett närbildsfoto av en etikett, stämpel, logga eller ett modellnummer.",
  emergency: { unknown: "Annonserna jämfördes inte med fotot.", reason: "Snabb uppskattning av råa annonspriser." },
  estimate: { unknown: "Uppskattning utan marknadsdata, baserad på stämplar, material och tidsperiod.", reason: "Inga jämförbara annonser hittades, så det här är en bred uppskattning från nypris, ålder, skick och sällsynthet.", neighbourUnknown: "Uppskattning utan marknadsdata, baserad på liknande föremål som värderats tidigare.", neighbourReason: "Inga jämförbara annonser hittades, så det här är en mycket bred uppskattning från liknande föremål som värderats tidigare. Ett tydligare foto av stämplar eller etikett hjälper mycket.", noAnchor: "Ingen marknadsdata och oklart föremål. Ta ett tydligt foto av tillverkarstämpel, hallmärke, etikett eller modellnummer." },
  errors: {
    invalid: "Ogiltig förfrågan.",
    photoUnreadable: "Fotot gick inte att läsa. Använd en JPEG-, PNG-, WebP- eller GIF-bild.",
    usePost: "Använd POST.",
    tooLarge: "Fotot är för stort.",
    notSetUp: "Värderingstjänsten är inte konfigurerad än.",
    tooSlow: "Värderingen tog för lång tid. Försök igen.",
    couldNotValue: "Det gick inte att värdera föremålet just nu. Försök igen, eller använd ett tydligare foto.",
    wentWrong: "Något gick fel under värderingen. Försök igen.",
    user_limit: "Du har gjort många värderingar på kort tid. Vänta en stund och försök igen.",
    attempt_limit: "Du har gjort många värderingar på kort tid. Vänta en stund och försök igen.",
    ip_limit: "Många värderingar har gjorts från det här nätverket på kort tid. Vänta en stund och försök igen.",
    day_limit: "Tjänsten har nått sin dagsgräns. Försök igen i morgon.",
    limit_total: "Du har använt dina 20 gratis skanningar. Välj en plan för att fortsätta.",
    limit_month: "Du har använt månadens skanningar. Välj en plan för att fortsätta.",
    limit_day: "Du har nått dagens gräns. Den fylls på i morgon.",
  },
};

/** The texts of one language. Missing or unknown language: English. */
export function T(lang: Lang | undefined): ServerTexts {
  return lang === "sv" ? sv : en;
}

/** Both languages' label for a factor, so code that removes an old line finds it whichever language wrote it. */
export function labelsOf(key: keyof ServerTexts["labels"]): string[] {
  return [en.labels[key], sv.labels[key]];
}

/** What the Judge is told when the person's phone is Swedish. Empty for English, so the English prompt never changes. */
export function judgeLanguageRule(lang: Lang | undefined): string {
  if (lang !== "sv") return "";
  return `\n\nLanguage: the person reading this uses a Swedish phone. Write display_name, condition.details, unknowns, extra_photo_request and reason in natural, concise Swedish, like a good Swedish consumer app would. Keep brand and model names exactly as they are. Do not translate the JSON field names or the grade values. All other rules stay the same.`;
}
