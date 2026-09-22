# WP-B-C1 — Country from ICAO Address Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `countryOf(hex)` gives the State of Registry for a 24-bit ICAO aircraft address, e.g. `503fc4` → `{ iso2: 'LT', name: 'Lithuania' }` and `738a1c` → `{ iso2: 'IL', name: 'Israel' }`. `flagEmoji(iso2)` turns the code into a flag (`'IL'` → 🇮🇱). B-A composes the two into `flagOf(hex)` for the table and into `Lookup.country` for the detail panel ("Reg. + country flag and name", as tar1090 shows).

**Architecture:** One module, `shared/icaoCountry.ts`, with no imports.
- `BLOCKS` is a sorted array of `[start, end, iso2, name]` rows: 193 State blocks from ICAO Annex 10 Vol III Table 9-1 (Amendment 92) plus one de facto row for Taiwan. The rows are sorted by first address and never overlap.
- `countryOf` accepts exactly six hex digits in either case. Anything else returns `null` without a search: readsb's `~`-prefixed non-ICAO addresses (TIS-B/ADS-R/anonymous), empty or short strings, whitespace, `0x`. It parses the digits with `parseInt(hex, 16)` and binary-searches `BLOCKS` (at most 8 probes). Addresses in no block return `null`: the unallocated ranges and the regional reserves, the ICAO1 temporary-address block `F00000–F07FFF`, and the ICAO2 special-use block `F09000–F097FF`.
- No allocation per call. One frozen `{ iso2, name }` per block is built at module load, and `countryOf` returns that shared object. Callers must not mutate it; it is frozen, so a mutation fails loudly in strict mode.
- `flagEmoji` checks for two ASCII letters in either case and returns the two regional-indicator symbols (U+1F1E6 + letter − 'A'). Anything else returns `''`.
- What the table cannot tell (a `ponytail:` comment in the file): the address gives only the State that ICAO allocated the block to. National sub-allocations are not modelled, so Hong Kong and Macao aircraft show as China. A transponder with a wrong address shows a wrong country. The upgrade path is the registration from a per-hex aircraft database, when there is one.

**Data source and licence:**
- Primary source: ICAO Annex 10, Volume III, Part I, Chapter 9, Table 9-1 "Allocation of aircraft addresses to States", 2nd edition (July 2007) incorporating **Amendment 92 (28/11/24)**. It was read from the copy published by the Swiss Federal Office of Civil Aviation (FOCA/BAZL): https://www.bazl.admin.ch/dam/en/sd-web/QQ3WlrAoWJRb/icao_annex_10_aeronauticaltelecommunicationsvolumeiii-communicat.pdf (Table 9-1 on pages I-9-6 to I-9-10).
- How the table was made: each State's printed bit pattern (MSB first; a dash means "any bit") was converted to its hex range by a script. The script also checked the block-size column (the asterisk) against the length of the fixed prefix. All 195 rows that have an asterisk agree. Comoros is the one row with no asterisk; its 13-bit pattern gives 2 048 addresses.
- The Amendment 92 edition differs from the older copies below in these ways (some changes may date from earlier amendments):
  - Every former 1 024-address block now has 2 048 addresses. Seven blocks used to be the upper quarter of a 4 096 range (pattern ending `11`): Croatia, Latvia, Lithuania, Moldova, Slovakia, Slovenia and Uzbekistan. For these the start moves down by `0x400`, so Lithuania is now `503800–503FFF`, not `503C00–503FFF`.
  - Colombia's block grew to 8 192 addresses and Qatar's to 4 096.
  - New States: Andorra, Dominica, Saint Kitts and Nevis, South Sudan, Timor-Leste and Tuvalu (`C91000…C977FF`), and Montenegro (`516000`).
  - Yugoslavia's block `4C0000–4C7FFF` is now Serbia's.
  - Renamed States: Czechia, Eswatini, North Macedonia, Türkiye, Cabo Verde.
- Cross-check against two independent transcriptions of older editions:
  - ATDB, http://www.aerotransport.org/html/ICAO_hex_decode.html (201 rows).
  - kloth.net, https://www.kloth.net/radio/icao24alloc.php (Annex 10 text with Yugoslavia, 189 rows).
  - Result: every kloth.net block lies inside this table's block for the same State. 123 are identical and 63 are enlarged in the current edition. The only exceptions are the two ICAO blocks, which here return `null`, and ICAO2 `899xxx`, which here is Taiwan. Every ATDB difference is one of the changes above or a renamed State. There are no conflicts.
