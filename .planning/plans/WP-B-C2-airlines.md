# WP-B-C2 — Airline Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `airlineOf(callsign)` names the airline behind an ICAO flight identification, e.g. `ELY5450` → `El Al Israel Airlines` and `UAE954` → `Emirates`. It returns `null` for a registration flown as a callsign (`N123AB`, `GABCD`), for `null`, and for anything else. The answer comes from a compact committed table, `shared/airlines.json` (`{ICAO designator: name}`, 1,025 entries, 25 KB), built from the OpenFlights airline database. B-A passes it to the detail panel (`Lookup.airline`) and may show it in the table.

**Architecture:** Two small modules and one data file.
- `tools/build-airlines.ts` (build time, Node only):
  - `buildAirlines(dat)` is a pure transform. `airlines.dat` has no header row, quotes every text field and writes `\N` for null. The function prepends a header row and parses the text with WP-T1's RFC 4180 `parseCsv` (`tools/build-airports.ts`; read-only import, no new parser).
  - It keeps rows with `active === 'Y'` and an ICAO code that matches `/^[A-Z]{3}$/`, and trims the names (8 names on 2026-09-22 end in a space).
  - When one code is on several active rows, it keeps the row with the lowest OpenFlights id. On 2026-09-22 there were 8 such codes. In every case the lowest id is the original, current entry: SWR Swiss International Air Lines over Swissair, RNA Nepal Airlines over Royal Nepal Airlines, RAC Icar Air over Royal Air Cambodge, JAL Japan Airlines over Japan Airlines Domestic, TYR Tyrolean Airways over its own later duplicate. A "prefer the row with an IATA code" rule would pick the defunct Royal Air Cambodge.
  - Keys come back sorted. `formatAirlines` writes one entry per line, so diffs stay readable.
  - `main` downloads `airlines.dat` once into `node_modules/.cache/openflights/` (gitignored with `node_modules/`). It caches the file only after it parses to a non-empty table, so an HTML error page is never cached. An empty result throws before anything is written. `fetch` is injectable, so every test runs offline.
- `shared/airlines.ts` (server and client): imports the JSON with `with { type: 'json' }`. Node 24+ and Vite both support this, and `harness/runways.ts` already does it. `airlineOf` trims and upper-cases the callsign and tests it against `/^[A-Z]{3}\d[A-Z0-9]{0,4}$/`: a 3-letter designator, then a flight number that starts with a digit, at most 8 characters in all, as ADS-B carries. On a match it looks up the first 3 letters. The digit-first rule is what rejects registrations: a US N-number has one letter before its digits, and most other registrations flown as callsigns are all letters (GABCD, DAIBC, HBJVA). There is no match array and no per-call allocation beyond `trim`/`toUpperCase`.
- `AIRLINES_CREDIT` is the attribution line for the UI credits (an extra export).

**Data and licence:** OpenFlights airline database, `https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat`. The licence was verified on 2026-09-22 at https://openflights.org/data.php. The page says the airport, airline, plane and route databases are under the Open Database License, and that rights in individual contents are under the Database Contents License. That is ODbL 1.0 and DbCL 1.0. The page asks users to acknowledge the source, and share-alike applies to a publicly distributed derived database. `shared/airlines.json` is such a derived database. It stays under ODbL, and its source and build tool ship in the repo. B-A must add `AIRLINES_CREDIT` ("Airline names: OpenFlights (ODbL)") to the UI credits. No code, table or colour data comes from tar1090, dump1090 or any other GPL project.

**Tech Stack:** Node ≥ 24.2 (native TypeScript, JSON import attributes), `node:test`, TypeScript 7 (type-check only; `resolveJsonModule` is already on in `tsconfig.json`). It uses WP-T1's `parseCsv`. There are no new dependencies.

**Wave:** B (parallel with the other B-* packages). It depends on B0 per PLAN.md §5.3, and on WP-T1's `parseCsv`, which is merged in Wave 1. It is consumed by B-A. **Estimated:** 45 min. **Validated:** on 2026-09-22 in the integrated tree (all 27 WPs + B0; Node 25.2.1, TypeScript 7.0.2). `node --test shared/airlines.test.ts tools/build-airlines.test.ts` → 15/15 pass. `npx tsc --noEmit` reports nothing for these files; the whole tree type-checked clean at that moment. The `airlines.dat` downloaded that day has 6,162 rows: 1,255 active, 1,033 of those with a valid ICAO code, and 8 codes on more than one row. From it, `node tools/build-airlines.ts` wrote 1,025 airlines, 25,316 B (9,805 B gzipped). The plan was then replayed from its code blocks alone, in an isolated copy that held only WP-T1's `tools/build-airports.ts` and its `shared/` imports. Task 1 failed (`ERR_MODULE_NOT_FOUND`), then passed 8/8. Task 2 Step 2, run from the cached download, printed `identical`. Task 3 failed, then passed 7/7. A full `tsc --noEmit` of the copy was clean, and the replayed files are byte-identical to the tree. Six mutations were each caught: letter-first flight numbers allowed (1 test fails), no trim/upper-case (1), highest id wins (3), lower-case `n` treated as active (4), names not trimmed (2), cache never written (1). `airlineOf` takes about 53 ns per call (10⁶ calls, half of them matches, 53 ms in all). Vite, on its own port and stopped afterwards, serves `shared/airlines.ts` with the table imported as `/shared/airlines.json?import`.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- Tests never touch the network. The `airlines.dat` rows the builder tests need are inline (real rows, copied 2026-09-22), and `main` gets a fake `fetch`. The one download is Task 2 Step 2, which is optional: one GET of about 397 KB from `raw.githubusercontent.com`, once. Nothing here ever contacts adsb.lol.
- The table is 25,316 B (9,805 B gzipped), well under the 200 KB asset threshold, so it is inline in Task 2 and not in `plans/assets/`.
- File ownership: this package writes only the five files below. It imports `tools/build-airports.ts` (WP-T1) read-only.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `tools/build-airlines.ts` | `AIRLINES_DAT`, `buildAirlines`, `formatAirlines`, `main` + CLI |
| `tools/build-airlines.test.ts` | filter, trim, duplicate rule, sorting, format, offline download/cache, error paths |
| `shared/airlines.json` | generated `{ICAO designator: airline name}` table (committed) |
| `shared/airlines.ts` | `airlineOf(callsign: string \| null): string \| null` (PLAN.md §5.3 B-C2, exactly), `AIRLINES_CREDIT` |
| `shared/airlines.test.ts` | airline flight ids, registrations, padding/case, bad shapes, table sanity |

---

### Task 1: Airline table builder

**Files:**
- Create: `tools/build-airlines.ts`, `tools/build-airlines.test.ts`
- Test: `tools/build-airlines.test.ts`

**Interfaces:**
- Consumes: `parseCsv(text: string): Record<string, string>[]` (WP-T1, `tools/build-airports.ts`)
- Produces: `AIRLINES_DAT: string` · `buildAirlines(dat: string): Record<string, string>` · `formatAirlines(names: Record<string, string>): string` · `main(argv: string[], fetchFn?: typeof fetch): Promise<Record<string, string>>` · CLI `node tools/build-airlines.ts [--out shared/airlines.json] [--cache node_modules/.cache/openflights]`

- [ ] **Step 1: Write the failing test**

