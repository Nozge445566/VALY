// Every sentence the app shows, in Swedish and English. One place: a new language only touches this file.
//
// Language: decided by the phone (see i18n.ts). Swedish phone -> Swedish. Everything else -> English.
// Tone: short, calm, human. No exclamation marks, no filler, no "AI" talk. Like a good product you would
// find on the App Store, not a translation.
//
// Rules: no percent for confidence (a percent reads like a probability), only the label.
// Where the data came from (other countries): a small country tag on every listing from another country, and,
// when FOREIGN_DATA_NOTE is true (it is: a foreign number must not be visible only through a
// tag), one calm sentence under the range that NAMES the countries when the evidence is not mostly local, plus a
// small "other markets" chip on the history row. Set it to false for the quiet option (tag only, no sentence).
// Either way a foreign price is never shown as a local one: the tag, the saved country and the history say so.

import { currentLang, type Lang } from "./i18n.ts";

/** true = tag + one sentence naming the countries + history chip. false = quiet: tag only. */
export const FOREIGN_DATA_NOTE = true;

type Level = "low" | "medium" | "high";

const en = {
  // ---- valuation card
  rangeCaption: "80% of similar sales fall in this range",
  estimatedValue: "Estimated value",
  confidence: {
    label: (level: Level) => `Confidence ${{ low: "low", medium: "medium", high: "high" }[level]}`,
  },
  checkedAgainstListings: "Checked against live listings.",
  listingsFound: "Listings found online",
  listingKind: { sold: "sold", asking: "asking", unknown: "" } as Record<string, string>,
  betterPhoto: "A better photo would help",
  scanAnother: "Scan another",
  nextItem: "Photograph next item",
  unbranded: "Unbranded",
  guidanceOnly: "Guidance only, not an appraisal.",
  insight: {
    seeMarket: "See market data",
    seeHow: "See how we valued it",
    marketTitle: "Market data",
    howTitle: "How we valued it",
    close: "Close",
    opensAtSource: "Opens at the source",
    searchItem: "Search for the item",
  },
  // ---- condition words (server sends the codes)
  conditions: { new: "new", "like-new": "like new", good: "good", fair: "fair", poor: "poor" } as Record<string, string>,
  // ---- history
  history: {
    title: "Saved valuations",
    saved: (n: number) => `${n} saved`,
    clear: "Clear",
    loading: "Loading history…",
    empty: "No valuations yet. Your saved estimates will appear here.",
    delete: "Delete valuation",
    fullName: "Full name",
    close: "Close",
    showName: "Show full name",
    hideName: "Hide full name",
    confirmClear: "Delete all saved valuations? This can't be undone.",
  },
  // ---- daily limit. Never shown before the second result. Plain product voice: specific, confident, no praise words, no exclamation marks.
  needsPhotoScreen: {
    title: "Try another photo",
    lead: "We can't give a reliable value from this photo.",
    tipsTitle: "What helps most",
    tips: ["Move closer and keep the item sharp and well lit.", "Photograph any maker's mark, hallmark, label or model number.", "Use a plain background and show the whole item."],
    retake: "Take a new photo",
  },
  quota: {
    left: (left: number, max: number) => `${left} of ${max} left today`,
    used: (max: number) => `${max} of ${max} used`,
    doneNoteTotal: "Your 20 free scans are used. Everything you've valued is saved in History.",
    doneNoteMonth: "This month's scans are used. They renew on the 1st, and everything you've valued is saved in History.",
    leftMonth: "this month",
    doneNote: "Full allowance used. It resets at midnight, and everything you've valued is saved in History.",
    reachedTitle: (max: number) => `You've used all ${max} today`,
    reachedBody: "Your allowance resets at midnight. Until then, everything you've valued is saved in History.",
    renewsIn: (hours: number, minutes: number) => (hours > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${minutes}m`),
    viewHistory: "Open History",
    totalTitle: "Your free scans are used",
    totalBody: "You've used all 20 free scans. Pick a plan to keep valuing. Everything you've valued is saved in History.",
    monthTitle: "This month's scans are used",
    monthBody: "Your plan renews its scans at the start of next month. Everything you've valued is saved in History.",
    dayTitle: "Today's scans are used",
    dayBody: "Your plan's daily allowance renews tomorrow. Everything you've valued is saved in History.",
  },
  account: {
    open: "Sign in",
    title: "Sign in",
    sub: "So your plan follows you.",
    apple: "Continue with Apple",
    google: "Continue with Google",
    email: "Send me a link by email",
    emailPlaceholder: "Email address",
    sent: "Check your inbox and open the link.",
    error: "That didn't work. Try again in a moment.",
    signedIn: "Signed in. Your plan follows you.",
  },
  // ---- plans
  plans: {
    eyebrow: "Plan",
    title: "Choose a plan",
    sub: "Change or cancel any time.",
    rowMonth: "Per month",
    rowTotal: "In total, once",
    rowDay: "Per day",
    scans: (n: number) => `${n} scans`,
    select: (name: string) => `Choose ${name}`,
    keep: "Your plan",
    hint: "Tap Pro, Premium or Business to choose.",
    free: "Free",
    monthly: "Monthly",
    yearly: "Yearly",
    save: (pct: number) => `Save ${pct}%`,
    perMonth: "/ month",
    perYear: "/ year",
    billedYearly: (price: string) => `Billed ${price} per year`,
    scansMonth: (n: number) => `${n} scans a month`,
    scansDay: (n: number) => `Up to ${n} a day`,
    noDayCap: "No daily cap",
    names: { free: "Free", pro: "Pro", premium: "Premium", business: "Business" } as Record<string, string>,
    current: "Your plan",
    choose: (name: string) => `Choose ${name}`,
    comingSoon: "Payments open soon.",
    openPlans: "See plans",
    manage: "Manage subscription",
    footnote: "Prices include VAT. Values are estimates.",
    fxNote: (code: string) => `Billed in SEK. Amounts in ${code} are estimates at today's rate.`,
  },
  // ---- app shell
  app: {
    welcomeTag: "Value anything, instantly.",
    scanSub: "This takes a few seconds.",
    scanCopy: ["Looking at the item…", "Reading the fine details…", "Checking live prices…", "Weighing it all up…"],
    nav: { scan: "Scan", upload: "Upload", history: "History", plans: "Plans", info: "Info", restart: "Restart" },
    dismiss: "Dismiss",
    scanning: "Scanning",
    infoTitle: "About Valy",
    info1: "Valy values almost anything in a matter of seconds.",
    info2: "You get an estimated value based on current market data, together with a reasonable price range. Use it for anything from an item you want to sell to simply finding out what the things around you are worth.",
    info3: "The estimate is guidance and does not replace a formal appraisal. For valuable items, an expert should confirm authenticity and condition.",
  },
  errors: {
    loadHistory: "Couldn't load your history.",
    readPhoto: "Couldn't read that photo.",
    save: "Couldn't save the valuation.",
    generic: "Something went wrong.",
    deleteOne: "Couldn't delete that valuation.",
    clearAll: "Couldn't clear your history.",
    notConnected: "The app isn't connected to its backend yet.",
    session: "Couldn't start your private session. Check your connection and try again.",
    unreachable: "Couldn't reach the valuation service. Check your connection and try again.",
    failedStatus: (status: number) => `The valuation failed (${status}).`,
    unexpected: "The valuation service sent an unexpected answer.",
    needsPhoto: "We couldn't recognize the item. Try a clearer photo.",
    tooSlow: "The valuation took too long. Please try again.",
    tryClearer: "Try a clearer photo of the item.",
  },
  // ---- camera
  camera: {
    frameEmpty: "The camera frame was empty.",
    previewFailed: "The camera preview failed.",
    unsupported: "This browser can't open the camera. Upload a photo instead.",
    blocked: "Camera access is blocked. Upload a photo instead.",
    couldNotOpen: "Couldn't open the camera. Upload a photo instead.",
    notReady: "The camera wasn't ready. Try again.",
    couldNotCapture: "Couldn't capture the photo.",
    couldNotTake: "Couldn't take the photo.",
    open: "Open camera",
    thenShutter: "Then tap the shutter",
    uploadPhoto: "Upload a photo",
    uploadAlt: "Upload a picture",
    opening: "Opening camera…",
    center: "Center the item",
    close: "Close camera",
    takePhoto: "Take photo",
  },
  /**
   * Only shown when FOREIGN_DATA_NOTE is true and result.market.basis is not local. `where` is the list of country
   * names ("the United States and Germany"), or the generic words when the listings shown do not name one.
   * `adjusted` is added when a learned price-level shift moved the foreign prices toward the user's own level.
   */
  foreignData: {
    regional: (where: string) => `Some of the comparable sales come from nearby markets (${where}), so the range is a little wider.`,
    global: (where: string) => `Few comparable sales were found in your country, so sales from ${where} were used and the range is wider.`,
    adjusted: "Those prices were adjusted toward your local price level.",
    otherMarkets: "other markets",
    nearbyMarkets: "nearby markets",
    genericRegional: "nearby countries",
    genericGlobal: "other markets",
    and: "and",
  },
  /** Tooltip of the chip on a history row whose evidence was foreign. */
  historyBasis: {
    regional: "Made partly from nearby markets",
    global: "Made partly from other markets",
  },
  /** Tooltip of the country tag on a listing from another country. */
  listingFrom: (country: string) => `Listed in ${country}`,
  /** Tooltip of the country tag in the history. */
  madeFor: (country: string) => `Valued for ${country}`,
  /** One calm sentence per width driver code sent by the valuation engine. Unknown codes are skipped. */
  drivers: {
    model_only: "Few comparable sales were found, so this rests mostly on the photo.",
    few_comparables: "Only a few comparable sales were found.",
    sources_disagree: "The photo and the market point to somewhat different prices.",
    judge_disagreement: "Some checks on the listings disagreed with the first read, so the range is wider.",
    mostly_asking_prices: "Most comparable prices are asking prices, not final sales.",
    rarity: "Rare items can sell for very different prices.",
    unclear_condition: "The condition is hard to judge from the photo.",
    authenticity: "Authenticity is hard to confirm from the photo, so the range extends lower.",
    identity: "The exact model isn't certain.",
  } as Record<string, string>,
  /** Labels of the factor lines the valuation engine sends, by their English key. Used if an older engine still answers in English. */
  factorLabels: {} as Record<string, string>,
};

type Texts = typeof en;

const sv: Texts = {
  rangeCaption: "80\u00a0% av liknande försäljningar ligger inom det här spannet",
  estimatedValue: "Uppskattat värde",
  confidence: {
    label: (level) => `Tillförlitlighet: ${{ low: "låg", medium: "medelhög", high: "hög" }[level]}`,
  },
  checkedAgainstListings: "Jämfört med aktuella annonser.",
  listingsFound: "Annonser vi hittade",
  listingKind: { sold: "såld", asking: "annonspris", unknown: "" },
  betterPhoto: "Ett bättre foto hjälper",
  scanAnother: "Skanna en till",
  nextItem: "Fotografera nästa föremål",
  unbranded: "Okänt märke",
  guidanceOnly: "En uppskattning, ingen värdering.",
  insight: {
    seeMarket: "Se marknadsdata",
    seeHow: "Se hur vi värderade",
    marketTitle: "Marknadsdata",
    howTitle: "Så värderade vi",
    close: "Stäng",
    opensAtSource: "Öppnas hos källan",
    searchItem: "Sök efter föremålet",
  },
  conditions: { new: "ny", "like-new": "som ny", good: "bra", fair: "okej", poor: "sliten" },
  history: {
    title: "Sparade värderingar",
    saved: (n) => `${n} sparade`,
    clear: "Rensa",
    loading: "Hämtar historik…",
    empty: "Inga värderingar än. Dina sparade uppskattningar visas här.",
    delete: "Ta bort värdering",
    fullName: "Fullständigt namn",
    close: "Stäng",
    showName: "Visa fullständigt namn",
    hideName: "Dölj fullständigt namn",
    confirmClear: "Ta bort alla sparade värderingar? Det går inte att ångra.",
  },
  needsPhotoScreen: {
    title: "Ta ett till foto",
    lead: "Vi kan inte ge ett pålitligt värde utifrån det här fotot.",
    tipsTitle: "Det här hjälper mest",
    tips: ["Gå närmare och håll föremålet skarpt och väl belyst.", "Fotografera tillverkarstämpel, hallmärke, etikett eller modellnummer.", "Använd en enkel bakgrund och visa hela föremålet."],
    retake: "Ta ett nytt foto",
  },
  quota: {
    left: (left, max) => `${left} av ${max} kvar idag`,
    used: (max) => `${max} av ${max} använda`,
    doneNoteTotal: "Dina 20 gratis skanningar är använda. Allt du värderat finns sparat i Historik.",
    doneNoteMonth: "Månadens skanningar är använda. De fylls på den 1:a, och allt du värderat finns sparat i Historik.",
    leftMonth: "denna månad",
    doneNote: "Hela dagskvoten är använd. Den fylls på vid midnatt, och allt du värderat finns sparat i Historik.",
    reachedTitle: (max) => `Du har använt alla ${max} idag`,
    reachedBody: "Din kvot fylls på vid midnatt. Tills dess finns allt du värderat sparat i Historik.",
    renewsIn: (hours, minutes) => (hours > 0 ? `Fylls på om ${hours} h ${minutes} min` : `Fylls på om ${minutes} min`),
    viewHistory: "Öppna Historik",
    totalTitle: "Dina gratis skanningar är använda",
    totalBody: "Du har använt alla 20 gratis skanningar. Välj en plan för att fortsätta. Allt du värderat finns sparat i Historik.",
    monthTitle: "Månadens skanningar är använda",
    monthBody: "Din plan fylls på i början av nästa månad. Allt du värderat finns sparat i Historik.",
    dayTitle: "Dagens skanningar är använda",
    dayBody: "Planens dagskvot fylls på i morgon. Allt du värderat finns sparat i Historik.",
  },
  account: {
    open: "Logga in",
    title: "Logga in",
    sub: "Så följer din plan med dig.",
    apple: "Fortsätt med Apple",
    google: "Fortsätt med Google",
    email: "Skicka en länk till min e-post",
    emailPlaceholder: "E-postadress",
    sent: "Kolla din inkorg och öppna länken.",
    error: "Det gick inte. Försök igen om en stund.",
    signedIn: "Inloggad. Din plan följer med.",
  },
  plans: {
    eyebrow: "Plan",
    title: "Välj plan",
    sub: "Byt eller avsluta när du vill.",
    rowMonth: "Per månad",
    rowTotal: "Totalt, en gång",
    rowDay: "Per dag",
    scans: (n) => `${n} skanningar`,
    select: (name) => `Välj ${name}`,
    keep: "Din plan",
    hint: "Tryck på Pro, Premium eller Business för att välja.",
    free: "Gratis",
    monthly: "Månadsvis",
    yearly: "Årsvis",
    save: (pct) => `Spara ${pct}\u00a0%`,
    perMonth: "/ mån",
    perYear: "/ år",
    billedYearly: (price) => `Faktureras ${price} per år`,
    scansMonth: (n) => `${n} skanningar i månaden`,
    scansDay: (n) => `Upp till ${n} per dag`,
    noDayCap: "Ingen dagsgräns",
    names: { free: "Gratis", pro: "Pro", premium: "Premium", business: "Business" },
    current: "Din plan",
    choose: (name) => `Välj ${name}`,
    comingSoon: "Betalning öppnar snart.",
    openPlans: "Se planer",
    manage: "Hantera prenumeration",
    footnote: "Priserna inkluderar moms. Värdet är en uppskattning.",
    fxNote: (code) => `Debiteras i SEK. Belopp i ${code} är en uppskattning efter dagens kurs.`,
  },
  app: {
    welcomeTag: "Värdera vad som helst, direkt.",
    scanSub: "Det tar några sekunder.",
    scanCopy: ["Tittar på föremålet…", "Läser detaljerna…", "Kollar aktuella priser…", "Väger ihop allt…"],
    nav: { scan: "Skanna", upload: "Ladda upp", history: "Historik", plans: "Planer", info: "Info", restart: "Börja om" },
    dismiss: "Stäng",
    scanning: "Skannar",
    infoTitle: "Om Valy",
    info1: "Valy värderar vad som helst på några sekunder.",
    info2: "Du får ett värde baserat på aktuell\u00a0marknadsdata, tillsammans med ett rimligt prisspann. Använd Valy till allt från en pryl du vill sälja till att se vad dina saker är värda.",
    info3: "Värdet är en uppskattning, inte en officiell värdering. Dyrbara föremål bör bedömas av en expert.",
  },
  errors: {
    loadHistory: "Det gick inte att hämta historiken.",
    readPhoto: "Det gick inte att läsa fotot.",
    save: "Det gick inte att spara värderingen.",
    generic: "Något gick fel.",
    deleteOne: "Det gick inte att ta bort värderingen.",
    clearAll: "Det gick inte att rensa historiken.",
    notConnected: "Appen är inte ansluten till sin server än.",
    session: "Det gick inte att starta din privata session. Kontrollera anslutningen och försök igen.",
    unreachable: "Det gick inte att nå värderingstjänsten. Kontrollera din anslutning och försök igen.",
    failedStatus: (status) => `Värderingen misslyckades (${status}).`,
    unexpected: "Värderingstjänsten gav ett oväntat svar.",
    needsPhoto: "Vi kunde inte känna igen föremålet. Prova ett tydligare foto.",
    tooSlow: "Värderingen tog för lång tid. Försök igen.",
    tryClearer: "Prova ett tydligare foto av föremålet.",
  },
  camera: {
    frameEmpty: "Kamerabilden var tom.",
    previewFailed: "Det gick inte att visa kamerabilden.",
    unsupported: "Webbläsaren kan inte öppna kameran. Ladda upp ett foto i stället.",
    blocked: "Kameran är blockerad. Ladda upp ett foto i stället.",
    couldNotOpen: "Det gick inte att öppna kameran. Ladda upp ett foto i stället.",
    notReady: "Kameran var inte redo. Försök igen.",
    couldNotCapture: "Det gick inte att ta fotot.",
    couldNotTake: "Det gick inte att ta fotot.",
    open: "Öppna kameran",
    thenShutter: "Tryck sedan på avtryckaren",
    uploadPhoto: "Ladda upp ett foto",
    uploadAlt: "Ladda upp en bild",
    opening: "Öppnar kameran…",
    center: "Centrera föremålet",
    close: "Stäng kameran",
    takePhoto: "Ta foto",
  },
  foreignData: {
    regional: (where) => `En del av jämförelsepriserna kommer från närliggande marknader (${where}), så spannet är lite bredare.`,
    global: (where) => `Vi hittade få jämförbara försäljningar i ditt land, så försäljningar från ${where} har använts och spannet är bredare.`,
    adjusted: "Priserna har justerats mot din lokala prisnivå.",
    otherMarkets: "andra marknader",
    nearbyMarkets: "närliggande marknader",
    genericRegional: "närliggande länder",
    genericGlobal: "andra marknader",
    and: "och",
  },
  historyBasis: {
    regional: "Delvis baserad på närliggande marknader",
    global: "Delvis baserad på andra marknader",
  },
  listingFrom: (country) => `Annonserad i ${country}`,
  madeFor: (country) => `Värderad för ${country}`,
  drivers: {
    model_only: "Vi hittade få jämförbara försäljningar, så värderingen bygger mest på fotot.",
    few_comparables: "Vi hittade bara ett fåtal jämförbara försäljningar.",
    sources_disagree: "Fotot och marknaden pekar på något olika priser.",
    judge_disagreement: "Några kontroller av annonserna stämde inte med första bedömningen, så spannet är bredare.",
    mostly_asking_prices: "De flesta jämförelsepriser är annonspriser, inte slutpriser.",
    rarity: "Sällsynta föremål kan gå för väldigt olika priser.",
    unclear_condition: "Det är svårt att bedöma skicket utifrån fotot.",
    authenticity: "Äktheten är svår att bekräfta utifrån fotot, så spannet blir bredare nedåt.",
    identity: "Vi är inte säkra på exakt vilken modell det är.",
  },
  // English label sent by an older engine -> Swedish. The new engine already answers in Swedish.
  factorLabels: {
    Item: "Föremål",
    Condition: "Skick",
    Details: "Detaljer",
    Market: "Marknad",
    Why: "Därför",
    Uncertain: "Osäkert",
    "To improve accuracy": "För bättre träffsäkerhet",
    Authenticity: "Äkthet",
    Checked: "Kontrollerat",
    Memory: "Minne",
    "Exchange rate": "Växelkurs",
  },
};

const ALL: Record<Lang, Texts> = { en, sv };

/** All texts for a language. */
export function textsFor(lang: Lang): Texts {
  return ALL[lang];
}

/** The texts of the phone's language. In Node (tests) there is no phone: English. */
export const TEXTS: Texts = textsFor(currentLang());

/** The sentences for the drivers the valuation engine sent, in its order, at most two. */
export function driverSentences(codes: readonly string[] | undefined, texts: Texts = TEXTS): string[] {
  if (!codes) return [];
  return codes.map((c) => texts.drivers[c]).filter((s): s is string => typeof s === "string").slice(0, 2);
}