- The Taiwan row: `899000–8997FF` is the ICAO2 block "allocated for special use in the interest of flight safety". It is used by Taiwan-registered aircraft, and ATDB lists it as "Taiwan (unofficial)". It is the only row that is not a State allocation, and a comment in the file marks it.
- Licence: the address blocks are facts published by ICAO and were transcribed from the Annex. The ISO 3166-1 alpha-2 codes and the short English display names are ours. The test checks every code against `Intl.DisplayNames`. Nothing was copied from tar1090, dump1090, readsb or any other GPL source.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only). ES2020 `Intl.DisplayNames` is used only in the test. There are no new dependencies.

**Wave:** B (parallel with the other B-* packages after B0). It imports nothing from B0 or any other package. It is consumed by B-A, which builds `flagOf(hex) = flagEmoji(countryOf(hex)?.iso2 ?? '')` and `Lookup.country` (the `countryOf(hex)` result plus its `flag`, or `null`). **Estimated:** 45 min. **Validated:** on 2026-09-22 in the integrated tree (all 27 WPs + V4 mouse orbit + B0; Node 25.2.1, TypeScript 7.0.2):
- `node --test shared/icaoCountry.test.ts` → 12/12 pass. `npx tsc --noEmit 2>&1 | grep -E 'shared/icaoCountry'` prints nothing. All 66 `shared/**/*.test.ts` tests pass.
- Task-by-task replay in an isolated directory that held only this package's files (`node_modules` linked, `tsconfig` limited to `shared`): Task 1 failed with `ERR_MODULE_NOT_FOUND`, then passed 2/2 with tsc clean. Task 2 failed with `does not provide an export named 'BLOCKS'`, then passed 12/12 with tsc clean.
- Mutations, each caught:
  - Lithuania with its old 1 024 block → 2 tests fail.
  - `>=` for `>` in the binary search → 3 fail.
  - Two rows swapped → 1 fails.
  - Israel coded `IS` → 2 fail.
  - The hex regex unanchored → 1 fails.
- Speed: `countryOf` takes about 100–110 ns per lookup over 1,000,000 random addresses. Composing `flagEmoji(countryOf(hex)?.iso2 ?? '')` for 12,000 aircraft (the worldwide count tar1090 shows) takes 2.5–3.3 ms. The table (B-U1) needs it only for its rendered rows, at most once a second.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- Tests never touch the network. The table is committed in the source. The only network use was the read-only research above (FOCA PDF, ATDB, kloth.net). Nothing here ever contacts adsb.lol.
- File ownership: this package writes only the two files below.
- `shared/icaoCountry.ts` is 11.6 KB, well under the 200 KB asset threshold, so it is inline in Task 2 and nothing goes to `plans/assets/`.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `shared/icaoCountry.ts` | `BLOCKS` (Annex 10 Table 9-1, Amendment 92, 194 rows), `type Block`, `countryOf`, `flagEmoji` |
| `shared/icaoCountry.test.ts` | flag encoding; the contract cases (503FC4, IL, US, GB, DE, AT, 000001, `~a330e6`); block edges and neighbours; Amendment 92 blocks; Taiwan; null cases; shared result objects; table integrity (sorted, no overlap, Annex block sizes and alignment, one block per State, ISO codes known to `Intl`) |

---

### Task 1: Flag emoji

**Files:**
- Create: `shared/icaoCountry.ts`, `shared/icaoCountry.test.ts`
- Test: `shared/icaoCountry.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `flagEmoji(iso2: string): string` (regional-indicator pair; `''` unless `iso2` is two ASCII letters, either case)

- [ ] **Step 1: Write the failing test**

```ts
// shared/icaoCountry.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flagEmoji } from './icaoCountry.ts'

test('flagEmoji: two regional-indicator symbols, case-insensitive', () => {
  assert.equal(flagEmoji('IL'), '\u{1F1EE}\u{1F1F1}')
  assert.equal(flagEmoji('lt'), '\u{1F1F1}\u{1F1F9}')
  assert.equal(flagEmoji('US'), '🇺🇸')
})