```ts
// tools/build-airlines.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIRLINES_DAT, buildAirlines, formatAirlines, main } from './build-airlines.ts'

// Real OpenFlights airlines.dat rows (copied 2026-09-22), reordered so the Swiss duplicate comes higher id first.
// Columns: id, name, alias, IATA, ICAO, callsign, country, active; \N = null.
const DAT = String.raw`-1,"Unknown",\N,"-","N/A",\N,\N,"Y"
39,"Aban Air",\N,"K5","ABE","ABAN","Iran","n"
1044,"Aerobusinessservice",\N,"","LSM","","Russia","N"
1326,"Tyrolean Airways",\N,"VO","TYR","TYROLEAN","Austria","Y"
2150,"El Al Israel Airlines",\N,"LY","ELY","ELAL","Israel","Y"
2183,"Emirates","Emirates Airlines","EK","UAE","EMIRATES","United Arab Emirates","Y"
4560,"Swissair",\N,"SR","SWR","Swissair","Switzerland","Y"
4559,"Swiss International Air Lines","Swiss Airlines","LX","SWR","SWISS","Switzerland","Y"
5533,"Tyrolean Airways",\N,\N,"TYR","TYROLEAN",\N,"Y"
5559,"Maldivian Air Taxi",\N,"8Q",\N,\N,"Maldives","Y"
13394,"Jayrow","","\\'","\\'\\","","Australia","Y"
19548,"Yeti Airlines ","","","NYT","","Nepal","Y"
`

const EXPECTED = {
  ELY: 'El Al Israel Airlines',
  NYT: 'Yeti Airlines',
  SWR: 'Swiss International Air Lines',
  TYR: 'Tyrolean Airways',
  UAE: 'Emirates',
}

test('buildAirlines: active rows with a 3-letter ICAO code only, names trimmed', () => {
  assert.deepEqual(buildAirlines(DAT), EXPECTED)
})

test('buildAirlines: keys come back sorted', () => {
  assert.deepEqual(Object.keys(buildAirlines(DAT)), ['ELY', 'NYT', 'SWR', 'TYR', 'UAE'])
})

test('buildAirlines: a code on several active rows goes to the lowest OpenFlights id, whatever the row order', () => {
  const lines = DAT.trim().split('\n')
  assert.equal(buildAirlines(lines.reverse().join('\n')).SWR, 'Swiss International Air Lines')
  assert.equal(buildAirlines(lines.filter((l) => !l.startsWith('4559,')).join('\n')).SWR, 'Swissair')
})

test('buildAirlines: defunct (N), lower-case n, N/A, \\N and junk codes are dropped', () => {
  const names = buildAirlines(DAT)
  for (const code of ['ABE', 'LSM', 'N/A', '\\N', String.raw`\\'\\`]) assert.equal(Object.hasOwn(names, code), false, code)
})

test('buildAirlines: no data rows → empty map', () => {
  assert.deepEqual(buildAirlines(''), {})
})

test('formatAirlines: one entry per line, valid JSON, trailing newline', () => {
  const text = formatAirlines({ ELY: 'El Al Israel Airlines', SCW: 'Malmö Aviation' })
  assert.equal(text, '{\n"ELY":"El Al Israel Airlines",\n"SCW":"Malmö Aviation"\n}\n')
  assert.deepEqual(JSON.parse(text), { ELY: 'El Al Israel Airlines', SCW: 'Malmö Aviation' })
})

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fh-airlines-'))
}

test('main: downloads airlines.dat once into the cache and writes the JSON', async () => {
  const dir = tmp()
  try {
    const urls: string[] = []
    const fetchFn = (async (url: string) => {
      urls.push(url)
      return new Response(DAT)
    }) as unknown as typeof fetch
    const out = join(dir, 'out', 'airlines.json')
    const cache = join(dir, 'cache')
    const names = await main(['--out', out, '--cache', cache], fetchFn)
    assert.deepEqual(names, EXPECTED)
    assert.deepEqual(urls, [AIRLINES_DAT])
    assert.equal(readFileSync(out, 'utf8'), formatAirlines(EXPECTED))
    assert.equal(readFileSync(join(cache, 'airlines.dat'), 'utf8'), DAT)

    const offline = (async () => {
      throw new Error('network used')
    }) as unknown as typeof fetch
    assert.deepEqual(await main(['--out', out, '--cache', cache], offline), EXPECTED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('main: HTTP error or an empty result throws and writes nothing', async () => {
  const dir = tmp()
  try {
    const out = join(dir, 'airlines.json')
    const notFound = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await assert.rejects(main(['--out', out, '--cache', join(dir, 'c1')], notFound), /HTTP 404/)
    const html = (async () => new Response('<html>rate limited</html>')) as unknown as typeof fetch
    await assert.rejects(main(['--out', out, '--cache', join(dir, 'c2')], html), /no airlines/)
    assert.equal(existsSync(out), false)
    assert.equal(existsSync(join(dir, 'c2', 'airlines.dat')), false, 'a bad download is not cached')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/build-airlines.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tools/build-airlines.ts' imported from …/tools/build-airlines.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// tools/build-airlines.ts
// Builds shared/airlines.json ({ICAO airline designator: name}) from the OpenFlights airline database.
//
//   node tools/build-airlines.ts [--out shared/airlines.json] [--cache node_modules/.cache/openflights]
//
// Source: https://openflights.org/data (airlines.dat), Open Database License 1.0; contents under the Database
// Contents License 1.0. Attribution: "Airline names: OpenFlights (ODbL)". airlines.dat (~400 KB) is downloaded once
// into --cache (under node_modules, so gitignored); delete the folder to refresh.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { parseCsv } from './build-airports.ts'

export const AIRLINES_DAT = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat'
const COLUMNS = 'id,name,alias,iata,icao,callsign,country,active'

/**
 * {ICAO designator: name} from airlines.dat text (no header row; \N = null).
 * Keeps rows with active === 'Y' and a 3-letter A–Z ICAO code; names are trimmed.
 * A code on several active rows goes to the lowest OpenFlights id (the original entry; later ids are user additions,
 * e.g. SWR: Swiss International Air Lines 4559 over Swissair 4560). Keys come back sorted.
 * ponytail: OpenFlights' active flag is unreliable for some defunct carriers, so a few stale names ship; the ceiling is
 * a wrong name on an old designator, and the upgrade path is a curated source (e.g. ICAO Doc 8585) when it matters.
 */
export function buildAirlines(dat: string): Record<string, string> {
  const best = new Map<string, { id: number; name: string }>()
  for (const r of parseCsv(`${COLUMNS}\n${dat}`)) {
    const name = r.name.trim()
    if (r.active !== 'Y' || !/^[A-Z]{3}$/.test(r.icao) || name === '' || name === '\\N') continue
    const id = Number(r.id)
    const prev = best.get(r.icao)
    if (!prev || id < prev.id) best.set(r.icao, { id, name })
  }
  return Object.fromEntries([...best].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, { name }]) => [code, name]))
}

/** JSON with one entry per line, so diffs of the committed file stay readable. */
export function formatAirlines(names: Record<string, string>): string {
  const lines = Object.entries(names).map(([code, name]) => `${JSON.stringify(code)}:${JSON.stringify(name)}`)
  return `{\n${lines.join(',\n')}\n}\n`
}

export async function main(argv: string[], fetchFn: typeof fetch = fetch): Promise<Record<string, string>> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string', default: 'shared/airlines.json' },
      cache: { type: 'string', default: 'node_modules/.cache/openflights' },
    },
  })
  const cached = join(values.cache, 'airlines.dat')
  const fromCache = existsSync(cached)
  let dat: string
  if (fromCache) dat = readFileSync(cached, 'utf8')
  else {
    const res = await fetchFn(AIRLINES_DAT)
    if (!res.ok) throw new Error(`GET ${AIRLINES_DAT}: HTTP ${res.status}`)
    dat = await res.text()
  }
  const names = buildAirlines(dat)
  const n = Object.keys(names).length
  if (n === 0) throw new Error(`no airlines in ${fromCache ? cached : AIRLINES_DAT}`)
  if (!fromCache) {
    mkdirSync(values.cache, { recursive: true })
    writeFileSync(cached, dat)
  }
  const text = formatAirlines(names)
  mkdirSync(dirname(values.out), { recursive: true })
  writeFileSync(values.out, text)
  console.log(`wrote ${values.out}: ${n} airlines, ${Buffer.byteLength(text)} bytes`)
  return names
}

