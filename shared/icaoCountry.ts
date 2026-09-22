// shared/icaoCountry.ts
const ISO2 = /^[a-z]{2}$/i
const REGIONAL_A = 0x1f1e6 // REGIONAL INDICATOR SYMBOL LETTER A

/** Flag emoji for an ISO 3166-1 alpha-2 code ('IL' → 🇮🇱); '' for anything that is not two ASCII letters. */
export function flagEmoji(iso2: string): string {
  if (!ISO2.test(iso2)) return ''
  const u = iso2.toUpperCase()
  return String.fromCodePoint(REGIONAL_A + u.charCodeAt(0) - 65, REGIONAL_A + u.charCodeAt(1) - 65)
}
