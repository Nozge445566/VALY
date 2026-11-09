// Country knowledge used to aim searches: the main language of a market and its biggest
// resale and trading marketplaces. This is the same table the Search AI uses
// (search-ai/searchai/markets.json); a test keeps the two in step.

export const COUNTRY_LANGUAGE: Record<string, string> = {
  SE: "sv", NO: "no", DK: "da", FI: "fi", IS: "is",
  DE: "de", AT: "de", CH: "de", FR: "fr", BE: "nl", NL: "nl", LU: "fr",
  ES: "es", PT: "pt", IT: "it", PL: "pl", CZ: "cs", HU: "hu", RO: "ro", GR: "el", TR: "tr",
  GB: "en", IE: "en", US: "en", CA: "en", AU: "en", NZ: "en", ZA: "en", IN: "en", SG: "en", HK: "en",
  MX: "es", AR: "es", CL: "es", CO: "es", BR: "pt",
  JP: "ja", KR: "ko", CN: "zh-cn", TW: "zh-tw", TH: "th", ID: "id", MY: "en", VN: "vi", PH: "en",
  AE: "en", SA: "ar", IL: "he", UA: "uk", RU: "ru",
};

/** Biggest resale and trading marketplaces per country, best first. */
export const MARKETPLACES: Record<string, string[]> = {
  SE: ["tradera.com", "blocket.se", "ebay.se"],
  NO: ["finn.no", "ebay.no"],
  DK: ["dba.dk", "ebay.dk"],
  FI: ["tori.fi", "huuto.net"],
  DE: ["ebay.de", "kleinanzeigen.de"],
  AT: ["willhaben.at", "ebay.at"],
  CH: ["ricardo.ch", "ebay.ch"],
  FR: ["leboncoin.fr", "ebay.fr"],
  BE: ["2dehands.be", "ebay.be"],
  NL: ["marktplaats.nl", "ebay.nl"],
  ES: ["wallapop.com", "ebay.es"],
  PT: ["olx.pt", "ebay.com"],
  IT: ["subito.it", "ebay.it"],
  PL: ["allegro.pl", "olx.pl"],
  CZ: ["bazos.cz", "aukro.cz"],
  GB: ["ebay.co.uk", "gumtree.com"],
  IE: ["donedeal.ie", "ebay.ie"],
  US: ["ebay.com", "offerup.com"],
  CA: ["ebay.ca", "kijiji.ca"],
  AU: ["ebay.com.au", "gumtree.com.au"],
  NZ: ["trademe.co.nz", "ebay.com.au"],
  JP: ["auctions.yahoo.co.jp", "mercari.com"],
  KR: ["bunjang.co.kr", "ebay.com"],
  BR: ["mercadolivre.com.br", "olx.com.br"],
  MX: ["mercadolibre.com.mx", "ebay.com.mx"],
  IN: ["olx.in", "ebay.in"],
  SG: ["carousell.sg", "ebay.com.sg"],
  HK: ["carousell.com.hk", "ebay.com.hk"],
  TW: ["ruten.com.tw", "carousell.com"],
  TH: ["facebook.com/marketplace", "ebay.com"],
};

/** The leading specialist site for a kind of item, matched against the item category and type. */
export const SPECIALISTS: { match: RegExp; site: string }[] = [
  { match: /\b(watch|watches|wristwatch|chronograph)\b/i, site: "chrono24.com" },
  { match: /\b(guitar|bass|amp|amplifier|synth|synthesizer|drum|pedal|instrument|keyboard)\b/i, site: "reverb.com" },
  { match: /\b(sneaker|sneakers|trainer|trainers|shoe|shoes)\b/i, site: "stockx.com" },
  { match: /\b(camera|lens|dslr|mirrorless)\b/i, site: "mpb.com" },
  { match: /\b(car|vehicle|motorcycle|truck|automobile)\b/i, site: "bringatrailer.com" },
  { match: /\b(phone|smartphone|laptop|tablet|console)\b/i, site: "swappa.com" },
  { match: /\b(book|books|manuscript|map)\b/i, site: "abebooks.com" },
  { match: /\b(art|painting|print|sculpture|antique|antiques|furniture|ceramic|porcelain|silver)\b/i, site: "invaluable.com" },
  { match: /\b(lego|minifigure|brick)\b/i, site: "bricklink.com" },
  { match: /\b(video game|videogame|game cartridge|retro game)\b/i, site: "pricecharting.com" },
  { match: /\b(vinyl|record|lp)\b/i, site: "discogs.com" },
  { match: /\b(handbag|bag|jacket|coat|dress|designer|fashion|clothing)\b/i, site: "vestiairecollective.com" },
  { match: /\b(coin|coins|banknote|medal)\b/i, site: "numista.com" },
];

export function languageOf(country: string | null): string {
  return (country && COUNTRY_LANGUAGE[country.toUpperCase()]) || "en";
}

export function specialistFor(text: string): string | null {
  for (const s of SPECIALISTS) if (s.match.test(text)) return s.site;
  return null;
}