if (import.meta.main) await main(process.argv.slice(2))
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/build-airlines.test.ts`
Expected: PASS — `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0` (the `main` tests also print `wrote …/airlines.json: 5 airlines, 140 bytes` twice).

- [ ] **Step 5: Commit**

```bash
git add tools/build-airlines.ts tools/build-airlines.test.ts
git commit -m "feat(tools): build the ICAO airline name table from OpenFlights" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Generate and commit `shared/airlines.json`

**Files:**
- Create: `shared/airlines.json`

**Interfaces:**
- Consumes: the CLI from Task 1. Network (optional Step 2 only): one GET of `https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat` (396,896 B, sha256 `39be1a432e8b04ebc12860c29281c974a9cb52169c82b2456a835d66ab1548a1` on 2026-09-22). Later runs use the cache.
- Produces: `shared/airlines.json`: 1,025 entries, 25,316 B, sha256 `5c8f41925f086a67a0ac64a906a71140c4db26926773f2f236b9d0a0eba79e6f`, one `"CODE":"Name"` per line, keys sorted

- [ ] **Step 1: Write the table (the reviewed 2026-09-22 build)**

File: `shared/airlines.json`
```json
{
"AAA":"Ansett Australia",
"AAF":"Aigle Azur",
"AAH":"Aloha Airlines",
"AAL":"American Airlines",
"AAN":"Amsterdam Airlines",
"AAQ":"Copterline",
"AAR":"Asiana Airlines",
"AAS":"Askari Aviation",
"AAW":"Afriqiyah Airways",
"AAY":"Allegiant Air",
"ABD":"Air Atlanta Icelandic",
"ABI":"Aviabus",
"ABL":"Air Busan",
"ABQ":"Airblue",
"ABS":"Transwest Air",
"ABY":"Air Arabia",
"ACA":"Air Canada",
"ACI":"Air Caledonie International",
"ACP":"Astral Aviation",
"ADE":"Ada Air",
"ADH":"Air One",
"ADO":"Hokkaido International Airlines",
"ADR":"Adria Airways",
"AEA":"Air Europa",
"AEB":"Aero Benin",
"AEE":"Aegean Airlines",
"AEL":"Air Europe",
"AER":"Alaska Central Express",
"AES":"ACES Colombia",
"AEU":"Astraeus",
"AEW":"Aerosvit Airlines",
"AEY":"Air Italy",
"AFG":"Ariana Afghan Airlines",
"AFL":"Aeroflot Russian Airlines",
"AFR":"Air France",
"AGV":"Air Glaciers",
"AGX":"Aviogenex",
"AHO":"Air Hamburg (AHO)",
"AHY":"Azerbaijan Airlines",
"AIA":"Avies",
"AIC":"Air India Limited",
"AIO":"United States Air Force",
"AIQ":"Thai AirAsia",
"AIR":"Airlift International",
"AIZ":"Arkia Israel Airlines",
"AJM":"Air Jamaica",
"AJX":"Air Japan",
"AKA":"Air Korea Co. Ltd.",
"AKL":"Air Kiribati",
"ALK":"SriLankan Airlines",
"ALO":"Allegheny Commuter Airlines",
"AMC":"Air Malta",
"AML":"Air Malawi",
"AMT":"ATA Airlines",
"AMU":"Air Macau",
"AMV":"AMC Airlines",
"AMX":"AeroMéxico",
"ANA":"All Nippon Airways",
"ANE":"Air Nostrum",
"ANG":"Air Niugini",
"ANK":"Air Nippon",
"ANO":"Airnorth",
"ANT":"Air North Charter - Canada",
"ANU":"Andalus Lineas Aereas",
"ANZ":"Air New Zealand",
"APW":"Arrow Air",
"ARD":"Aerocondor",
"ARE":"Aires",
"ARF":"Aero Flight",
"ARG":"Aerolineas Argentinas",
"ARU":"Aruba Airlines",
"ASA":"Alaska Airlines",
"ASD":"Air Sinai",
"ASH":"Mesa Airlines",
"ASL":"Air Serbia",
"ASQ":"Atlantic Southeast Airlines",
"ASZ":"Astrakhan Airlines",
"ATC":"Air Tanzania",
"ATM":"Airlines Of Tasmania",
"AUA":"Austrian Airlines",
"AUB":"Augsburg Airways",
"AUH":"Abu Dhabi Amiri Flight",
"AUI":"Ukraine International Airlines",
"AUL":"Aeroflot-Nord",
"AUR":"Aurigny Air Services",
"AUT":"Austral Lineas Aereas",
"AVA":"Avianca - Aerovias Nacionales de Colombia",
"AVN":"Air Vanuatu",
"AWA":"Asia Wings",
"AWE":"America West Airlines",
"AWI":"Air Wisconsin",
"AWM":"Asian Wings Airways",
"AWQ":"Indonesia AirAsia",
"AWU":"Aeroline GmbH",
"AWW":"Air Wales",
"AXB":"Air India Express",
"AXC":"Indochina Airlines",
"AXE":"Air Explore",
"AXL":"Air Exel",
"AXM":"AirAsia",
"AXZ":"Aereonautica militare",
"AYZ":"Atlant-Soyuz Airlines",
"AZA":"Alitalia",
"AZN":"Amaszonas",
"AZU":"Azul",
"AZW":"Air Zimbabwe",
"BAG":"dba",
"BAW":"British Airways",
"BBC":"Biman Bangladesh Airlines",
"BBG":"Bluebird Airways (BZ)",
"BBO":"Flybaboo",
"BBR":"Santa Barbara Airlines",
"BCC":"BusinessAir",
"BCN":"Ocean Air",
"BCY":"CityJet",
"BEE":"Flybe",
"BER":"Air Berlin",
"BEU":"Bateleur Air",
"BGD":"Air Bangladesh",
"BGY":"Bingo Airways",
"BHP":"Belair Airlines",
"BHS":"Bahamasair",
"BIE":"Air Mediterranee",
"BIH":"British International Helicopters",
"BKF":"BF-Lento OY",
"BKP":"Bangkok Airways",
"BLF":"Blue1",
"BLL":"Baltic Airlines",
"BLS":"Bearskin Lake Air Service",
"BLV":"Bellview Airlines",
"BLX":"TUIfly Nordic",
"BMA":"bmi",
"BMI":"bmibaby",
"BMJ":"Bemidji Airlines",
"BMM":"Atlas Blue",
"BMR":"British Midland Regional",
"BON":"Air Bosna",
"BOT":"Air Botswana",
"BOV":"Boliviana de Aviacion (OB)",
"BPA":"Blue Panorama Airlines",
"BPS":"Budapest Aircraft Services/Manx2",
"BQB":"Buquebus Líneas Aéreas",
"BRG":"Bering Air",
"BRQ":"El-Buraq Air Transport",
"BRS":"Brazilian Air Force",
"BRU":"Belavia Belarusian Airlines",
"BSA":"Black Stallion Airways",
"BSX":"Bassaka airlines",
"BTA":"ExpressJet",
"BTI":"Air Baltic",
"BTM":"Air Batumi",
"BTQ":"Boutique Air (Priv)",
"BTV":"Metro Batavia",
"BUB":"Air Bourbon",
"BUR":"Air Bucharest",
"BUU":"Baikotovitchestrian Airlines",
"BVT":"Berjaya Air",
"BWA":"Caribbean Airlines",
"BWG":"Blue Wings",
"BZE":"BRAZIL AIR",
"BZH":"Brit Air",
"CAI":"Corendon Airlines",
"CAL":"China Airlines",
"CAN":"Crest Aviation",
"CAP":"CanXplorer",
"CAW":"Comair",
"CAY":"Cayman Airways",
"CBG":"GX Airlines",
"CCA":"Air China",
"CCB":"CARICOM AIRWAYS (BARBADOS) INC.",
"CCC":"CCML Airlines",
"CCG":"Central Connect Airlines",
"CCM":"Corse-Mediterranee",
"CDG":"Shandong Airlines",
"CDN":"Canadian Airlines",
"CDP":"Aero Condor Peru",
"CEB":"Cebu Pacific",
"CEL":"CEIBA Intercontinental",
"CEO":"Comfort Express Virtual Charters",
"CES":"China Eastern Airlines",
"CEY":"Air Century",
"CFE":"BA CityFlyer",
"CFG":"Condor Flugdienst",
"CGK":"Click Airways",
"CGP":"Cargo Plus Aviation",
"CHB":"West Air China",
"CHH":"Hainan Airlines",
"CHP":"Consorcio Aviaxsa",
"CHQ":"Chautauqua Airlines",
"CHW":"Charter Air",
"CIF":"CB Airways UK ( Interliging Flights )",
"CIM":"Cimber Air",
"CIX":"City Connexion Airlines",
"CJC":"Colgan Air",
"CLH":"Lufthansa CityLine",
"CLI":"Calima Aviacion",
"CLJ":"Cello Aviation",
"CLW":"Centralwings",
"CMI":"Continental Micronesia",
"CMP":"Copa Airlines",
"CNF":"Canaryfly",
"CNO":"SAS Braathens",
"COA":"Continental Airlines",
"COE":"Comtel Air",
"COM":"Comair",
"CPA":"Cathay Pacific",
"CPN":"Caspian Airlines",
"CPZ":"Compass Airlines",
"CQH":"Spring Airlines",
"CQN":"Chongqing Airlines",
"CRK":"Hong Kong Airlines",
"CRL":"Corsairfly",
"CRO":"Crown Airways",
"CSA":"Czech Airlines",
"CSC":"Sichuan Airlines",
"CSH":"Shanghai Airlines",
"CSN":"China Southern Airlines",
"CSX":"Choice Airways",
"CSZ":"Shenzhen Airlines",
"CTN":"Croatia Airlines",
"CUA":"China United Airlines",
"CUB":"Cubana de Aviación",
"CUD":"Air Cudlua",
"CVA":"Air Chathams",
"CWK":"Comores Airlines",
"CWM":"Air Marshall Islands",
"CXA":"Xiamen Airlines",
"CYD":"Access Air",
"CYH":"Yunnan Airlines",
"CYP":"Cyprus Airways",
"CZV":"Via Conectia Airlines",
"DAH":"Air Algerie",
"DAK":"First Flying",
"DAL":"Delta Air Lines",
"DAO":"Daallo Airlines",
"DAT":"Brussels Airlines",
"DBK":"Dubrovnik Air",
"DCD":"Air 26",
"DEA":"Delta Aerotaxi",
"DHI":"Adam Air",
"DJB":"Djibouti Airlines",
"DKH":"Juneyao Airlines",
"DLA":"Air Dolomiti",
"DLH":"Lufthansa",
"DME":"Royal Flight",
"DMO":"Domodedovo Airlines",
"DNL":"Dutch Antilles Express",
"DNM":"Denim Air",
"DNV":"Aeroflot-Don",
"DOA":"Dominicana de Aviaci",
"DOB":"Dobrolet",
"DRD":"Air Madrid",
"DRK":"Druk Air",
"DRU":"Alrosa Mirny Air Enterprise",
"DSM":"LAN Argentina",
"DSV":"Direct Aero Services",
"DSY":"Dennis Sky",
"DTA":"TAAG Angola Airlines",
"DTR":"DAT Danish Air Transport",
"DWA":"Dense Airways",
"DWT":"Darwin Airline",
"DYA":"Dynamic Airways",
"EAA":"Eastok Avia",
"EAL":"European Air Express",
"EAV":"Eastern Atlantic Virtual Airlines",
"ECA":"Eurocypria Airlines",
"ECU":"Ecuavia",
"EDW":"Edelweiss Air",
"EEA":"Empresa Ecuatoriana De Aviacion",
"EEU":"Eurofly Service",
"EFA":"Far Eastern Air Transport",
"EFY":"EasyFly",
"EGF":"American Eagle Airlines",
"EGH":"BBN-Airways",
"EGS":"Eagles Airlines",
"EHN":"East Horizon",
"EIA":"Evergreen International Airlines",
"EIN":"Aer Lingus",
"EJA":"NetJets",
"ELA":"Eastland Air",
"ELC":"Small Planet Airlines",
"ELK":"ELK Airways",
"ELL":"Estonian Air",
"ELO":"Eurolot",
"ELY":"El Al Israel Airlines",
"ENJ":"Enerjet",
"ENY":"Envoy Air",
"ENZ":"Jota Aviation",
"ERO":"Sun D'Or",
"ERR":"Era Alaska",
"ERT":"Eritrean Airlines",
"ESK":"SkyEurope",
"ESR":"Eastar Jet",
"ETD":"Etihad Airways",
"ETH":"Ethiopian Airlines",
"EUD":"Air Italy Egypt",
"EUV":"EuropeSky",
"EVA":"EVA Air",
"EVC":"Comfort Express Virtual Charters Albany",
"EWG":"Eurowings",
"EXS":"Jet2.com",
"EZA":"Eznis Airways",
"EZE":"Eastern Airways",
"EZY":"easyJet",
"FAB":"First Air",
"FBL":"Fly Brasil",
"FCA":"First Choice Airways",
"FCB":"COBALT",
"FCM":"Flybe Finland Oy",
"FDB":"Fly Dubai",
"FDD":"Feeder Airlines",
"FEG":"FlyEgypt",
"FFM":"Firefly",
"FFT":"Frontier Airlines",
"FFV":"Fly540",
"FHE":"Hello",
"FHI":"FlyHigh Airlines Ireland (FH)",
"FIF":"Air Finland",
"FIN":"Finnair",
"FIX":"Airfix Aviation",
"FJI":"Air Pacific",
"FJM":"Fly Jamaica Airways",
"FKA":"Flying kangaroo Airline",
"FLB":"German Air Force - FLB",
"FLG":"Pinnacle Airlines",
"FLI":"Atlantic Airways",
"FLT":"Flightline",
"FLZ":"Air Florida",
"FNA":"Norlandair",
"FOS":"Formosa Airlines",
"FOX":"FOX Linhas Aereas",
"FPT":"FlyPortugal",
"FRE":"Freedom Air",
"FRF":"Fly France",
"FRL":"Freedom Airlines",
"FTA":"Frontier Flying Service",
"FVM":"Flugfelag Vestmannaeyja",
"FWI":"Air Caraïbes",
"FWL":"Florida West International Airways",
"FXI":"Air Iceland",
"FXX":"Felix Airways",
"FYH":"Flyhy Cargo Airlines",
"FYJ":"FLYJET",
"FZA":"Fuzhou Airlines",
"FZW":"Fly Africa Zimbabwe",
"GAI":"Moskovia Airlines",
"GAO":"Golden Air",
"GAP":"Air Philippines",
"GBA":"Gulf Air Bahrain",
"GBK":"Gabon Airlines",
"GBL":"GB Airways",
"GCA":"Grand Cru Airlines",
"GCR":"Tianjin Airlines",
"GDC":"Grand China Air",
"GDR":"Gadair European Airlines",
"GEC":"Lufthansa Cargo",
"GER":"German International Air Lines",
"GFA":"Gulf Air",
"GFG":"Georgian National Airlines",
"GFT":"Gulfstream International Airlines",
"GFY":"Greenfly",
"GHB":"Ghana International Airlines",
"GIA":"Garuda Indonesia",
"GIE":"Elysian Airlines",
"GIP":"Air Guinee Express",
"GJS":"GoJet Airlines",
"GLA":"Great Lakes Airlines",
"GLG":"Aerolineas Galapagos (Aerogal)",
"GLO":"Gol Transportes Aéreos",
"GLP":"Globus",
"GMI":"Germania",
"GMR":"Golden Myanmar Airlines",
"GNN":"Georgian International Airlines",
"GOW":"Go Air",
"GRL":"Air Greenland",
"GSM":"Flyglobespan",
"GTA":"City Airways",
"GTI":"Atlas Air",
"GUY":"Air Guyane",
"GWI":"Germanwings",
"GWY":"USA3000 Airlines",
"GXG":"GermanXL",
"GZP":"Gazpromavia",
"HAG":"Hageland Aviation Services",
"HAL":"Hawaiian Airlines",
"HAM":"Haiti Ambassador Airlines",
"HAY":"Hamburg Airways",
"HBH":"Hebei Airlines",
"HBR":"Hebradran Air Services",
"HCC":"Holidays Czech Airlines",
"HCW":"Star1 Airlines",
"HDA":"Dragonair",
"HEJ":"Hellas Jet",
"HER":"Hex'Air",
"HFR":"Heli France",
"HHI":"Hamburg International",
"HKE":"Hong Kong Express Airways",
"HLF":"Hapagfly",
"HLX":"TUIfly",
"HMR":"North American Charters",
"HNX":"Hankook Airline",
"HPY":"Happy Air",
"HRM":"Hermes Airlines",
"HSK":"Sky Europe Airlines",
"HTH":"Helitt Líneas Aéreas",
"HVK":"Turkish Air Force",
"HVN":"Vietnam Airlines",
"HWY":"Highland Airways",
"HYM":"Himalayan Airlines",
"HZA":"Horizon Airlines",
"IAA":"Indonesian Airlines",
"IAC":"Indian Airlines",
"IAM":"Aeronautica Militare",
"IAW":"Iraqi Airways",
"IBB":"Binter Canarias",
"IBE":"Iberia Airlines",
"IBK":"Norwegian Air International (D8)",
"IBS":"Iberia Express",
"IBU":"Indigo",
"IBX":"Ibex Airlines",
"ICE":"Icelandair",
"ICL":"CAL Cargo Air Lines",
"IDS":"Indonesia Sky",
"IDX":"Indonesa Air Aisa X",
"IGO":"IndiGo Airlines",
"IIA":"AIR INDOCHINE",
"IIR":"INAVIA Internacional",
"IKA":"Itek Air",
"ILN":"Interair South Africa",
"IMP":"Hellenic Imperial Airways",
"INE":"International Europe",
"IPV":"Parmiss Airlines (IPV)",
"IRA":"Iran Air",
"IRC":"Iran Aseman Airlines",
"IRK":"Kish Air",
"IRM":"Mahan Air",
"ISK":"Intersky",
"ISR":"Israir",
"ISS":"Meridiana",
"ISV":"Islena De Inversiones",
"ISW":"Islas Airways",
"ISX":"Island Spirit",
"ITK":"Interlink Airlines",
"ITX":"Imair Airlines",
"IWA":"Apache Air",
"IWD":"Iberworld",
"IXO":"OCEAN AIR CARGO",
"IYE":"Yemenia",
"JAA":"Japan Asia Airways",
"JAB":"Air Bagan",
"JAF":"Jetairfly",
"JAI":"Jet Airways",
"JAL":"Japan Airlines",
"JAS":"Japan Air System",
"JAZ":"JALways",
"JBA":"Helijet",
"JBU":"JetBlue Airways",
"JEF":"Jetflite",
"JET":"Wind Jet",
"JEX":"JAL Express",
"JFU":"Jet4You",
"JGN":"Jagson Airlines",
"JJA":"Jeju Air",
"JJP":"Jetstar Japan",
"JKK":"Spanair",
"JNA":"Jin Air",
"JOR":"Blue Air",
"JOY":"Joy Air",
"JPU":"Jupiter Airlines",
"JRB":"Jc royal.britannica",
"JSA":"Jetstar Asia Airways",
"JSR":"Jusur airways",
"JST":"Jetstar Airways",
"JTA":"Japan Transocean Air",
"JTO":"Jettor Airlines",
"JZA":"Air Canada Jazz",
"JZR":"Jazeera Airways",
"KAC":"Kuwait Airways",
"KAL":"Korean Air",
"KAP":"Cape Air",
"KBR":"KoralBlue Airlines",
"KBZ":"Air KBZ",
"KCU":"Skyline Ulasim Ticaret A.S.",
"KDA":"Kendell Airlines",
"KEA":"Korea Express Air",
"KEN":"Kenmore Air",
"KFR":"Kingfisher Airlines",
"KGL":"Kogalymavia Air Company",
"KGO":"Korongo Airlines",
"KHB":"Dalavia",
"KHK":"Kharkiv Airlines",
"KIL":"Kuban Airlines",
"KIN":"Kinloss Flying Training Unit",
"KIS":"Contact Air",
"KJC":"Krasnojarsky Airlines",
"KKK":"Atlasjet",
"KLC":"KLM Cityhopper",
"KLM":"KLM Royal Dutch Airlines",
"KLS":"Kal Star Aviation",
"KMF":"Kam Air",
"KND":"Kan Air",
"KNE":"Nas Air",
"KNI":"KD Avia",
"KOL":"SOCHI AIR",
"KOQ":"Kostromskie avialinii",
"KOR":"Air Koryo",
"KQA":"Kenya Airways",
"KRP":"Carpatair",
"KRY":"Russkie Krylya",
"KSM":"Kosmos",
"KSY":"KSY",
"KSZ":"Sunrise Airways",
"KUH":"Kush Air",
"KYA":"Alghanim",
"KZK":"Air Kazakhstan",
"KZR":"Air Astana",
"KZU":"Kuzu Airlines Cargo",
"LAA":"Libyan Arab Airlines",
"LAJ":"British Mediterranean Airways",
"LAM":"Linhas A",
"LAN":"LAN Airlines",
"LAO":"Lao Airlines",
"LAP":"TAM Mercosur",
"LAV":"AlbaStar",
"LBC":"Albanian Airlines",
"LBL":"Line Blue",
"LBT":"Nouvel Air Tunisie",
"LDA":"Lauda Air",
"LFA":"Air Alfa",
"LGL":"Luxair",
"LGW":"Luftfahrtgesellschaft Walter",
"LHN":"Express One International",
"LIA":"Leeward Islands Air Transport",
"LIL":"FlyLal",
"LIX":"LionXpress",
"LJJ":"Luchsh Airlines",
"LLC":"FlyLAL Charters",
"LLM":"Yamal Airlines",
"LMM":"LCM AIRLINES",
"LMU":"AlMasria Universal Airlines",
"LNE":"Aerolane",
"LNI":"Lion Mentari Airlines",
"LOC":"Locair",
"LOF":"Trans States Airlines",
"LOO":"LSM Airlines",
"LOT":"LOT Polish Airlines",
"LPE":"LAN Peru",
"LPR":"L",
"LRC":"LACSA",
"LTC":"LatCharter",
"LTD":"Southern Airways Express",
"LTE":"LTE International Airways",
"LTO":"LTU Austria",
"LTR":"Lufttransport",
"LTU":"Air Lituanica",
"LTY":"Liberty Airways",
"LUR":"Atlantis European Airways",
"LXP":"LAN Express",
"LXR":"Air Luxor",
"LZB":"Bulgaria Air",
"MAA":"MasAir",
"MAC":"Malta Air Charter",
"MAH":"Malév",
"MAI":"Mauritania Airlines International",
"MAK":"MAT Macedonian Airlines",
"MAL":"Morningstar Air Express",
"MAS":"Malaysia Airlines",
"MAU":"Air Mauritius",
"MAV":"Maldivo Airlines",
"MCA":"MCA Airlines",
"MCK":"Macair Airlines",
"MDA":"Mandarin Airlines",
"MDG":"Air Madagascar",
"MDL":"Mandala Airlines",
"MDO":"Domenican Airlines",
"MDP":"Medallion Air",
"MDV":"Moldavian Airlines",
"MDW":"Midway Airlines",
"MEA":"Middle East Airlines",
"MEP":"Midwest Airlines",
"MES":"Mesaba Airlines",
"MGL":"MIAT Mongolian Airlines",
"MGX":"Montenegro Airlines",
"MIC":"Mint Airways",
"MJG":"Michael Airlines",
"MJP":"Air Majoro",
"MJX":"Euroline",
"MKD":"MAT Airways",
"MKG":"Air Mekong",
"MKU":"Island Air (WP)",
"MLA":"40-Mile Air",
"MLD":"Air Moldova",
"MMM":"Myanmar Airways International",
"MNA":"Merpati Nusantara Airlines",
"MNB":"MNG Airlines",
"MNO":"Mango",
"MNP":"Spirit of Manila Airlines",
"MON":"Monarch Airlines",
"MOV":"VIM Airlines",
"MPD":"Air Plus Comet",
"MPE":"Canadian North",
"MPH":"Martinair",
"MRS":"Marusya Airways",
"MSE":"EgyptAir Express",
"MSI":"Motor Sich",
"MSR":"Egyptair",
"MTW":"Mauritania Airways",
"MVD":"Kavminvodyavia",
"MWA":"Midwest Airlines (Egypt)",
"MWI":"Malaysia Wings",
"MXA":"Mexicana de Aviaci",
"MXD":"Malindo Air",
"MXI":"MexicanaLink",
"MXL":"Maxair",
"MYA":"Myflug",
"MYD":"Maya Island Air",
"MYP":"Mann Yadanarpon Airlines",
"MYT":"MyTravel Airways",
"NAK":"Arik Niger",
"NAS":"Nasair",
"NAX":"Norwegian Air Shuttle",
"NCF":"Norfolk County Flight College",
"NCR":"National Air Cargo",
"NDC":"FlyNordic",
"NDN":"Transportes Aereos Cielos Andinos",
"NEA":"New England Airlines",
"NGB":"Nordic Global Airlines",
"NIA":"Nile Air",
"NIG":"Aero Contractors",
"NJS":"National Jet Systems",
"NKF":"Barents AirLink",
"NKS":"Spirit Airlines",
"NLH":"Norwegian Long Haul AS",
"NLY":"Niki",
"NMA":"Nesma Airlines",
"NMB":"Air Namibia",
"NMI":"Pacific Wings",
"NOK":"Nok Air",
"NSE":"SATENA",
"NTJ":"NextJet",
"NTM":"North American Airlines",
"NTW":"Nationwide Airlines",
"NVR":"Novair",
"NWA":"Northwest Airlines",
"NXB":"NEXT Brasil",
"NYT":"Yeti Airlines",
"OAB":"Orbit Airlines Azerbaijan",
"OAE":"Omni Air International",
"OAI":"Orbit International Airlines",
"OAL":"Olympic Airlines",
"OAN":"Orbit Atlantic Airways",
"OAR":"Orbit Regional Airlines",
"OAW":"Helvetic Airways",
"OBS":"Orbest",
"OBT":"Orbit Airlines",
"OCA":"Aserca Airlines",
"OEA":"Orient Thai Airlines",
"OGN":"Origin Pacific Airways",
"OHK":"Oasis Hong Kong Airlines",
"OHY":"Onur Air",
"OLA":"Overland Airways",
"OLS":"Sol Lineas Aereas",
"OLT":"Ostfriesische Lufttransport",
"OMA":"Oman Air",
"OME":"Homer Air",
"ONE":"Oceanair",
"OOM":"Zoom Airlines",
"ORB":"Orenburg Airlines",
"ORC":"Orchid Airlines",
"ORG":"Orenburzhie",
"OTG":"One Two Go Airlines",
"OTJ":"Fly Romania",
"OZJ":"Ozjet Airlines",
"OZW":"Skywest Airlines",
"PAL":"Philippine Airlines",
"PAO":"Polynesian Airlines",
"PBA":"PB Air",
"PBD":"Pobeda",
"PCO":"Pacific Coastal Airline",
"PDC":"Potomac Air",
"PDT":"Piedmont Airlines (1948-1989)",
"PEC":"Pacific East Asia Cargo Airlines",
"PEL":"Aeropelican Air Services",
"PEN":"Peninsula Airways",
"PFL":"Pacific Flier",
"PGA":"Portugalia",
"PGT":"Pegasus Airlines",
"PIA":"Pakistan International Airlines",
"PIC":"Jetstar Pacific",
"PKV":"Псковавиа",
"PLI":"Aeroper",
"PLR":"Northwestern Air",
"PMT":"PMTair",
"PMW":"Paramount Airways",
"PNR":"PAN Air",
"POE":"Porter Airlines",
"POT":"Polet",
"PPL":"Air Pegasus",
"PPW":"Royal Phnom Penh Airways",
"PQW":"PanAm World Airways",
"PRF":"Precision Air",
"PSA":"Pacific Island Aviation",
"PSB":"Syrian Pearl Airlines",
"PTB":"Passaredo Transportes Aereos",
"PTI":"Privatair",
"PUA":"PLUNA",
"PYA":"Pouya Air",
"PYB":"All America BOPY",
"PZY":"Zapolyarie Airlines",
"QAX":"QatXpress",
"QER":"SOCHI AIR CHATER",
"QFA":"Qantas",
"QFZ":"Fars Air Qeshm",
"QQQ":"ENTERair",
"QTR":"Qatar Airways",
"QXE":"Horizon Air",
"RAB":"Rainbow Air (RAI)",
"RAC":"Icar Air",
"RAE":"Régional",
"RAM":"Royal Air Maroc",
"RAR":"Air Rarotonga",
"RAW":"Royal Airways",
"RAY":"Rainbow Air Canada",
"RBA":"Royal Brunei Airlines",
"RBG":"Air Arabia Egypt",
"RBY":"Vision Airlines (V2)",
"REA":"Aer Arann",
"REP":"Regional Paraguaya",
"REU":"Air Austral",
"RFJ":"Royal Falcon",
"RGG":"TransRussiaAirlines",
"RIT":"Asian Spirit",
"RJA":"Royal Jordanian",
"RJD":"Rotana Jet",
"RKA":"Air Afrique",
"RLA":"Airlinair",
"RLN":"Aero Lanka",
"RLU":"Rusline",
"RLX":"Go2Sky",
"RMK":"Simrik Airlines",
"RNA":"Nepal Airlines",
"RNE":"Air Salone",
"RNV":"Armavia",
"RNX":"1Time Airline",
"RNY":"Rainbow Air US",
"RON":"Nauru Air Corporation",
"ROT":"Tarom",
"RPA":"Republic Airlines",
"RPB":"AeroRep",
"RPH":"Republic Express Airlines",
"RPO":"Rainbow Air Polynesia",
"RRJ":"AirRussia",
"RSD":"Russia State Transport",
"RSH":"Air Sahara",
"RSI":"Air Sunshine",
"RSJ":"RusJet",
"RSP":"Jet Suite",
"RSR":"Aero-Service",
"RSU":"Aerosur",
"RSY":"I-Fly",
"RTE":"Aeronorte",
"RUE":"Rainbow Air Euro",
"RUS":"Cirrus Airlines",
"RWD":"Rwandair Express",
"RWW":"Fly Europa",
"RWZ":"Red Wings",
"RXA":"Regional Express",
"RXR":"REXAIR VIRTUEL",
"RYA":"Ryan Air Services",
"RYN":"Ryan International Airlines",
"RYR":"Ryanair",
"RZO":"SATA International",
"SAA":"South African Airways",
"SAE":"SOCHI AIR EXPRESS",
"SAI":"Shaheen Air International",
"SAL":"Spike Airlines",
"SAS":"Scandinavian Airlines System",
"SAT":"SATA Air Acores",
"SAY":"ScotAirways",
"SBD":"Snowbird Airlines",
"SBI":"S7 Airlines",
"SBS":"Seaborne Airlines",
"SCE":"Scenic Airlines",
"SCO":"Scoot",
"SCW":"Malmo Aviation",
"SCX":"Sun Country Airlines",
"SDI":"San Dima Air",
"SDM":"Rossiya-Russian Airlines",
"SDR":"City Airline",
"SEA":"Southeast Air",
"SEH":"Sky Express",
"SEJ":"Spicejet",
"SEN":"Sevenair",
"SEU":"XL Airways France",
"SEY":"Air Seychelles",
"SFJ":"Star Flyer",
"SGG":"Senegal Airlines",
"SGY":"Skagway Air Service",
"SHA":"Sharp Airlines",
"SHD":"Sahara Airlines",
"SIA":"Singapore Airlines",
"SIB":"Sibaviatrans",
"SIH":"Skynet Airlines",
"SJM":"Svyaz Rossiya",
"SJO":"Spring Airlines Japan",
"SJS":"Southjet",
"SJU":"Skyjet Airlines",
"SJY":"Sriwijaya Air",
"SKU":"Sky Airline",
"SKV":"Sky Regional",
"SKW":"SkyWest",
"SKX":"Skyways Express",
"SKY":"Skymark Airlines",
"SLC":"Salsa d\\\\'Haiti",
"SLI":"Aerolitoral",
"SLK":"SilkAir",
"SLM":"Surinam Airways",
"SMJ":"Avient Aviation",
"SMW":"Carpatair Flight Training",
"SMX":"Alitalia Express",
"SMY":"Sama Airlines",
"SNB":"Sterling Airlines",
"SNC":"Air Cargo Carriers",
"SNJ":"Skynet Asia Airways",
"SOA":"Southern Air Charter",
"SOL":"Solomon Airlines",
"SOU":"Southern Airways",
"SOV":"Saratov Aviation Division",
"SOZ":"Sat Airlines",
"SPI":"South Pacific Island Airways",
"SPM":"Air Saint Pierre",
"SQC":"Singapore Airlines Cargo",
"SQH":"SeaPort Airlines",
"SRB":"Solar Air",
"SRH":"Siem Reap Airways",
"SRN":"Sprintair",
"SRQ":"South East Asian Airlines",
"SRY":"ViaAir",
"SSA":"All America US",
"SSV":"Skyservice Airlines",
"STP":"STP Airways",
"STU":"Servicios de Transportes A",
"SUD":"Sudan Airways",
"SUW":"Interavia Airlines",
"SVA":"Saudi Arabian Airlines",
"SVG":"SVG Air",
"SVR":"Ural Airlines",
"SWA":"Southwest Airlines",
"SWD":"Southern Winds Airlines",
"SWM":"Sky Angkor Airlines (ZA)",
"SWR":"Swiss International Air Lines",
"SWU":"Swiss European Air Lines",
"SWV":"Swe Fly",
"SXR":"Sky Express",
"SXS":"SunExpress",
"SYL":"Aircompany Yakutia",
"SYR":"Syrian Arab Airlines",
"SYX":"Skywalk Airlines",
"SZB":"Aerolineas heredas santa maria",
"SZZ":"SUR Lineas Aereas",
"TAE":"TAME",
"TAH":"Air Moorea",
"TAK":"Tatarstan Airlines",
"TAM":"TAM Brazilian Airlines",
"TAN":"Zanair",
"TAO":"Aeromar",
"TAP":"TAP Portugal",
"TAR":"Tunisair",
"TAT":"Grupo TACA",
"TBZ":"TrasBrasil",
"TCF":"Shuttle America",
"TCG":"Thai Air Cargo",
"TCV":"TACV",
"TCW":"Thomas Cook Airlines",
"TCX":"Thomas Cook Airlines",
"TDK":"Transavia Denmark",
"TEZ":"Tez Jet Airlines",
"TFL":"Arkefly",
"TFN":"Norwegian Aviation College",
"TGN":"Trigana Air Service",
"TGW":"Tiger Airways",
"TGZ":"Georgian Airways",
"THA":"Thai Airways International",
"THI":"TransHolding",
"THK":"Turk Hava Kurumu Hava Taksi Isletmesi",
"THS":"TransBrasil Airlines",
"THT":"Air Tahiti Nui",
"THY":"Turkish Airlines",
"TIB":"TRIP Linhas A",
"TIL":"Tajikistan International Airlines",
"TJA":"T.J. Air",
"TJT":"Twin Jet",
"TKS":"Tomsk-Avia",
"TLA":"Translift Airways",
"TMA":"Trans Mediterranean Airlines",
"TNA":"TransAsia Airways",
"TNM":"Tiara Air",
"TNS":"Transilvania",
"TNU":"TransNusa Air",
"TOK":"Airlines PNG",
"TOM":"Thomsonfly",
"TOS":"Tropic Air",
"TPA":"TAMPA",
"TRA":"Transavia Holland",
"TRK":"Turkuaz Airlines",
"TRS":"AirTran Airways",
"TSC":"Air Transat",
"TSO":"Transaero Airlines",
"TTZ":"Transair",
"TUA":"Turkmenistan Airlines",
"TUI":"Tuninter",
"TUR":"ATUR",
"TUS":"ABSA - Aerolinhas Brasileiras",
"TVF":"Transavia France",
"TVJ":"Thai Vietjet Air",
"TVS":"Travel Service",
"TWB":"Tway Airlines",
"TWD":"Turkish Wings Domestic",
"TWN":"Avialeasing Aviation Company",
"TXW":"Texas Wings",
"TYR":"Tyrolean Airways",
"TYS":"TransHolding System",
"UAC":"United Air Charters",
"UAE":"Emirates",
"UAL":"United Airlines",
"UAT":"Ukraine Atlantic",
"UAY":"University of Birmingham Air Squadron (RAF)",
"UBA":"Myanma Airways",
"UBD":"United Airways",
"UBG":"US-Bangla Airlines",
"UCA":"CommutAir",
"UDC":"DonbassAero",
"UDN":"Dniproavia",
"UGX":"East African",
"UIA":"Uni Air",
"UJX":"AtlasGlobal Ukraine",
"UKM":"UM Airlines",
"UMK":"Yuzhmashavia",
"UPA":"Air Foyle",
"URN":"Turan Air",
"USA":"US Airways",
"USH":"US Helicopter",
"UTA":"UTair Aviation",
"UTY":"Alliance Airlines",
"UWW":"LSM International",
"UZB":"Uzbekistan Airways",
"VAS":"ATRAN Cargo Airlines",
"VAX":"V Air",
"VBW":"Air Burkina",
"VCV":"Conviasa",
"VDA":"Volga-Dnepr Airlines",
"VEX":"Virgin Express",
"VFC":"Vasco Air",
"VGN":"Virgin Nigeria Airways",
"VIA":"VIA Líneas Aéreas",
"VIM":"Air VIA",
"VIR":"Virgin Atlantic Airways",
"VIS":"Vision Air International",
"VJC":"VietJet Air",
"VKH":"Viking Hellas",
"VKJ":"VickJet",
"VLE":"Volare Airlines",
"VLG":"Vueling Airlines",
"VLK":"Vladivostok Air",
"VLM":"VLM Airlines",
"VLO":"Varig Log",
"VLU":"Valuair",
"VNP":"Virgin Pacific",
"VOE":"VOLOTEA Airways",
"VOI":"Volaris",
"VOO":"Volotea",
"VOZ":"Virgin Australia",
"VQI":"Flyme (VP)",
"VRD":"Virgin America",
"VRN":"VRG Linhas Aereas",
"VSP":"VASP",
"VSV":"Scat Air",
"VTA":"Air Tahiti",
"VTI":"Air Vistara",
"VUE":"AD Aviation",
"VUN":"Air Ivoire",
"VVC":"VivaColombia",
"VVM":"Viva Macau",
"VVN":"88",
"VWA":"Virginwings",
"WAJ":"AirAsia Japan",
"WAL":"Western Airlines",
"WAU":"Wizz Air Ukraine",
"WBA":"Finncomm Airlines",
"WEB":"WebJet Linhas A",
"WEN":"WestJet Encore",
"WER":"AeroWorld",
"WFX":"Westfalia Express VA",
"WIF":"Widerøe",
"WJA":"WestJet",
"WLC":"Welcome Air",
"WOA":"World Airways",
"WON":"Wings Air",
"WOW":"Air Southwest",
"WRC":"Wind Rose Aviation",
"WSS":"World Scale Airlines",
"WTA":"Africa West",
"WTJ":"Whitejets",
"WVL":"Wizz Air Hungary",
"WZZ":"Wizz Air",
"XAN":"Southjet cargo",
"XAU":"XAIR USA",
"XAX":"AirAsia X",
"XBM":"CBM America",
"XEL":"Excel Charter",
"XLA":"Excel Airways",
"XOJ":"XOJET",
"XPT":"XPTO",
"XSR":"Executive AirShare",
"YCC":"Ciel Canadien",
"YCP":"Canadian National Airways",
"YEL":"Yellowtail",
"YEP":"YES Airways",
"YZZ":"LSM AIRLINES",
"ZCS":"Southjet connect",
"ZNA":"Zenith International Airline",
"ZTF":"Mongolian International Air Lines",
"ZTT":"ZABAIKAL AIRLINES",
"ZXY":"Japan Regio",
"ZZZ":"Zabaykalskii Airlines"
}
```