test('flagEmoji: anything but two ASCII letters → empty string', () => {
  for (const s of ['', 'I', 'ISR', '1A', 'I-', ' IL', 'É1']) assert.equal(flagEmoji(s), '', JSON.stringify(s))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test shared/icaoCountry.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/shared/icaoCountry.ts' imported from …/shared/icaoCountry.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// shared/icaoCountry.ts
const ISO2 = /^[a-z]{2}$/i
const REGIONAL_A = 0x1f1e6 // REGIONAL INDICATOR SYMBOL LETTER A

/** Flag emoji for an ISO 3166-1 alpha-2 code ('IL' → 🇮🇱); '' for anything that is not two ASCII letters. */
export function flagEmoji(iso2: string): string {
  if (!ISO2.test(iso2)) return ''
  const u = iso2.toUpperCase()
  return String.fromCodePoint(REGIONAL_A + u.charCodeAt(0) - 65, REGIONAL_A + u.charCodeAt(1) - 65)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test shared/icaoCountry.test.ts`
Expected: PASS — `ℹ tests 2`, `ℹ pass 2`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add shared/icaoCountry.ts shared/icaoCountry.test.ts
git commit -m "feat(shared): flag emoji from an ISO 3166-1 code" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Country from the ICAO address (Annex 10 Table 9-1)

**Files:**
- Modify: `shared/icaoCountry.ts`, `shared/icaoCountry.test.ts` (both replaced by the complete contents below; the two `flagEmoji` tests and the `flagEmoji` code are unchanged)
- Test: `shared/icaoCountry.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `countryOf(hex: string): { iso2: string; name: string } | null` (PLAN.md §5.3). It returns the same frozen object for every address in a block.
  - `type Block = readonly [start: number, end: number, iso2: string, name: string]` (extra export).
  - `BLOCKS: readonly Block[]` (extra export; sorted, non-overlapping).
  - `flagEmoji` is unchanged.

- [ ] **Step 1: Write the failing test** (replaces the Task 1 file)

```ts
// shared/icaoCountry.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCKS, countryOf, flagEmoji } from './icaoCountry.ts'

const hex = (n: number): string => n.toString(16).padStart(6, '0')
const iso = (h: string): string | null => countryOf(h)?.iso2 ?? null

test('flagEmoji: two regional-indicator symbols, case-insensitive', () => {
  assert.equal(flagEmoji('IL'), '\u{1F1EE}\u{1F1F1}')
  assert.equal(flagEmoji('lt'), '\u{1F1F1}\u{1F1F9}')
  assert.equal(flagEmoji('US'), '🇺🇸')
})

test('flagEmoji: anything but two ASCII letters → empty string', () => {
  for (const s of ['', 'I', 'ISR', '1A', 'I-', ' IL', 'É1']) assert.equal(flagEmoji(s), '', JSON.stringify(s))
})

test('countryOf: 503FC4 → Lithuania, either case', () => {
  assert.deepEqual(countryOf('503FC4'), { iso2: 'LT', name: 'Lithuania' })
  assert.deepEqual(countryOf('503fc4'), { iso2: 'LT', name: 'Lithuania' })
})

test('countryOf: whole blocks from end to end, names', () => {
  const cases: [number, number, string, string][] = [
    [0x738000, 0x73ffff, 'IL', 'Israel'],
    [0xa00000, 0xafffff, 'US', 'United States'],
    [0x400000, 0x43ffff, 'GB', 'United Kingdom'],
    [0x3c0000, 0x3fffff, 'DE', 'Germany'],
    [0x440000, 0x447fff, 'AT', 'Austria'],
  ]
  for (const [lo, hi, code, name] of cases) {
    for (const a of [lo, lo + 1, (lo + hi) >> 1, hi - 1, hi]) assert.deepEqual(countryOf(hex(a)), { iso2: code, name }, hex(a))
  }
})

test('countryOf: the addresses just outside those blocks belong to the neighbours (or nobody)', () => {
  assert.equal(iso('737fff'), 'IR')
  assert.equal(iso('740000'), 'JO')
  assert.equal(iso('3bffff'), 'FR')
  assert.equal(iso('448000'), 'BE')
  assert.equal(iso('9fffff'), null)
  assert.equal(iso('b00000'), null)
})

test('countryOf: Amendment 92 blocks (2 048-address blocks, Colombia 8 192, Qatar 4 096, new States)', () => {
  assert.equal(iso('501800'), 'HR')   // Croatia: 501800–501FFF (was 501C00 before the blocks were doubled)
  assert.equal(iso('5017ff'), 'AL')   // Albania: 501000–5017FF
  assert.equal(iso('0adfff'), 'CO')
  assert.equal(iso('06afff'), 'QA')
  assert.equal(iso('4c0000'), 'RS')
  assert.equal(iso('516000'), 'ME')
  assert.equal(iso('c94000'), 'SS')
  assert.equal(iso('c977ff'), 'TV')
})

test('countryOf: 899xxx (ICAO special-use block) → Taiwan, de facto', () => {
  assert.deepEqual(countryOf('8990a5'), { iso2: 'TW', name: 'Taiwan' })
})

test('countryOf: unallocated, ICAO-administered, non-ICAO and malformed addresses → null', () => {
  for (const s of ['000001', '000000', '003fff', 'ffffff', 'f00001', 'f09000', '~a330e6', '~503fc4', '', '503fc', '503fc4a', 'zzzzzz', ' 503fc4', '0x503f']) {
    assert.equal(countryOf(s), null, JSON.stringify(s))
  }
})

test('countryOf: returns one shared object per block (no allocation per call)', () => {
  assert.equal(countryOf('503fc4'), countryOf('503800'))
  assert.ok(Object.isFrozen(countryOf('503fc4')))
})

test('BLOCKS: sorted by start and never overlapping', () => {
  for (let i = 1; i < BLOCKS.length; i++) {
    assert.ok(BLOCKS[i - 1][1] < BLOCKS[i][0], `${hex(BLOCKS[i - 1][0])} overlaps ${hex(BLOCKS[i][0])}`)
  }
})

test('BLOCKS: every block has an Annex 10 size and is aligned to it', () => {
  const sizes = new Set([2048, 4096, 8192, 32768, 262144, 1048576])
  for (const [start, end] of BLOCKS) {
    const n = end - start + 1
    assert.ok(sizes.has(n), `${hex(start)}: ${n} addresses`)
    assert.equal(start % n, 0, `${hex(start)} not aligned to ${n}`)
  }
})

test('BLOCKS: 193 States + Taiwan, one block each, ISO 3166-1 codes that Intl knows', () => {
  const regions = new Intl.DisplayNames(['en'], { type: 'region' })
  const seen = new Set<string>()
  for (const [, , iso2, name] of BLOCKS) {
    assert.match(iso2, /^[A-Z]{2}$/)
    assert.ok(!seen.has(iso2), `duplicate ${iso2}`)
    seen.add(iso2)
    const known = regions.of(iso2)
    assert.ok(known !== iso2 && known !== 'Unknown Region', `${iso2} is not an ISO 3166-1 region`)
    assert.ok(name.length > 1)
  }
  assert.equal(BLOCKS.length, 194)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test shared/icaoCountry.test.ts`
Expected: FAIL — `SyntaxError: The requested module './icaoCountry.ts' does not provide an export named 'BLOCKS'` (`ℹ tests 1`, `ℹ fail 1`).

- [ ] **Step 3: Write the implementation** (replaces the Task 1 file)

The rows are Table 9-1 of Annex 10 Vol III (Amendment 92) in address order, converted from the printed bit patterns (see **Data source and licence**). Copy them exactly; the integrity tests catch overlaps, misordered rows, wrong block sizes, misaligned starts, duplicate or unknown ISO codes, and a wrong row count.

```ts
// shared/icaoCountry.ts
/**
 * Country of registration from a 24-bit ICAO aircraft address (the Mode S "hex").
 *
 * Source: ICAO Annex 10, Volume III, Part I, Chapter 9, Table 9-1 "Allocation of aircraft addresses to States",
 * 2nd edition (July 2007) incorporating Amendment 92 (28/11/24), in the copy published by the Swiss FOCA:
 * https://www.bazl.admin.ch/dam/en/sd-web/QQ3WlrAoWJRb/icao_annex_10_aeronauticaltelecommunicationsvolumeiii-communicat.pdf
 * Each State's bit pattern was converted to its hex range (193 States). Compared with older copies, this edition gives
 * every former 1 024-address block 2 048 addresses, Colombia 8 192 and Qatar 4 096, and it lists Andorra, Dominica,
 * Montenegro, Saint Kitts and Nevis, Serbia (the former Yugoslavia block), South Sudan, Timor-Leste and Tuvalu.
 * Cross-checked against two independent transcriptions of older editions: ATDB
 * (http://www.aerotransport.org/html/ICAO_hex_decode.html) and kloth.net (https://www.kloth.net/radio/icao24alloc.php).
 * Every difference is one of the changes above or a renamed State.
 * The address blocks are facts published by ICAO. The ISO 3166-1 codes and the short English names are ours.
 * Nothing here is taken from tar1090 or dump1090.
 *
 * One row is not a State allocation: the ICAO2 "special use in the interest of flight safety" block 899000–8997FF is
 * used by Taiwan-registered aircraft (ATDB lists it as "Taiwan (unofficial)"), so it maps to TW. The other ICAO blocks
 * (F00000–F07FFF temporary addresses, F09000–F097FF special use) and every unallocated range return null.
 *
 * ponytail: the address gives the State of Registry from ICAO's allocation only. National sub-allocations are not
 * modelled (Hong Kong and Macao aircraft show as China), nor are misconfigured transponders. The upgrade path is a
 * per-hex registry database (e.g. the registration from the aircraft record) when one is available.
 */

/** [first address, last address, ISO 3166-1 alpha-2, short English name], sorted by first address, never overlapping. */
export type Block = readonly [start: number, end: number, iso2: string, name: string]

export const BLOCKS: readonly Block[] = [
  [0x004000, 0x0047FF, 'ZW', 'Zimbabwe'],
  [0x006000, 0x006FFF, 'MZ', 'Mozambique'],
  [0x008000, 0x00FFFF, 'ZA', 'South Africa'],
  [0x010000, 0x017FFF, 'EG', 'Egypt'],
  [0x018000, 0x01FFFF, 'LY', 'Libya'],
  [0x020000, 0x027FFF, 'MA', 'Morocco'],
  [0x028000, 0x02FFFF, 'TN', 'Tunisia'],
  [0x030000, 0x0307FF, 'BW', 'Botswana'],
  [0x032000, 0x032FFF, 'BI', 'Burundi'],
  [0x034000, 0x034FFF, 'CM', 'Cameroon'],
  [0x035000, 0x0357FF, 'KM', 'Comoros'],
  [0x036000, 0x036FFF, 'CG', 'Congo'],
  [0x038000, 0x038FFF, 'CI', 'Côte d’Ivoire'],
  [0x03E000, 0x03EFFF, 'GA', 'Gabon'],
  [0x040000, 0x040FFF, 'ET', 'Ethiopia'],
  [0x042000, 0x042FFF, 'GQ', 'Equatorial Guinea'],
  [0x044000, 0x044FFF, 'GH', 'Ghana'],
  [0x046000, 0x046FFF, 'GN', 'Guinea'],
  [0x048000, 0x0487FF, 'GW', 'Guinea-Bissau'],
  [0x04A000, 0x04A7FF, 'LS', 'Lesotho'],
  [0x04C000, 0x04CFFF, 'KE', 'Kenya'],
  [0x050000, 0x050FFF, 'LR', 'Liberia'],
  [0x054000, 0x054FFF, 'MG', 'Madagascar'],
  [0x058000, 0x058FFF, 'MW', 'Malawi'],
  [0x05A000, 0x05A7FF, 'MV', 'Maldives'],
  [0x05C000, 0x05CFFF, 'ML', 'Mali'],
  [0x05E000, 0x05E7FF, 'MR', 'Mauritania'],
  [0x060000, 0x0607FF, 'MU', 'Mauritius'],
  [0x062000, 0x062FFF, 'NE', 'Niger'],
  [0x064000, 0x064FFF, 'NG', 'Nigeria'],
  [0x068000, 0x068FFF, 'UG', 'Uganda'],
  [0x06A000, 0x06AFFF, 'QA', 'Qatar'],
  [0x06C000, 0x06CFFF, 'CF', 'Central African Republic'],
  [0x06E000, 0x06EFFF, 'RW', 'Rwanda'],
  [0x070000, 0x070FFF, 'SN', 'Senegal'],
  [0x074000, 0x0747FF, 'SC', 'Seychelles'],
  [0x076000, 0x0767FF, 'SL', 'Sierra Leone'],
  [0x078000, 0x078FFF, 'SO', 'Somalia'],
  [0x07A000, 0x07A7FF, 'SZ', 'Eswatini'],
  [0x07C000, 0x07CFFF, 'SD', 'Sudan'],
  [0x080000, 0x080FFF, 'TZ', 'Tanzania'],
  [0x084000, 0x084FFF, 'TD', 'Chad'],
  [0x088000, 0x088FFF, 'TG', 'Togo'],
  [0x08A000, 0x08AFFF, 'ZM', 'Zambia'],
  [0x08C000, 0x08CFFF, 'CD', 'DR Congo'],
  [0x090000, 0x090FFF, 'AO', 'Angola'],
  [0x094000, 0x0947FF, 'BJ', 'Benin'],
  [0x096000, 0x0967FF, 'CV', 'Cabo Verde'],
  [0x098000, 0x0987FF, 'DJ', 'Djibouti'],
  [0x09A000, 0x09AFFF, 'GM', 'Gambia'],
  [0x09C000, 0x09CFFF, 'BF', 'Burkina Faso'],
  [0x09E000, 0x09E7FF, 'ST', 'Sao Tome and Principe'],
  [0x0A0000, 0x0A7FFF, 'DZ', 'Algeria'],
  [0x0A8000, 0x0A8FFF, 'BS', 'Bahamas'],
  [0x0AA000, 0x0AA7FF, 'BB', 'Barbados'],
  [0x0AB000, 0x0AB7FF, 'BZ', 'Belize'],
  [0x0AC000, 0x0ADFFF, 'CO', 'Colombia'],
  [0x0AE000, 0x0AEFFF, 'CR', 'Costa Rica'],
  [0x0B0000, 0x0B0FFF, 'CU', 'Cuba'],
  [0x0B2000, 0x0B2FFF, 'SV', 'El Salvador'],
  [0x0B4000, 0x0B4FFF, 'GT', 'Guatemala'],
  [0x0B6000, 0x0B6FFF, 'GY', 'Guyana'],
  [0x0B8000, 0x0B8FFF, 'HT', 'Haiti'],
  [0x0BA000, 0x0BAFFF, 'HN', 'Honduras'],
  [0x0BC000, 0x0BC7FF, 'VC', 'Saint Vincent and the Grenadines'],
  [0x0BE000, 0x0BEFFF, 'JM', 'Jamaica'],
  [0x0C0000, 0x0C0FFF, 'NI', 'Nicaragua'],
  [0x0C2000, 0x0C2FFF, 'PA', 'Panama'],
  [0x0C4000, 0x0C4FFF, 'DO', 'Dominican Republic'],
  [0x0C6000, 0x0C6FFF, 'TT', 'Trinidad and Tobago'],
  [0x0C8000, 0x0C8FFF, 'SR', 'Suriname'],
  [0x0CA000, 0x0CA7FF, 'AG', 'Antigua and Barbuda'],
  [0x0CC000, 0x0CC7FF, 'GD', 'Grenada'],
  [0x0D0000, 0x0D7FFF, 'MX', 'Mexico'],
  [0x0D8000, 0x0DFFFF, 'VE', 'Venezuela'],
  [0x100000, 0x1FFFFF, 'RU', 'Russia'],
  [0x201000, 0x2017FF, 'NA', 'Namibia'],
  [0x202000, 0x2027FF, 'ER', 'Eritrea'],
  [0x300000, 0x33FFFF, 'IT', 'Italy'],
  [0x340000, 0x37FFFF, 'ES', 'Spain'],
  [0x380000, 0x3BFFFF, 'FR', 'France'],
  [0x3C0000, 0x3FFFFF, 'DE', 'Germany'],
  [0x400000, 0x43FFFF, 'GB', 'United Kingdom'],
  [0x440000, 0x447FFF, 'AT', 'Austria'],
  [0x448000, 0x44FFFF, 'BE', 'Belgium'],
  [0x450000, 0x457FFF, 'BG', 'Bulgaria'],
  [0x458000, 0x45FFFF, 'DK', 'Denmark'],
  [0x460000, 0x467FFF, 'FI', 'Finland'],
  [0x468000, 0x46FFFF, 'GR', 'Greece'],
  [0x470000, 0x477FFF, 'HU', 'Hungary'],
  [0x478000, 0x47FFFF, 'NO', 'Norway'],
  [0x480000, 0x487FFF, 'NL', 'Netherlands'],
  [0x488000, 0x48FFFF, 'PL', 'Poland'],
  [0x490000, 0x497FFF, 'PT', 'Portugal'],
  [0x498000, 0x49FFFF, 'CZ', 'Czechia'],
  [0x4A0000, 0x4A7FFF, 'RO', 'Romania'],
  [0x4A8000, 0x4AFFFF, 'SE', 'Sweden'],
  [0x4B0000, 0x4B7FFF, 'CH', 'Switzerland'],
  [0x4B8000, 0x4BFFFF, 'TR', 'Türkiye'],
  [0x4C0000, 0x4C7FFF, 'RS', 'Serbia'],
  [0x4C8000, 0x4C87FF, 'CY', 'Cyprus'],
  [0x4CA000, 0x4CAFFF, 'IE', 'Ireland'],
  [0x4CC000, 0x4CCFFF, 'IS', 'Iceland'],
  [0x4D0000, 0x4D07FF, 'LU', 'Luxembourg'],
  [0x4D2000, 0x4D27FF, 'MT', 'Malta'],
  [0x4D4000, 0x4D47FF, 'MC', 'Monaco'],
  [0x500000, 0x5007FF, 'SM', 'San Marino'],
  [0x501000, 0x5017FF, 'AL', 'Albania'],
  [0x501800, 0x501FFF, 'HR', 'Croatia'],
  [0x502800, 0x502FFF, 'LV', 'Latvia'],
  [0x503800, 0x503FFF, 'LT', 'Lithuania'],
  [0x504800, 0x504FFF, 'MD', 'Moldova'],
  [0x505800, 0x505FFF, 'SK', 'Slovakia'],
  [0x506800, 0x506FFF, 'SI', 'Slovenia'],
  [0x507800, 0x507FFF, 'UZ', 'Uzbekistan'],
  [0x508000, 0x50FFFF, 'UA', 'Ukraine'],
  [0x510000, 0x5107FF, 'BY', 'Belarus'],
  [0x511000, 0x5117FF, 'EE', 'Estonia'],
  [0x512000, 0x5127FF, 'MK', 'North Macedonia'],
  [0x513000, 0x5137FF, 'BA', 'Bosnia and Herzegovina'],
  [0x514000, 0x5147FF, 'GE', 'Georgia'],
  [0x515000, 0x5157FF, 'TJ', 'Tajikistan'],
  [0x516000, 0x5167FF, 'ME', 'Montenegro'],
  [0x600000, 0x6007FF, 'AM', 'Armenia'],
  [0x600800, 0x600FFF, 'AZ', 'Azerbaijan'],
  [0x601000, 0x6017FF, 'KG', 'Kyrgyzstan'],
  [0x601800, 0x601FFF, 'TM', 'Turkmenistan'],
  [0x680000, 0x6807FF, 'BT', 'Bhutan'],
  [0x681000, 0x6817FF, 'FM', 'Micronesia'],
  [0x682000, 0x6827FF, 'MN', 'Mongolia'],
  [0x683000, 0x6837FF, 'KZ', 'Kazakhstan'],
  [0x684000, 0x6847FF, 'PW', 'Palau'],
  [0x700000, 0x700FFF, 'AF', 'Afghanistan'],
  [0x702000, 0x702FFF, 'BD', 'Bangladesh'],
  [0x704000, 0x704FFF, 'MM', 'Myanmar'],
  [0x706000, 0x706FFF, 'KW', 'Kuwait'],
  [0x708000, 0x708FFF, 'LA', 'Laos'],
  [0x70A000, 0x70AFFF, 'NP', 'Nepal'],
  [0x70C000, 0x70C7FF, 'OM', 'Oman'],
  [0x70E000, 0x70EFFF, 'KH', 'Cambodia'],
  [0x710000, 0x717FFF, 'SA', 'Saudi Arabia'],
  [0x718000, 0x71FFFF, 'KR', 'South Korea'],
  [0x720000, 0x727FFF, 'KP', 'North Korea'],
  [0x728000, 0x72FFFF, 'IQ', 'Iraq'],
  [0x730000, 0x737FFF, 'IR', 'Iran'],
  [0x738000, 0x73FFFF, 'IL', 'Israel'],
  [0x740000, 0x747FFF, 'JO', 'Jordan'],
  [0x748000, 0x74FFFF, 'LB', 'Lebanon'],
  [0x750000, 0x757FFF, 'MY', 'Malaysia'],
  [0x758000, 0x75FFFF, 'PH', 'Philippines'],
  [0x760000, 0x767FFF, 'PK', 'Pakistan'],
  [0x768000, 0x76FFFF, 'SG', 'Singapore'],
  [0x770000, 0x777FFF, 'LK', 'Sri Lanka'],
  [0x778000, 0x77FFFF, 'SY', 'Syria'],
  [0x780000, 0x7BFFFF, 'CN', 'China'],
  [0x7C0000, 0x7FFFFF, 'AU', 'Australia'],
  [0x800000, 0x83FFFF, 'IN', 'India'],
  [0x840000, 0x87FFFF, 'JP', 'Japan'],
  [0x880000, 0x887FFF, 'TH', 'Thailand'],
  [0x888000, 0x88FFFF, 'VN', 'Vietnam'],
  [0x890000, 0x890FFF, 'YE', 'Yemen'],
  [0x894000, 0x894FFF, 'BH', 'Bahrain'],
  [0x895000, 0x8957FF, 'BN', 'Brunei'],
  [0x896000, 0x896FFF, 'AE', 'United Arab Emirates'],
  [0x897000, 0x8977FF, 'SB', 'Solomon Islands'],
  [0x898000, 0x898FFF, 'PG', 'Papua New Guinea'],
  [0x899000, 0x8997FF, 'TW', 'Taiwan'], // de facto, see header: ICAO2 special-use block
  [0x8A0000, 0x8A7FFF, 'ID', 'Indonesia'],
  [0x900000, 0x9007FF, 'MH', 'Marshall Islands'],
  [0x901000, 0x9017FF, 'CK', 'Cook Islands'],
  [0x902000, 0x9027FF, 'WS', 'Samoa'],
  [0xA00000, 0xAFFFFF, 'US', 'United States'],
  [0xC00000, 0xC3FFFF, 'CA', 'Canada'],
  [0xC80000, 0xC87FFF, 'NZ', 'New Zealand'],
  [0xC88000, 0xC88FFF, 'FJ', 'Fiji'],
  [0xC8A000, 0xC8A7FF, 'NR', 'Nauru'],
  [0xC8C000, 0xC8C7FF, 'LC', 'Saint Lucia'],
  [0xC8D000, 0xC8D7FF, 'TO', 'Tonga'],
  [0xC8E000, 0xC8E7FF, 'KI', 'Kiribati'],
  [0xC90000, 0xC907FF, 'VU', 'Vanuatu'],
  [0xC91000, 0xC917FF, 'AD', 'Andorra'],
  [0xC92000, 0xC927FF, 'DM', 'Dominica'],
  [0xC93000, 0xC937FF, 'KN', 'Saint Kitts and Nevis'],
  [0xC94000, 0xC947FF, 'SS', 'South Sudan'],
  [0xC95000, 0xC957FF, 'TL', 'Timor-Leste'],
  [0xC97000, 0xC977FF, 'TV', 'Tuvalu'],
  [0xE00000, 0xE3FFFF, 'AR', 'Argentina'],
  [0xE40000, 0xE7FFFF, 'BR', 'Brazil'],
  [0xE80000, 0xE80FFF, 'CL', 'Chile'],
  [0xE84000, 0xE84FFF, 'EC', 'Ecuador'],
  [0xE88000, 0xE88FFF, 'PY', 'Paraguay'],
  [0xE8C000, 0xE8CFFF, 'PE', 'Peru'],
  [0xE90000, 0xE90FFF, 'UY', 'Uruguay'],
  [0xE94000, 0xE94FFF, 'BO', 'Bolivia'],
]

// One frozen result per block, built once: countryOf allocates nothing per call.
const COUNTRY: readonly { iso2: string; name: string }[] = BLOCKS.map(([, , iso2, name]) => Object.freeze({ iso2, name }))

const HEX6 = /^[0-9a-f]{6}$/i

/** Country of an ICAO address such as '503fc4'. '~'-prefixed (non-ICAO) addresses, malformed strings and unallocated addresses → null. */
export function countryOf(hex: string): { iso2: string; name: string } | null {
  if (!HEX6.test(hex)) return null
  const a = parseInt(hex, 16)
  let lo = 0
  let hi = BLOCKS.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const b = BLOCKS[mid]
    if (a < b[0]) hi = mid - 1
    else if (a > b[1]) lo = mid + 1
    else return COUNTRY[mid]
  }
  return null
}

const ISO2 = /^[a-z]{2}$/i
const REGIONAL_A = 0x1f1e6 // REGIONAL INDICATOR SYMBOL LETTER A

/** Flag emoji for an ISO 3166-1 alpha-2 code ('IL' → 🇮🇱); '' for anything that is not two ASCII letters. */
export function flagEmoji(iso2: string): string {
  if (!ISO2.test(iso2)) return ''
  const u = iso2.toUpperCase()
  return String.fromCodePoint(REGIONAL_A + u.charCodeAt(0) - 65, REGIONAL_A + u.charCodeAt(1) - 65)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test shared/icaoCountry.test.ts`
Expected: PASS — `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add shared/icaoCountry.ts shared/icaoCountry.test.ts
git commit -m "feat(shared): country of registration from the ICAO 24-bit address (Annex 10 Table 9-1, Amdt 92)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: WP gate

- [ ] **Step 1: Run every test this package owns**

Run: `node --test shared/icaoCountry.test.ts`
Expected: `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'shared/icaoCountry'`
Expected: no output (grep exits 1). On a branch where every merged package is complete, `npm run check` must also pass.

- [ ] **Step 3: Confirm everything is committed and record the gate**

```bash
git status --short -- shared/icaoCountry.ts shared/icaoCountry.test.ts
git commit --allow-empty -m "chore(shared): WP-B-C1 gate passed (12 tests, tsc clean)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `git status` prints nothing before the commit. The branch `wp/B-C1` is ready to merge.