- [ ] **Step 2 (optional, network): Rebuild it and compare**

Run: `node tools/build-airlines.ts --out node_modules/.cache/openflights/airlines.json && cmp node_modules/.cache/openflights/airlines.json shared/airlines.json && echo identical`
Expected: `wrote node_modules/.cache/openflights/airlines.json: 1025 airlines, 25316 bytes`, then `identical`. OpenFlights edits `airlines.dat` rarely. If `cmp` reports a difference, the upstream file has changed since 2026-09-22 (its sha256 then differs from the one above). Keep the committed content from Step 1. Refreshing the table is a separate, deliberate change: run `node tools/build-airlines.ts` and name the upstream change in the commit body.

- [ ] **Step 3: Commit**

```bash
git add shared/airlines.json
git commit -m "feat(data): ICAO airline names from OpenFlights (ODbL), 1025 active airlines" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `airlineOf`

**Files:**
- Create: `shared/airlines.ts`, `shared/airlines.test.ts`
- Test: `shared/airlines.test.ts`

**Interfaces:**
- Consumes: `shared/airlines.json` (Task 2)
- Produces: `airlineOf(callsign: string | null): string | null` (PLAN.md §5.3 B-C2) · `AIRLINES_CREDIT: string`. Consumed by B-A, which builds the detail panel's `Lookup.airline` as `airlineOf(callsign)` and adds `AIRLINES_CREDIT` to the credits. The table's airline data (~25 KB, ~10 KB gzipped) is bundled with whatever imports `shared/airlines.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// shared/airlines.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AIRLINES_CREDIT, airlineOf } from './airlines.ts'

test('airlineOf: ICAO designator + flight number → airline name', () => {
  assert.equal(airlineOf('ELY5450'), 'El Al Israel Airlines')
  assert.equal(airlineOf('UAE954'), 'Emirates')
  assert.equal(airlineOf('BAW1'), 'British Airways')
  assert.equal(airlineOf('EZY84TL'), 'easyJet')
  assert.equal(airlineOf('SWR1234'), 'Swiss International Air Lines')
})

test('airlineOf: null and empty → null', () => {
  assert.equal(airlineOf(null), null)
  assert.equal(airlineOf(''), null)
  assert.equal(airlineOf('   '), null)
})

test('airlineOf: registrations used as callsigns → null', () => {
  for (const reg of ['N123AB', 'N1', 'GABCD', 'DAIBC', 'HBJVA', 'CGABC', '4XEKA', 'RA89001', 'JA01XJ', 'B1234']) {
    assert.equal(airlineOf(reg), null, reg)
  }
})

test('airlineOf: readsb padding and lower case are tolerated', () => {
  assert.equal(airlineOf('ELY5450 '), 'El Al Israel Airlines')
  assert.equal(airlineOf('uae954'), 'Emirates')
})

test('airlineOf: no flight number, letter-first suffix, too long or unknown designator → null', () => {
  for (const cs of ['ELY', 'ELYA12', 'ELY 12', 'ELY123456', 'XXX123', 'EL5450']) assert.equal(airlineOf(cs), null, cs)
})

test('credit line names the source and its licence', () => {
  assert.match(AIRLINES_CREDIT, /OpenFlights/)
  assert.match(AIRLINES_CREDIT, /ODbL/)
})

test('airlines.json: sorted 3-letter keys, trimmed non-empty names, about a thousand entries', () => {
  const names: Record<string, string> = JSON.parse(readFileSync(new URL('./airlines.json', import.meta.url), 'utf8'))
  const keys = Object.keys(names)
  assert.ok(keys.length >= 1000, `${keys.length} entries`)
  assert.deepEqual(keys, [...keys].sort())
  for (const k of keys) {
    assert.match(k, /^[A-Z]{3}$/)
    assert.ok(names[k] !== '' && names[k] === names[k].trim(), `${k}: ${JSON.stringify(names[k])}`)
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test shared/airlines.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/shared/airlines.ts' imported from …/shared/airlines.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// shared/airlines.ts
// Airline names by ICAO designator. Data: OpenFlights airline database (https://openflights.org/data),
// Open Database License 1.0 / Database Contents License 1.0; rebuilt by tools/build-airlines.ts.
import names from './airlines.json' with { type: 'json' }

const NAMES: Readonly<Record<string, string>> = names

/** Attribution line for the UI credits (ODbL requires it wherever airline names are shown). */
export const AIRLINES_CREDIT = 'Airline names: OpenFlights (ODbL)'

/**
 * ICAO flight identification: a 3-letter operator designator, then a flight number that starts with a digit
 * (ELY5450, UAE954, EZY84TL), at most 8 characters as ADS-B carries. Registrations flown as callsigns (N123AB, GABCD,
 * DAIBC) fail the pattern.
 * ponytail: letter-first flight numbers (rare, e.g. some military "ABC" + "A1") return null, and a registration that
 * happens to read as designator + digits (UP-A3001 → UPA3001) returns that designator's name; the upgrade path is to
 * cross-check the aircraft's registration (AircraftInfo.reg) when it is known.
 */
const FLIGHT_ID = /^[A-Z]{3}\d[A-Z0-9]{0,4}$/

/** Airline name for a callsign such as 'ELY5450' (→ 'El Al Israel Airlines'); null when it is not an airline flight id. */
export function airlineOf(callsign: string | null): string | null {
  if (callsign === null) return null
  const cs = callsign.trim().toUpperCase()
  return FLIGHT_ID.test(cs) ? (NAMES[cs.slice(0, 3)] ?? null) : null
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test shared/airlines.test.ts`
Expected: PASS — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add shared/airlines.ts shared/airlines.test.ts
git commit -m "feat(shared): airlineOf, ICAO designator prefix to airline name" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: Run every test this package owns**

Run: `node --test shared/airlines.test.ts tools/build-airlines.test.ts`
Expected: `ℹ tests 15`, `ℹ pass 15`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'shared/airlines|tools/build-airlines'`
Expected: no output (grep exits 1). On a branch where every merged package is complete, `npm run check` must also pass.

- [ ] **Step 3: Confirm everything is committed and record the gate**

```bash
git status --short -- shared/airlines.ts shared/airlines.test.ts shared/airlines.json tools/build-airlines.ts tools/build-airlines.test.ts
git commit --allow-empty -m "chore(shared): WP-B-C2 gate passed (15 tests, tsc clean)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `git status` prints nothing before the commit. The branch `wp/B-C2` is ready to merge.
