# WP-B-U2 — Detail Panel + Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an aircraft is selected, a left-hand panel in the style of adsb.lol's tar1090 view describes it. The header shows the callsign and hex, a copy-link button and a close button. Then come a planespotters.net photo with its credit, the registration with the country flag and name, airline, DB flags, type, squawk (emergencies highlighted) and route. Below that are collapsible **Spatial**, **Signal**, **FMS SEL** and **Wind** sections. The panel can be updated every frame at no measurable cost, and it rewrites its text at most 4 times a second.

**Architecture:** Two modules and one stylesheet.
- `client/ui/photo.ts`: `PhotoCache.get(hex)` fetches `https://api.planespotters.net/pub/photos/hex/{HEX}` and maps the first photo to `{ thumbUrl, link, photographer }`. `thumbUrl` is `thumbnail_large.src`, else `thumbnail.src`. Only `https:` URLs pass, and a photo without a credit is dropped, because the credit is required. The cache is one `Map<hex, Promise>`, so concurrent `get`s for a hex share one request. An answer (a photo, or "none") is kept for the session. A network error (including a CORS refusal), an HTTP error or an unreadable body is forgotten, so the next selection retries, and `failed(hex)` then reports it so the panel can tell "Photo unavailable" from "No photo". `~` (non-ICAO) hexes never go out. The timeout is 8 s.
- `client/ui/detail.ts`:
  - `detailRows(s, raw, info, lookup)` is pure. It always returns the same 6 sections and 27 rows, in the same order, with `'—'` for unknown values.
  - Precedence: `RenderState` wins for what moves (speed, baro altitude, track, position), `AircraftInfo` wins for identity, and the raw readsb object supplies the rest (WGS84 altitude, vertical rate, signal, FMS, wind). A `raw` or `info` whose hex differs from the selection is ignored, so stale data from the previous selection never shows.
  - `mountDetail` builds the DOM once from that fixed shape and keeps one slot per row. `update()` may be called every frame. A changed selection renders at once. Otherwise there is at most one render per 250 ms, plus one trailing timer so the newest state always lands. A render writes only the texts that changed, and only through `textContent`. The photo is requested once per selection, and an answer that arrives after the selection moved on is dropped. A photo that fails to load hides its credit too. `lookup(hex, callsign)` runs once per hex and callsign. Numbers go through one module-level `Intl.NumberFormat`: `Number#toLocaleString` builds a formatter per call, and it made `detailRows()` 26 times slower (87 µs instead of 3.3 µs).
- `client/ui/detail.css`: a 300 px dark translucent panel at the top left, in the palette of `table.css`. It stops 236 px above the bottom so the chase HUD (bottom left) stays visible, and it scrolls inside itself. The header is sticky. Sections are native `<details>` elements (collapsible with no JS). The photo sits in a 3:2 box, so nothing jumps when it loads.

Units and formats: groundspeed `kt`; baro altitude `ft` with `▲`/`▼` when |vertical rate| ≥ 250 ft/min (`ground` on the ground); WGS84 altitude `ft` from `alt_geom`, with a caveat tooltip unless ADS-B v2; vertical rate `±ft/min` (`baro_rate`, else `geom_rate`, else the filter's rate rounded to 10); track and selected heading `000°`; position `lat°, lon°` to 3 decimals; source `ADS-B v0/v1/v2`, `ADS-R`, `MLAT`, `TIS-B`, `Mode S`, `ADS-C` or `other` from readsb's `type`, else from `RenderState.quality`; RSSI `dBFS` to 0.1; last position and last seen `s` to 0.1; selected altitude `ft` (`nav_altitude_mcp`, else `nav_altitude_fms`); QNH `hPa` to 0.1; FMS modes as listed; wind `kt / 000°` (only when both `ws` and `wd` are known); OAT and TAT `°C`. Squawks 7500/7600/7700 and any readsb `emergency` other than `none` are highlighted, and also spelled out (for example "7700 · emergency"), so the warning does not rely on colour alone.

Conventions consumers (B-A) rely on:
- Call `update(s, raw, info)` every frame with whatever is known (`raw` and `info` from `ChaseResponse`). `update(null, null, null)` hides the panel (browse mode).
- `lookup(hex, callsign)` gets the lower-case hex and the callsign. B-A answers `{ country: c && { ...c, flag: flagEmoji(c.iso2) }, airline: airlineOf(callsign) }` with `c = countryOf(hex)` (B-C1, B-C2).
- Pass one `PhotoCache` for the app's lifetime (the cache lives in the instance). Without `photos` the photo box is hidden. The API is called from the browser. It sometimes answers without CORS headers, which counts as a failure: "Photo unavailable", retried on the next selection.
- `onClose` is the close button: B-A deselects and returns to browse.
- The copy-link button copies `location.origin + '/?hex=' + hex`, which `readParams()` in `client/app.ts` reads. Where the async clipboard is missing (plain http off localhost), it falls back to `window.prompt`.
- The panel is `.fh-detail` (`position: absolute; z-index: 11`) in the given root. B-A's `layout.css` may move it.
- Distance is not shown: the contract gives the panel no reference position.

**Tech Stack:** DOM and CSS (no framework), the planespotters.net public photo API (browser `fetch`), `node:test`. The `mountDetail` tests run on a fake DOM of about 50 lines, holding only the calls `detail.ts` makes, with `mock.timers` (`Date` and `setTimeout`). As in `client/app.test.ts`, `module.registerHooks` loads `.css` as an empty module in Node.

**Wave:** B (parallel; depends only on B0). Consumed by B-A. **Estimated:** 2 h. **Validated:** on 2026-09-22 in the integrated tree (all WPs + B0, Node 25.2.1, TypeScript 7.0.2). `node --test client/ui/photo.test.ts client/ui/detail.test.ts` → 27/27 pass. `npx tsc --noEmit` reports nothing in this package's files, and `npm run check` in the tree → tsc clean, 611/611. Replay: this plan's code blocks were extracted into an isolated copy holding only WP-00/B0's type files (`shared/{types,api,info,readsb}.ts`, `client/types.ts`, `client/track/types.ts`) and V6's HUD. Task 1 failed (module not found), then passed 9/9. Task 2 failed, then passed 27/27. Full `tsc --noEmit` exit 0, and every file byte-identical to the tree. Mutations, each caught by at least one test: no stale-photo guard, no throttle, no trailing render, no raw-hex check, destroy keeping the timer, lookup every render, trend threshold 100, errors cached, no in-flight dedupe, no https check, `failed` never set or never cleared, no "Photo unavailable" note, an image error keeping the credit. Browser (the in-app Chrome, Vite on :5415, 1280×800): `play` for 9.6 s ran 960 frames at 100 fps (frame p95 11.9 ms), with `detail.update()` ≤ 6.5 µs per frame on average (bounded by the browser's timer resolution) and the text rewritten 3.96 times/s (limit 4). `bench`, 3 runs: throttled `update()` 58–73 ns per call (200,000 calls); a full render (every row, new selection) 13.1–14.7 µs; `detailRows()` 3.2–3.4 µs (87 µs before the shared `Intl.NumberFormat`). Also checked there: the golden aircraft with its real planespotters photo (420×280) and credit; 7700 on red; the MLAT and TIS-B scenarios; collapsing Spatial; close → hidden; copy link (the embedded browser refused the clipboard with NotAllowedError, and the prompt fallback got `http://localhost:5415/?hex=4691c4`); satellite and snow backgrounds; 375×812 with no sideways scroll. planespotters.net got 3 requests in all (1 curl, 2 from the browser), within the 5 allowed.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- This package creates only the files below. It reads B0's `shared/info.ts` and WP-00's `shared/types.ts`, `shared/api.ts`, `client/types.ts`. The harness also mounts V6's `client/ui/hud.ts` to check that the two do not overlap.
- Unit tests never touch the network: `PhotoCache` takes a fake `fetch`.
- Photos are requested only for the selected aircraft, and planespotters' credit and link-back are always shown with the image. Call the API from the browser only: it refuses server User-Agents that lack a contact URL or email.
- No code, tables, icons or colours from tar1090, dump1090 or any other GPL project. The labels, layout and colours here are this package's own. The facts used are ICAO's special-purpose squawks (7500/7600/7700) and readsb's `dbFlags` bits and `type` values.

## Source verification (planespotters.net, 2026-09-22)

- **Terms of Use**, https://www.planespotters.net/legal/termsofuse, read through search-engine excerpts. The page itself sits behind a Cloudflare browser check, which was not bypassed. The terms say that planespotters.net provides thumbnails to partner websites, which must attribute the author as "Copyright © name" or "© name" and link back to the original photo on planespotters.net. Using thumbnails without that attribution is prohibited. Copying or publishing the photos themselves needs the author's permission. So the panel shows `Image © {photographer}` linking to the photo page, the image links there too, and images are hotlinked from planespotters' CDN, never stored.
- **API page**, https://www.planespotters.net/photo/api: behind the same check, not read directly. Its rules are quoted by the API's own error message (below).
- **Live check 1** (curl, User-Agent `FlightHopper/0.1 (personal ADS-B viewer; verification)`, `Origin: http://localhost:5415`): HTTP 403 with the JSON error "Server User-Agent strings must include a contact URL or email so we can reach you … See https://www.planespotters.net/photo/api". Response headers: `access-control-allow-origin: *`, `access-control-allow-methods: GET, OPTIONS`, `cache-control: no-store`. So browsers may call it from any origin, and servers must identify themselves.
- **Live check 2** (the harness in the in-app Chrome, origin `http://localhost:5415`, the browser's own User-Agent): refused by CORS. Chrome logged "No 'Access-Control-Allow-Origin' header is present on the requested resource" (`net::ERR_FAILED`), so `PhotoCache` treated it as a failure (not cached, `failed()` true).
- **Live check 3** (the same page, reloaded a few minutes later): HTTP 200 from the same origin. The first photo was `thumbnail_large` https://t.plnspttrs.net/15536/1966058_c2565ec62d_280.jpg (420×280), `link` https://www.planespotters.net/photo/1966058/sx-dnd-aegean-airlines-airbus-a320-232-wl?utm_source=api, `photographer` Marvin Knitl. The panel showed the image and `Image © Marvin Knitl`, both linking to that page. So browsers may call the API cross-origin, but not every time. A third party reports the same intermittent refusal: a direct-browser check from `http://127.0.0.1:5174` on 2026-09-21 got status 0 (https://github.com/vasilyevstan/LiveTrafficStan/pull/85). The same PR quotes the API page as "CORS-enabled for a valid site Origin/Referer" and says its terms prohibit proxying and re-exposing responses, so this package adds no server proxy.
- **Data licences:** the golden aircraft object is adsb.lol data (© adsb.lol contributors, ODbL 1.0). Photos stay on planespotters.net's CDN, © their photographers, and are shown with the required credit and link-back. Nothing is stored or shipped.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/ui/photo.ts` | `Photo`, `PhotoCache` (`get`, `failed`), `photoUrl`, `toPhoto` |
| `client/ui/photo.test.ts` | mapping, https and credit checks, one request per hex, errors not cached and reported by `failed`, `~` hexes offline |
| `client/ui/detail.ts` | `Lookup`, `SectionId`, `DetailRow`, `DetailSection`, `DetailOpts`, `DetailHandle`, `UPDATE_MS`, `sourceLabel`, `shareLink`, `detailRows`, `mountDetail` |
| `client/ui/detail.css` | the panel's look |
| `client/ui/detail.test.ts` | golden aircraft rows, fixed shape, precedence, emergencies, `mountDetail` on a fake DOM (throttle, photo, failed photo, image error, lookup, close, destroy) |
| `harness/detail.html`, `harness/detail.ts` | manual check: scenarios over map-like backgrounds with the HUD, a real photo, a `?photos=demo` placeholder, per-frame `play` and a `bench` |

---

### Task 1: Photo lookup

**Files:**
- Create: `client/ui/photo.ts`, `client/ui/photo.test.ts`
- Test: `client/ui/photo.test.ts`

**Interfaces:**
- Consumes: nothing (the browser's `fetch`, or an injected one)
- Produces: `interface Photo { thumbUrl: string; link: string; photographer: string }` · `class PhotoCache { constructor(fetchFn?: typeof fetch); get(hex: string): Promise<Photo | null> }`, plus the extra `failed(hex: string): boolean` · `photoUrl(hex: string): string` · `toPhoto(body: unknown): Photo | null`

- [ ] **Step 1: Write the failing test**

```ts
// client/ui/photo.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PhotoCache, photoUrl, toPhoto } from './photo.ts'

// Shape of a planespotters.net /pub/photos/hex answer (field names as the API returns them; values made up).
const BODY = {
  photos: [
    {
      id: '1234567',
      thumbnail: { src: 'https://t.plnspttrs.net/12345/1234567_abcdef0123_t.jpg', size: { width: 200, height: 133 } },
      thumbnail_large: { src: 'https://t.plnspttrs.net/12345/1234567_abcdef0123_280.jpg', size: { width: 420, height: 280 } },
      link: 'https://www.planespotters.net/photo/1234567/sx-dnd-aegean-airlines-airbus-a320-232',
      photographer: 'A. Spotter',
    },
    {
      id: '7654321',
      thumbnail: { src: 'https://t.plnspttrs.net/1/2_t.jpg', size: { width: 200, height: 133 } },
      link: 'https://www.planespotters.net/photo/7654321/second',
      photographer: 'Someone Else',
    },
  ],
}

interface Call { url: string }

/** A fetch that answers from a script and records the URLs asked for. `gate` holds every answer until released. */
function fakeFetch(answer: (url: string) => Response | Error, gate?: Promise<void>): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push({ url })
    if (gate) await gate
    const a = answer(url)
    if (a instanceof Error) throw a
    return a
  }) as typeof fetch
  return { fn, calls }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('photoUrl: upper-case hex on the public endpoint', () => {
  assert.equal(photoUrl('4691c4'), 'https://api.planespotters.net/pub/photos/hex/4691C4')
})

test('toPhoto: first photo, large thumbnail preferred, photo page and photographer', () => {
  assert.deepEqual(toPhoto(BODY), {
    thumbUrl: 'https://t.plnspttrs.net/12345/1234567_abcdef0123_280.jpg',
    link: 'https://www.planespotters.net/photo/1234567/sx-dnd-aegean-airlines-airbus-a320-232',
    photographer: 'A. Spotter',
  })
  // Only the small thumbnail: use it.
  assert.equal(toPhoto({ photos: [BODY.photos[1]] })?.thumbUrl, 'https://t.plnspttrs.net/1/2_t.jpg')
})

test('toPhoto: no photos, malformed entries, missing credit or non-https URLs → null', () => {
  assert.equal(toPhoto({ photos: [] }), null)
  assert.equal(toPhoto({}), null)
  assert.equal(toPhoto(null), null)
  assert.equal(toPhoto({ photos: [{ ...BODY.photos[0], photographer: '  ' }] }), null) // credit is required by the terms
  assert.equal(toPhoto({ photos: [{ ...BODY.photos[0], link: 'javascript:alert(1)' }] }), null)
  assert.equal(toPhoto({ photos: [{ ...BODY.photos[0], thumbnail_large: { src: 'http://t.plnspttrs.net/x.jpg' }, thumbnail: undefined }] }), null)
})

test('PhotoCache: one request per hex, hits and misses cached for the session', async () => {
  const { fn, calls } = fakeFetch((url) => (url.endsWith('/4691C4') ? json(BODY) : json({ photos: [] })))
  const photos = new PhotoCache(fn)
  const a = await photos.get('4691c4')
  assert.equal(a?.photographer, 'A. Spotter')
  assert.equal(await photos.get('4691C4'), a) // same object, case-insensitive hex
  assert.equal(await photos.get('abcdef'), null)
  assert.equal(await photos.get('abcdef'), null)
  assert.deepEqual(calls.map((c) => c.url), [
    'https://api.planespotters.net/pub/photos/hex/4691C4',
    'https://api.planespotters.net/pub/photos/hex/ABCDEF',
  ])
})

test('PhotoCache: concurrent gets for one hex share one in-flight request', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { fn, calls } = fakeFetch(() => json(BODY), gate)
  const photos = new PhotoCache(fn)
  const p1 = photos.get('4691c4')
  const p2 = photos.get('4691c4')
  assert.equal(p1, p2)
  release()
  assert.equal((await p1)?.photographer, 'A. Spotter')
  assert.equal(calls.length, 1)
})

test('PhotoCache: HTTP and network errors are not cached, so the next selection retries', async () => {
  let fail: Response | Error = json({ error: 'nope' }, 503)
  const { fn, calls } = fakeFetch(() => fail)
  const photos = new PhotoCache(fn)
  assert.equal(await photos.get('4691c4'), null)
  assert.equal(photos.failed('4691C4'), true) // failed, as opposed to "no photo exists"
  fail = new TypeError('Failed to fetch') // what a browser reports when CORS refuses the origin
  assert.equal(await photos.get('4691c4'), null)
  fail = new Response('not json', { status: 200 })
  assert.equal(await photos.get('4691c4'), null)
  fail = json(BODY)
  assert.equal((await photos.get('4691c4'))?.photographer, 'A. Spotter')
  assert.equal(photos.failed('4691c4'), false)
  assert.equal(calls.length, 4)
})

test('PhotoCache: failed() is false for a real miss and for a hex never asked', async () => {
  const { fn } = fakeFetch(() => json({ photos: [] }))
  const photos = new PhotoCache(fn)
  assert.equal(photos.failed('abcdef'), false)
  assert.equal(await photos.get('abcdef'), null)
  assert.equal(photos.failed('abcdef'), false)
})

test('PhotoCache: a fetch that throws synchronously is not cached either', async () => {
  let n = 0
  const fn = ((): Promise<Response> => {
    n++
    if (n === 1) throw new Error('sync failure')
    return Promise.resolve(json(BODY))
  }) as typeof fetch
  const photos = new PhotoCache(fn)
  assert.equal(await photos.get('4691c4'), null)
  assert.equal((await photos.get('4691c4'))?.photographer, 'A. Spotter')
  assert.equal(n, 2)
})

test('PhotoCache: non-ICAO (~) and malformed hexes never reach the network', async () => {
  const { fn, calls } = fakeFetch(() => json(BODY))
  const photos = new PhotoCache(fn)
  assert.equal(await photos.get('~a330e6'), null)
  assert.equal(await photos.get('xyz'), null)
  assert.equal(await photos.get(''), null)
  assert.equal(calls.length, 0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/ui/photo.test.ts`
Expected: FAIL, `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/ui/photo.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// client/ui/photo.ts
// Aircraft photos for the detail panel from the planespotters.net public photo API, asked only for the selected
// aircraft. Terms (planespotters.net Terms of Use, checked 2026-09-22): a thumbnail must show the author credit as
// "© name" and link back to the photo's page on planespotters.net, which the panel does. Browsers may call it
// cross-origin: from http://localhost:5415 on 2026-09-22 one request came back without CORS headers (refused, a
// retryable error here) and the next returned the photo. It refuses server User-Agents without a contact URL or email.

export interface Photo {
  thumbUrl: string // https image on planespotters' CDN; hotlinked, never copied
  link: string // the photo's page on planespotters.net (the required link-back)
  photographer: string // the required credit: "Image © {photographer}"
}

const API = 'https://api.planespotters.net/pub/photos/hex/'
const ICAO_HEX = /^[0-9a-f]{6}$/ // '~' hexes are non-ICAO (TIS-B / anonymous): no airframe to look up
const TIMEOUT_MS = 8000

export function photoUrl(hex: string): string {
  return API + hex.toUpperCase()
}

const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  try {
    return new URL(v).protocol === 'https:' ? v : null // never put javascript: or http: into an href or src
  } catch {
    return null
  }
}

/** The API's first photo as a Photo, or null when there is none or it lacks a usable image, link or credit. */
export function toPhoto(body: unknown): Photo | null {
  const first = (body as { photos?: unknown } | null)?.photos
  const p = Array.isArray(first) ? (first[0] as Record<string, unknown> | undefined) : undefined
  if (typeof p !== 'object' || p === null) return null
  const src = (k: string): unknown => (p[k] as { src?: unknown } | undefined)?.src
  const thumbUrl = httpsUrl(src('thumbnail_large')) ?? httpsUrl(src('thumbnail'))
  const link = httpsUrl(p.link)
  const photographer = typeof p.photographer === 'string' ? p.photographer.trim() : ''
  return thumbUrl && link && photographer ? { thumbUrl, link, photographer } : null
}

/**
 * Per-hex photo lookups for the session. Each hex is asked at most once while its request is in flight, and an answer
 * (a photo, or "none") is kept for the session. Network errors, HTTP errors and unreadable bodies are not kept, so
 * selecting the aircraft again retries.
 * ponytail: the cache is an unbounded Map; a session selects tens to hundreds of aircraft. Upgrade: LRU if that grows.
 */
export class PhotoCache {
  #fetch: typeof fetch
  #cache = new Map<string, Promise<Photo | null>>()
  #failed = new Set<string>()

  constructor(fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
    this.#fetch = fetchFn
  }

  get(hex: string): Promise<Photo | null> {
    const key = hex.trim().toLowerCase()
    if (!ICAO_HEX.test(key)) return Promise.resolve(null)
    const hit = this.#cache.get(key)
    if (hit) return hit
    // .then runs its handlers in a later microtask, so a failure is forgotten only after the promise is stored.
    const p = this.#load(key).then(
      (photo) => {
        this.#failed.delete(key)
        return photo
      },
      () => {
        this.#cache.delete(key)
        this.#failed.add(key)
        return null
      },
    )
    this.#cache.set(key, p)
    return p
  }

  /** True when the newest lookup for hex failed (network, CORS, HTTP or unreadable body), not "no photo exists". */
  failed(hex: string): boolean {
    return this.#failed.has(hex.trim().toLowerCase())
  }

  async #load(hex: string): Promise<Photo | null> {
    const res = await this.#fetch(photoUrl(hex), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`planespotters ${res.status}`)
    return toPhoto(await res.json())
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/ui/photo.test.ts`
Expected: PASS, `ℹ tests 9`, `ℹ pass 9`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/ui/photo.ts client/ui/photo.test.ts
git commit -m "feat(ui): planespotters.net photo cache for the selected aircraft" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Detail rows and panel

**Files:**
- Create: `client/ui/detail.ts`, `client/ui/detail.css`, `client/ui/detail.test.ts`
- Test: `client/ui/detail.test.ts`

**Interfaces:**
- Consumes: `RenderState` (`client/types.ts`, WP-00), `ReadsbAircraft` and `Quality` (`shared/types.ts`, WP-00 + B0 fields), `AircraftInfo` and `toInfo` (`shared/info.ts`, B0), `PhotoCache` (Task 1)
- Produces: `interface Lookup { country: { iso2: string; name: string; flag: string } | null; airline: string | null }` · `type SectionId = 'header' | 'identity' | 'spatial' | 'signal' | 'fms' | 'wind'` · `interface DetailRow { key: string; label: string; value: string; alert: boolean; hint: string | null }` · `interface DetailSection { id: SectionId; title: string; rows: DetailRow[] }` · `detailRows(s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null, lookup: Lookup): DetailSection[]` · `mountDetail(root: HTMLElement, opts: { onClose(): void; photos?: PhotoCache; lookup(hex: string, callsign: string | null): Lookup }): { update(s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null): void; destroy(): void }` · extras `UPDATE_MS` (250), `sourceLabel(raw, quality)`, `shareLink(origin, hex)`, `DetailOpts`, `DetailHandle`

- [ ] **Step 1: Write the failing test**

The golden aircraft is a real adsb.lol object (© adsb.lol contributors, ODbL 1.0): an Aegean A320 descending towards Tel Aviv, which carries the Mode S EHS fields (wind, OAT, selected altitude) that the panel shows.

```ts
// client/ui/detail.test.ts
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { toInfo } from '../../shared/info.ts'
import type { ReadsbAircraft } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import type { DetailSection, Lookup } from './detail.ts'
import { PhotoCache } from './photo.ts'

// detail.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { UPDATE_MS, detailRows, mountDetail, shareLink, sourceLabel } = await import('./detail.ts')

// A real adsb.lol /v2/point object (LLBG cell, 2026-09-22; © adsb.lol contributors, ODbL 1.0): an Aegean A320
// descending towards Tel Aviv. It carries the Mode S EHS fields (wind, OAT, selected altitude) the panel shows.
const RAW: ReadsbAircraft = {
  hex: '4691c4', type: 'adsb_icao', flight: 'AEE4266 ', r: 'SX-DND', t: 'A320', alt_baro: 7975, alt_geom: 8500, gs: 337.1,
  ias: 280, tas: 322, mach: 0.488, wd: 231, ws: 24, oat: 14, tat: 27, track: 101.81, track_rate: 0.06, roll: 0.53,
  mag_heading: 100.2, true_heading: 105.24, baro_rate: -960, geom_rate: -928, squawk: '7421', emergency: 'none',
  category: 'A3', nav_qnh: 1012.0, nav_altitude_mcp: 4992, lat: 32.371902, lon: 34.43291, nic: 8, rc: 186, seen_pos: 0.09,
  version: 2, nic_baro: 1, nac_p: 9, nac_v: 1, sil: 3, gva: 2, sda: 2, mlat: [], tisb: [], messages: 9956, seen: 0.0, rssi: -4.0,
}
const INFO = toInfo(RAW, 'LGAV-LLBG') // the route is made up for the test
const S: RenderState = {
  hex: '4691c4', lat: 32.371902, lon: 34.43291, hM: 2620, headingDeg: 105.24, pitchDeg: -1.5, rollDeg: 0.5, gsKt: 337.1,
  trackDeg: 101.81, altBaroFt: 7975, vsFpm: -951, mode: 'interp', altSource: 'geom', onGround: false, ageS: -0.8,
  quality: 'adsb2', callsign: 'AEE4266', typeCode: 'A320',
}
const GR: Lookup = { country: { iso2: 'GR', name: 'Greece', flag: '🇬🇷' }, airline: 'Aegean Airlines' }
const NONE: Lookup = { country: null, airline: null }

const flat = (sections: DetailSection[]): Record<string, string> =>
  Object.fromEntries(sections.flatMap((sec) => sec.rows.map((r) => [r.key, r.value])))
const shape = (sections: DetailSection[]): string[] => sections.map((sec) => `${sec.id}:${sec.title}:${sec.rows.map((r) => r.key).join(',')}`)

test('detailRows: the golden aircraft, every section, with units', () => {
  assert.deepEqual(flat(detailRows(S, RAW, INFO, GR)), {
    callsign: 'AEE4266', hex: '4691C4',
    reg: 'SX-DND', country: '🇬🇷 Greece', airline: 'Aegean Airlines', dbFlags: '—', type: 'A320', squawk: '7421', route: 'LGAV – LLBG',
    gs: '337 kt', altBaro: '7,975 ft ▼', altGeom: '8,500 ft', vs: '-960 ft/min', track: '102°', pos: '32.372°, 34.433°',
    source: 'ADS-B v2', rssi: '-4.0 dBFS', messages: '9,956', posAge: '0.1 s', seen: '0.0 s',
    selAlt: '4,992 ft', selHdg: '—', qnh: '1012.0 hPa', modes: '—',
    wind: '24 kt / 231°', oat: '14 °C', tat: '27 °C',
  })
})

test('detailRows: one fixed shape, whatever is known (mountDetail builds the DOM once from it)', () => {
  const full = shape(detailRows(S, RAW, INFO, GR))
  assert.deepEqual(full, [
    'header::callsign,hex',
    'identity::reg,country,airline,dbFlags,type,squawk,route',
    'spatial:Spatial:gs,altBaro,altGeom,vs,track,pos',
    'signal:Signal:source,rssi,messages,posAge,seen',
    'fms:FMS SEL:selAlt,selHdg,qnh,modes',
    'wind:Wind:wind,oat,tat',
  ])
  assert.deepEqual(shape(detailRows(null, null, null, NONE)), full)
})

test('detailRows: nothing known → every value is —', () => {
  for (const v of Object.values(flat(detailRows(null, null, null, NONE)))) assert.equal(v, '—')
})

test('detailRows: RenderState alone (no raw object or info yet)', () => {
  const v = flat(detailRows(S, null, null, NONE))
  assert.equal(v.callsign, 'AEE4266')
  assert.equal(v.type, 'A320')
  assert.equal(v.gs, '337 kt')
  assert.equal(v.altBaro, '7,975 ft ▼') // trend from the filter's vsFpm
  assert.equal(v.vs, '-950 ft/min') // the filter's rate, rounded to 10
  assert.equal(v.source, 'ADS-B v2') // from RenderState.quality
  assert.equal(v.rssi, '—')
  assert.equal(v.reg, '—')
})

test('detailRows: raw object alone (callsign trimmed, ground, climbing, military, other sources)', () => {
  const v = flat(detailRows(null, { ...RAW, alt_baro: 'ground', dbFlags: 1 | 8 }, null, NONE))
  assert.equal(v.callsign, 'AEE4266')
  assert.equal(v.hex, '4691C4')
  assert.equal(v.altBaro, 'ground')
  assert.equal(v.dbFlags, 'military · LADD')
  assert.equal(v.pos, '32.372°, 34.433°')
  assert.equal(flat(detailRows(null, { ...RAW, baro_rate: 1792 }, null, NONE)).altBaro, '7,975 ft ▲')
  assert.equal(flat(detailRows(null, { ...RAW, baro_rate: 128 }, null, NONE)).altBaro, '7,975 ft') // level: no arrow
  assert.equal(flat(detailRows(null, { ...RAW, baro_rate: undefined }, null, NONE)).vs, '-928 ft/min') // geometric rate
})

test('detailRows: a raw object or info for another hex is ignored (stale data from the previous selection)', () => {
  const v = flat(detailRows(S, { ...RAW, hex: 'a1b2c3', r: 'N1' }, { ...INFO, hex: 'a1b2c3', reg: 'N1' }, NONE))
  assert.equal(v.reg, '—')
  assert.equal(v.rssi, '—')
  assert.equal(v.hex, '4691C4')
})

test('detailRows: emergency squawks and the emergency field are flagged', () => {
  const row = (raw: ReadsbAircraft) => detailRows(null, raw, null, NONE)[1].rows.find((r) => r.key === 'squawk')!
  assert.deepEqual([row(RAW).value, row(RAW).alert], ['7421', false])
  assert.deepEqual([row({ ...RAW, squawk: '7700' }).value, row({ ...RAW, squawk: '7700' }).alert], ['7700 · emergency', true])
  assert.deepEqual([row({ ...RAW, squawk: '7600' }).value, row({ ...RAW, squawk: '7600' }).alert], ['7600 · radio failure', true])
  assert.deepEqual([row({ ...RAW, squawk: '7500' }).value, row({ ...RAW, squawk: '7500' }).alert], ['7500 · hijack', true])
  const med = row({ ...RAW, squawk: '7700', emergency: 'lifeguard' })
  assert.deepEqual([med.value, med.alert], ['7700 · lifeguard', true])
  // info wins over raw for identity fields
  const i = detailRows(null, RAW, { ...INFO, squawk: '7700', emergency: 'general' }, NONE)[1].rows.find((r) => r.key === 'squawk')!
  assert.deepEqual([i.value, i.alert], ['7700 · general', true])
})

test('detailRows: WGS84 altitude is hinted as uncertain below ADS-B v2', () => {
  const geom = (raw: ReadsbAircraft) => detailRows(null, raw, null, NONE)[2].rows.find((r) => r.key === 'altGeom')!
  assert.equal(geom(RAW).hint, null)
  assert.match(geom({ ...RAW, version: 0 }).hint ?? '', /v2/)
})

test('detailRows: FMS modes, FMS altitude fallback, one-sided wind, non-ICAO hex', () => {
  const v = flat(detailRows(null, { ...RAW, nav_altitude_mcp: undefined, nav_altitude_fms: 38000, nav_heading: 42.2, nav_modes: ['autopilot', 'vnav', 'tcas'], ws: undefined }, null, NONE))
  assert.equal(v.selAlt, '38,000 ft')
  assert.equal(v.selHdg, '042°')
  assert.equal(v.modes, 'autopilot vnav tcas')
  assert.equal(v.wind, '—')
  assert.equal(flat(detailRows(null, { hex: '~A330E6' }, null, NONE)).hex, '~A330E6')
})

test('sourceLabel: readsb message types and RenderState quality', () => {
  assert.equal(sourceLabel({ hex: 'x', type: 'adsb_icao', version: 2 }, null), 'ADS-B v2')
  assert.equal(sourceLabel({ hex: 'x', type: 'adsb_icao_nt', version: 0 }, null), 'ADS-B v0')
  assert.equal(sourceLabel({ hex: 'x', type: 'adsb_other' }, null), 'ADS-B')
  assert.equal(sourceLabel({ hex: 'x', type: 'adsr_icao', version: 2 }, null), 'ADS-R')
  assert.equal(sourceLabel({ hex: 'x', type: 'mlat' }, null), 'MLAT')
  assert.equal(sourceLabel({ hex: 'x', type: 'tisb_trackfile' }, null), 'TIS-B')
  assert.equal(sourceLabel({ hex: 'x', type: 'mode_s' }, null), 'Mode S')
  assert.equal(sourceLabel({ hex: 'x', type: 'adsc' }, null), 'ADS-C')
  assert.equal(sourceLabel({ hex: 'x', type: 'other' }, null), 'other')
  assert.equal(sourceLabel(null, 'adsb01'), 'ADS-B v0/1')
  assert.equal(sourceLabel(null, 'mlat'), 'MLAT')
  assert.equal(sourceLabel(null, null), null)
})

test('shareLink: the app URL that opens this aircraft (client/app.ts readParams reads ?hex=)', () => {
  assert.equal(shareLink('http://localhost:5173', '4691c4'), 'http://localhost:5173/?hex=4691c4')
  assert.equal(shareLink('https://fh.example', '~a330e6'), 'https://fh.example/?hex=~a330e6')
})

// ---------- mountDetail on a minimal fake DOM (only what detail.ts uses) ----------

class FakeEl {
  tag: string
  children: FakeEl[] = []
  parent: FakeEl | null = null
  className = ''
  textContent = ''
  hidden = false
  title = ''
  open = false
  classes = new Set<string>()
  classList = {
    toggle: (c: string, on: boolean): void => void (on ? this.classes.add(c) : this.classes.delete(c)),
  }
  listeners = new Map<string, (() => void)[]>()
  props: Record<string, string> = {}
  constructor(tag: string) {
    this.tag = tag
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) {
      c.parent = this
      this.children.push(c)
    }
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this)
    this.parent = null
  }
  setAttribute(k: string, v: string): void {
    this.props[k] = v
  }
  removeAttribute(k: string): void {
    delete this.props[k]
  }
  addEventListener(type: string, f: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f])
  }
  fire(type: string): void {
    for (const f of this.listeners.get(type) ?? []) f()
  }
  // href, src, alt, target, rel, type go through setAttribute in detail.ts
}

const all = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(all)]
const byClass = (root: FakeEl, cls: string): FakeEl => {
  const hit = all(root).find((e) => e.className.split(' ').includes(cls))
  assert.ok(hit, `no .${cls}`)
  return hit
}
const valueOf = (root: FakeEl, key: string): string => {
  const row = all(root).find((e) => e.props['data-key'] === key)
  assert.ok(row, `no row ${key}`)
  return byClass(row, 'fh-detail-value').textContent
}

const PHOTO_BODY = {
  photos: [{
    thumbnail_large: { src: 'https://t.plnspttrs.net/1/4691c4_280.jpg' },
    link: 'https://www.planespotters.net/photo/1/sx-dnd',
    photographer: 'A. Spotter',
  }],
}

function setup(photoGate?: Promise<void>, photoStatus = 200) {
  ;(globalThis as { document?: unknown }).document = { createElement: (tag: string) => new FakeEl(tag) }
  const root = new FakeEl('div')
  const fetches: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    fetches.push(String(input))
    if (photoGate) await photoGate
    return new Response(JSON.stringify(String(input).endsWith('4691C4') ? PHOTO_BODY : { photos: [] }), { status: photoStatus })
  }) as typeof fetch
  const lookups: string[] = []
  let closed = 0
  const d = mountDetail(root as unknown as HTMLElement, {
    onClose: () => closed++,
    photos: new PhotoCache(fetchFn),
    lookup: (hex, callsign) => {
      lookups.push(`${hex}/${callsign}`)
      return hex === '4691c4' ? GR : NONE
    },
  })
  const panel = byClass(root, 'fh-detail')
  return { root, panel, d, fetches, lookups, closed: () => closed }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

test('mountDetail: hidden until an aircraft is given, filled at once on selection, hidden again on null', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    const { panel, d } = setup()
    assert.equal(panel.hidden, true)
    d.update(S, RAW, INFO)
    assert.equal(panel.hidden, false)
    assert.equal(byClass(panel, 'fh-detail-callsign').textContent, 'AEE4266')
    assert.equal(byClass(panel, 'fh-detail-hex').textContent, '4691C4')
    assert.equal(valueOf(panel, 'country'), '🇬🇷 Greece')
    assert.equal(valueOf(panel, 'wind'), '24 kt / 231°')
    d.update(null, null, null)
    assert.equal(panel.hidden, true)
    d.destroy()
  } finally {
    mock.timers.reset()
  }
})

test('mountDetail: text updates at most every 250 ms, and the newest state always lands', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    const { panel, d } = setup()
    assert.equal(UPDATE_MS, 250)
    d.update(S, RAW, INFO) // selection: rendered now
    mock.timers.tick(100)
    d.update({ ...S, gsKt: 340 }, RAW, INFO)
    assert.equal(valueOf(panel, 'gs'), '337 kt') // too soon
    mock.timers.tick(100)
    d.update({ ...S, gsKt: 341 }, RAW, INFO)
    assert.equal(valueOf(panel, 'gs'), '337 kt')
    mock.timers.tick(50) // 250 ms after the first render: the trailing render shows the newest state
    assert.equal(valueOf(panel, 'gs'), '341 kt')
    mock.timers.tick(250)
    d.update({ ...S, gsKt: 342 }, RAW, INFO) // quiet for a full period: rendered now
    assert.equal(valueOf(panel, 'gs'), '342 kt')
    d.destroy()
  } finally {
    mock.timers.reset()
  }
})

test('mountDetail: emergency squawk row gets the alert class', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    const { panel, d } = setup()
    d.update(S, { ...RAW, squawk: '7700' }, null)
    const row = all(panel).find((e) => e.props['data-key'] === 'squawk')!
    assert.equal(row.classes.has('fh-alert'), true)
    mock.timers.tick(300)
    d.update(S, RAW, null)
    assert.equal(row.classes.has('fh-alert'), false)
    d.destroy()
  } finally {
    mock.timers.reset()
  }
})

test('mountDetail: one photo request per selection, credit links to the photo page', async () => {
  const { panel, d, fetches } = setup()
  d.update(S, RAW, INFO)
  for (let i = 0; i < 20; i++) d.update(S, RAW, INFO) // per-frame calls for the same aircraft
  await flush()
  assert.deepEqual(fetches, ['https://api.planespotters.net/pub/photos/hex/4691C4'])
  const img = all(panel).find((e) => e.tag === 'img')!
  assert.equal(img.props.src, 'https://t.plnspttrs.net/1/4691c4_280.jpg')
  assert.equal(img.hidden, false)
  const credit = byClass(panel, 'fh-detail-credit')
  assert.equal(credit.textContent, 'Image © A. Spotter')
  assert.equal(credit.props.href, 'https://www.planespotters.net/photo/1/sx-dnd')
  assert.equal(credit.hidden, false)
  img.fire('error') // the CDN image fails: no orphan credit
  assert.equal(img.hidden, true)
  assert.equal(credit.hidden, true)
  assert.equal(byClass(panel, 'fh-detail-note').textContent, 'Photo unavailable')
  d.destroy()
})

test('mountDetail: a photo that arrives after the selection moved on is dropped', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { panel, d, fetches } = setup(gate)
  d.update(S, RAW, INFO)
  d.update({ ...S, hex: 'abcdef', callsign: 'XYZ1' }, null, null)
  release()
  await flush()
  assert.equal(fetches.length, 2)
  const img = all(panel).find((e) => e.tag === 'img')!
  assert.equal(img.props.src, undefined)
  assert.equal(img.hidden, true)
  assert.equal(byClass(panel, 'fh-detail-note').textContent, 'No photo')
  assert.equal(byClass(panel, 'fh-detail-credit').hidden, true)
  d.destroy()
})

test('mountDetail: a failed photo lookup says so, rather than "No photo"', async () => {
  const { panel, d } = setup(undefined, 503)
  d.update(S, RAW, INFO)
  await flush()
  assert.equal(byClass(panel, 'fh-detail-note').textContent, 'Photo unavailable')
  assert.equal(byClass(panel, 'fh-detail-credit').hidden, true)
  d.destroy()
})

test('mountDetail: lookup once per hex and callsign, close button, destroy removes the panel', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    const { root, panel, d, lookups, closed } = setup()
    for (let i = 0; i < 5; i++) {
      d.update(S, RAW, INFO)
      mock.timers.tick(300)
    }
    d.update({ ...S, callsign: 'AEE9' }, RAW, { ...INFO, callsign: 'AEE9' })
    assert.deepEqual(lookups, ['4691c4/AEE4266', '4691c4/AEE9'])
    byClass(panel, 'fh-detail-close').fire('click')
    assert.equal(closed(), 1)
    d.update({ ...S, gsKt: 1 }, RAW, INFO) // leaves a trailing render pending
    d.destroy()
    assert.equal(root.children.length, 0)
    mock.timers.tick(1000) // the pending render must not run after destroy
    assert.equal(valueOf(panel, 'gs'), '337 kt')
  } finally {
    mock.timers.reset()
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/ui/detail.test.ts`
Expected: FAIL, `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/ui/detail.ts'`.

- [ ] **Step 3: Write the stylesheet**

```css
/* client/ui/detail.css */
/* Left-hand detail panel over the map, in the same dark translucent style as the table (table.css). It stops 236px
   above the bottom so the chase HUD (bottom-left, 40px up) stays in view, and scrolls inside itself. No
   backdrop-filter: blurring the globe behind the panel would cost a pass every frame the globe redraws. */
.fh-detail {
  position: absolute;
  z-index: 11;
  top: 8px;
  left: 8px;
  width: 300px;
  max-width: calc(100vw - 16px);
  max-height: max(160px, calc(100% - 236px));
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
  border-radius: 6px;
  background: rgba(10, 14, 20, 0.82);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
  color: #e6ebf0;
  font: 12px/1.35 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  pointer-events: auto;
}

/* An author display value would beat the hidden attribute's UA style; say it again. */
.fh-detail[hidden],
.fh-detail [hidden] {
  display: none !important;
}

.fh-detail-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 8px 6px 10px;
  background: rgba(10, 14, 20, 0.94);
}

.fh-detail-callsign {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.fh-detail-hex {
  color: #9aa6b2;
  font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.fh-detail-spacer {
  flex: 1;
}

.fh-detail-btn {
  align-self: center;
  padding: 2px 7px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font: 11px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  cursor: pointer;
}

.fh-detail-btn:hover {
  background: rgba(255, 255, 255, 0.14);
}

.fh-detail-close {
  width: 24px;
  padding: 0 0 2px;
  font-size: 16px;
  line-height: 20px;
}

/* Image and "Loading…/No photo" share one 3:2 cell (the API's thumbnails are 3:2), so nothing jumps when it loads. */
.fh-detail-photo {
  display: grid;
  margin: 0;
}

.fh-detail-imglink,
.fh-detail-note {
  grid-area: 1 / 1;
}

.fh-detail-imglink {
  display: block;
  aspect-ratio: 3 / 2;
  background: rgba(255, 255, 255, 0.05);
}

.fh-detail-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.fh-detail-note {
  align-self: center;
  justify-self: center;
  color: #7d8793;
  pointer-events: none;
}

.fh-detail-credit {
  grid-row: 2;
  padding: 2px 10px 0;
  overflow: hidden;
  color: #aeb8c2;
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-decoration: none;
}

.fh-detail-credit:hover {
  color: #fff;
  text-decoration: underline;
}

.fh-detail-section {
  padding: 4px 10px 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.fh-detail-photo + .fh-detail-section {
  border-top: 0;
}

.fh-detail-title {
  margin: 0 -2px 2px;
  padding: 1px 2px;
  color: #8fb8de;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
}

.fh-detail-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 1px 0;
}

.fh-detail-label {
  flex: none;
  color: #9aa6b2;
}

.fh-detail-value {
  min-width: 0;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A row with a caveat in its tooltip. */
.fh-detail-row[title]:not([title='']) .fh-detail-label {
  text-decoration: underline dotted;
  cursor: help;
}

/* Emergency squawk: not by colour alone, it also reads "7700 · emergency". */
.fh-detail-row.fh-alert .fh-detail-value {
  padding: 0 5px;
  border-radius: 3px;
  background: #c62828;
  color: #fff;
  font-weight: 700;
}

/* Phones: full width at the top, under half the height; the photo becomes a cropped 120px strip so the data shows. */
@media (max-width: 640px) {
  .fh-detail {
    right: 8px;
    width: auto;
    max-height: 45%;
  }

  .fh-detail-imglink {
    aspect-ratio: auto;
    height: 120px;
  }
}
```

- [ ] **Step 4: Write the implementation**

```ts
// client/ui/detail.ts
// Left-hand detail panel for the selected aircraft: callsign and hex, photo with credit, identity, then Spatial,
// Signal, FMS SEL and Wind sections. detailRows() is the pure text; mountDetail() builds the DOM once and then only
// rewrites the value texts, at most 4 times a second.
import type { AircraftInfo } from '../../shared/info.ts'
import type { Quality, ReadsbAircraft } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import type { PhotoCache } from './photo.ts'
import './detail.css'

/** Country and airline for one aircraft, found by the caller (B-A wires countryOf/flagEmoji and airlineOf). */
export interface Lookup {
  country: { iso2: string; name: string; flag: string } | null
  airline: string | null
}

export type SectionId = 'header' | 'identity' | 'spatial' | 'signal' | 'fms' | 'wind'

export interface DetailRow {
  key: string // stable id, e.g. 'gs'; the same rows come back on every call
  label: string
  value: string // '—' when unknown
  alert: boolean // emergency squawk: shown highlighted
  hint: string | null // tooltip with a caveat, e.g. why a value may be off
}

export interface DetailSection {
  id: SectionId
  title: string // '' for the header and the identity block (not collapsible)
  rows: DetailRow[]
}

export interface DetailOpts {
  onClose(): void
  photos?: PhotoCache
  lookup(hex: string, callsign: string | null): Lookup
}

export interface DetailHandle {
  update(s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null): void
  destroy(): void
}

export const UPDATE_MS = 250 // at most 4 text updates a second; a new selection shows at once
const DASH = '—'
const TREND_FPM = 250 // |vertical rate| below this is level flight: no ▲/▼ after the altitude

// ICAO special-purpose codes (ICAO Doc 4444 / Annex 10).
const SQUAWK_MEANING: Record<string, string> = { '7500': 'hijack', '7600': 'radio failure', '7700': 'emergency' }
// adsb.lol / readsb database flags (bit → meaning).
const DB_FLAGS: [number, string][] = [[1, 'military'], [2, 'interesting'], [4, 'PIA'], [8, 'LADD']]
const QUALITY_LABEL: Record<Quality, string> = { adsb2: 'ADS-B v2', adsb01: 'ADS-B v0/1', mlat: 'MLAT', other: 'other' }

const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: string | null | undefined): string | null => {
  const t = typeof v === 'string' ? v.trim() : ''
  return t === '' ? null : t
}
// One formatter for the module: Number#toLocaleString builds a new one per call (~8 µs each in Chrome).
const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const int = (v: number): string => GROUPED.format(Math.round(v) || 0) // `|| 0` turns -0 into 0
const deg3 = (d: number): string => `${String((((Math.round(d) % 360) + 360) % 360)).padStart(3, '0')}°`
const signed = (v: number): string => `${v > 0 ? '+' : ''}${int(v)}`

/** "ADS-B v2", "MLAT", "TIS-B"… from readsb's message type (best), else from the track's quality. */
export function sourceLabel(raw: ReadsbAircraft | null, quality: Quality | null): string | null {
  const t = raw?.type
  if (t !== undefined) {
    if (t.startsWith('adsb')) return num(raw?.version) ? `ADS-B v${raw.version}` : 'ADS-B'
    if (t.startsWith('adsr')) return 'ADS-R'
    if (t.startsWith('tisb')) return 'TIS-B'
    if (t === 'mlat') return 'MLAT'
    if (t === 'mode_s') return 'Mode S'
    if (t === 'adsc') return 'ADS-C'
    return 'other'
  }
  return quality === null ? null : QUALITY_LABEL[quality]
}

/** Link that opens the app chasing this aircraft (client/app.ts reads ?hex=). */
export function shareLink(origin: string, hex: string): string {
  return `${origin}/?hex=${encodeURIComponent(hex)}`
}

/** The selected hex (lower case) from whichever of the three the caller has. */
function hexOf(s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null): string | null {
  return s?.hex ?? info?.hex ?? raw?.hex.toLowerCase() ?? null
}

function callsignOf(s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null): string | null {
  return info?.callsign ?? s?.callsign ?? str(raw?.flight)
}

/**
 * Every section and row of the panel, always in the same shape; unknown values are '—'.
 * s (render state) wins for what moves (speed, altitude, track, position); info wins for identity; raw (the newest
 * upstream object) supplies the rest. A raw object or info for another hex is ignored.
 * ponytail: signal ages (last position, last seen) are as reported in the newest upstream object and do not tick
 * between polls. Upgrade: add the object's age when the caller passes it.
 */
export function detailRows(s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null, lookup: Lookup): DetailSection[] {
  const hex = hexOf(s, raw, info)
  if (raw !== null && raw.hex.toLowerCase() !== hex) raw = null
  if (info !== null && info.hex !== hex) info = null

  const row = (key: string, label: string, value: string | null, alert = false, hint: string | null = null): DetailRow => ({
    key, label, value: value ?? DASH, alert, hint,
  })

  // Identity
  const country = lookup.country === null ? null : `${lookup.country.flag} ${lookup.country.name}`.trim()
  const dbFlags = raw?.dbFlags ?? (info?.military ? 1 : 0)
  const flags = DB_FLAGS.filter(([bit]) => (dbFlags & bit) !== 0).map(([, name]) => name)
  const squawk = info ? info.squawk : str(raw?.squawk)
  const rawEmergency = str(raw?.emergency)
  const emergency = info ? info.emergency : rawEmergency === 'none' ? null : rawEmergency
  const meaning = emergency ?? (squawk === null ? undefined : SQUAWK_MEANING[squawk])
  const squawkText = squawk === null ? (emergency ?? null) : meaning ? `${squawk} · ${meaning}` : squawk
  const route = info?.route ? info.route.split('-').join(' – ') : null

  // Spatial
  const gs = s?.gsKt ?? raw?.gs
  const onGround = s ? s.onGround : raw?.alt_baro === 'ground'
  const altBaro = s?.altBaroFt ?? (typeof raw?.alt_baro === 'number' ? raw.alt_baro : null)
  const rate = raw?.baro_rate ?? raw?.geom_rate ?? (num(s?.vsFpm) ? Math.round(s.vsFpm / 10) * 10 : null)
  const trend = num(rate) && Math.abs(rate) >= TREND_FPM ? (rate > 0 ? ' ▲' : ' ▼') : ''
  const altBaroText = onGround ? 'ground' : num(altBaro) ? `${int(altBaro)} ft${trend}` : null
  const geomHint = num(raw?.alt_geom) && raw.version !== 2 ? 'GNSS height: its datum is certain only for ADS-B v2' : null
  const track = s?.trackDeg ?? raw?.track
  const lat = s ? s.lat : raw?.lat
  const lon = s ? s.lon : raw?.lon

  // Signal
  const quality = s?.quality ?? null

  // FMS
  const selAlt = raw?.nav_altitude_mcp ?? raw?.nav_altitude_fms
  const modes = raw?.nav_modes?.length ? raw.nav_modes.join(' ') : null

  return [
    { id: 'header', title: '', rows: [
      row('callsign', 'Callsign', callsignOf(s, raw, info)),
      row('hex', 'Hex', hex === null ? null : hex.toUpperCase()),
    ] },
    { id: 'identity', title: '', rows: [
      row('reg', 'Reg.', info?.reg ?? str(raw?.r)),
      row('country', 'Country', country),
      row('airline', 'Airline', lookup.airline),
      row('dbFlags', 'DB flags', flags.length ? flags.join(' · ') : null),
      row('type', 'Type', info?.typeCode ?? s?.typeCode ?? str(raw?.t)),
      row('squawk', 'Squawk', squawkText, emergency !== null || meaning !== undefined),
      row('route', 'Route', route),
    ] },
    { id: 'spatial', title: 'Spatial', rows: [
      row('gs', 'Groundspeed', num(gs) ? `${int(gs)} kt` : null),
      row('altBaro', 'Baro. altitude', altBaroText),
      row('altGeom', 'WGS84 altitude', num(raw?.alt_geom) ? `${int(raw.alt_geom)} ft` : null, false, geomHint),
      row('vs', 'Vertical rate', num(rate) ? `${signed(rate)} ft/min` : null),
      row('track', 'Track', num(track) ? deg3(track) : null),
      row('pos', 'Position', num(lat) && num(lon) ? `${lat.toFixed(3)}°, ${lon.toFixed(3)}°` : null),
    ] },
    { id: 'signal', title: 'Signal', rows: [
      row('source', 'Source', sourceLabel(raw, quality)),
      row('rssi', 'RSSI', num(raw?.rssi) ? `${raw.rssi.toFixed(1)} dBFS` : null),
      row('messages', 'Messages', num(raw?.messages) ? int(raw.messages) : null),
      row('posAge', 'Last position', num(raw?.seen_pos) ? `${raw.seen_pos.toFixed(1)} s` : null),
      row('seen', 'Last seen', num(raw?.seen) ? `${raw.seen.toFixed(1)} s` : null),
    ] },
    { id: 'fms', title: 'FMS SEL', rows: [
      row('selAlt', 'Sel. altitude', num(selAlt) ? `${int(selAlt)} ft` : null),
      row('selHdg', 'Sel. heading', num(raw?.nav_heading) ? deg3(raw.nav_heading) : null),
      row('qnh', 'QNH', num(raw?.nav_qnh) ? `${raw.nav_qnh.toFixed(1)} hPa` : null),
      row('modes', 'Modes', modes),
    ] },
    { id: 'wind', title: 'Wind', rows: [
      row('wind', 'Wind', num(raw?.ws) && num(raw?.wd) ? `${int(raw.ws)} kt / ${deg3(raw.wd)}` : null),
      row('oat', 'OAT', num(raw?.oat) ? `${int(raw.oat)} °C` : null),
      row('tat', 'TAT', num(raw?.tat) ? `${int(raw.tat)} °C` : null),
    ] },
  ]
}

const NO_LOOKUP: Lookup = { country: null, airline: null }

function h(tag: string, className = '', text = ''): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = text
  return el
}

/**
 * Mounts the (hidden) panel. update() may be called every frame: the text is rewritten at most every UPDATE_MS, with a
 * trailing render so the newest state always lands. A new selection renders at once and asks photos (once per hex).
 * Values go in with textContent only: callsigns and photo credits come from upstream and are never parsed as HTML.
 */
export function mountDetail(root: HTMLElement, opts: DetailOpts): DetailHandle {
  const panel = h('aside', 'fh-detail')
  panel.hidden = true
  panel.setAttribute('aria-label', 'Selected aircraft')

  const head = h('div', 'fh-detail-head')
  const callsign = h('span', 'fh-detail-callsign')
  const hexEl = h('span', 'fh-detail-hex')
  const copy = h('button', 'fh-detail-btn fh-detail-copy', 'Copy link')
  copy.setAttribute('type', 'button')
  copy.title = 'Copy a link that opens this aircraft'
  const close = h('button', 'fh-detail-btn fh-detail-close', '×')
  close.setAttribute('type', 'button')
  close.setAttribute('aria-label', 'Close')
  close.title = 'Close (back to the map)'
  head.append(callsign, hexEl, h('span', 'fh-detail-spacer'), copy, close)

  // Photo: a 3:2 box (the API's thumbnails are 3:2) so the layout does not jump when the image arrives.
  const figure = h('figure', 'fh-detail-photo')
  const imgLink = h('a', 'fh-detail-imglink')
  const img = h('img', 'fh-detail-img')
  img.setAttribute('alt', 'Aircraft photo')
  img.hidden = true
  imgLink.append(img)
  const note = h('span', 'fh-detail-note')
  const credit = h('a', 'fh-detail-credit')
  credit.hidden = true
  for (const a of [imgLink, credit]) {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener')
  }
  figure.append(imgLink, note, credit)
  figure.hidden = opts.photos === undefined
  panel.append(head, figure)

  // Sections and rows, built once from the fixed shape of detailRows().
  const slots = new Map<string, { row: HTMLElement; value: HTMLElement; text: string; alert: boolean; hint: string | null }>()
  slots.set('callsign', { row: callsign, value: callsign, text: '', alert: false, hint: null })
  slots.set('hex', { row: hexEl, value: hexEl, text: '', alert: false, hint: null })
  for (const sec of detailRows(null, null, null, NO_LOOKUP)) {
    if (sec.id === 'header') continue
    let box: HTMLElement
    if (sec.title === '') box = h('div', 'fh-detail-section')
    else {
      box = h('details', 'fh-detail-section')
      ;(box as HTMLDetailsElement).open = true
      box.append(h('summary', 'fh-detail-title', sec.title))
    }
    for (const r of sec.rows) {
      const rowEl = h('div', 'fh-detail-row')
      rowEl.setAttribute('data-key', r.key)
      const value = h('span', 'fh-detail-value')
      rowEl.append(h('span', 'fh-detail-label', r.label), value)
      box.append(rowEl)
      slots.set(r.key, { row: rowEl, value, text: '', alert: false, hint: null })
    }
    panel.append(box)
  }
  root.append(panel)

  let curS: RenderState | null = null // newest arguments of update(); kept in three variables so a frame allocates nothing
  let curRaw: ReadsbAircraft | null = null
  let curInfo: AircraftInfo | null = null
  let shown: string | null = null // hex on screen
  let lastMs = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  let lk: Lookup = NO_LOOKUP
  let lkKey = ''
  let destroyed = false

  function showPhoto(hex: string): void {
    img.hidden = true
    img.removeAttribute('src')
    credit.hidden = true
    note.textContent = 'Loading photo…'
    opts.photos?.get(hex).then((p) => {
      if (destroyed || shown !== hex) return // the selection moved on
      if (p === null) {
        note.textContent = opts.photos?.failed(hex) ? 'Photo unavailable' : 'No photo'
        return
      }
      note.textContent = ''
      img.setAttribute('src', p.thumbUrl)
      img.hidden = false
      imgLink.setAttribute('href', p.link)
      credit.setAttribute('href', p.link)
      credit.textContent = `Image © ${p.photographer}`
      credit.hidden = false
    })
  }
  img.addEventListener('error', () => {
    img.hidden = true
    credit.hidden = true
    note.textContent = 'Photo unavailable'
  })

  function render(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    lastMs = Date.now()
    const s = curS
    const raw = curRaw
    const info = curInfo
    const hex = hexOf(s, raw, info)
    if (hex === null) {
      panel.hidden = true
      shown = null
      return
    }
    panel.hidden = false
    if (hex !== shown) {
      shown = hex
      showPhoto(hex)
    }
    const cs = callsignOf(s, raw, info)
    const key = `${hex}/${cs}`
    if (key !== lkKey) {
      lk = opts.lookup(hex, cs)
      lkKey = key
    }
    for (const sec of detailRows(s, raw, info, lk)) {
      for (const r of sec.rows) {
        const slot = slots.get(r.key)
        if (slot === undefined) continue
        if (slot.text !== r.value) slot.value.textContent = slot.text = r.value
        if (slot.alert !== r.alert) slot.row.classList.toggle('fh-alert', (slot.alert = r.alert))
        if (slot.hint !== r.hint) slot.row.title = (slot.hint = r.hint) ?? ''
      }
    }
  }

  close.addEventListener('click', () => opts.onClose())
  copy.addEventListener('click', () => {
    if (shown === null) return
    const url = shareLink(location.origin, shown)
    const done = (): void => {
      copy.textContent = 'Copied'
      setTimeout(() => (copy.textContent = 'Copy link'), 1500)
    }
    // The async clipboard needs a secure context (https or localhost); elsewhere the user copies from a prompt.
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this link', url))
    else window.prompt('Copy this link', url)
  })

  return {
    update(s, raw, info) {
      if (destroyed) return
      curS = s
      curRaw = raw
      curInfo = info
      const hex = hexOf(s, raw, info)
      if (hex !== shown) return render() // selection changed (or cleared): at once
      if (hex === null) return
      const wait = lastMs + UPDATE_MS - Date.now()
      if (wait <= 0) render()
      else if (timer === null) timer = setTimeout(render, wait)
    },
    destroy() {
      destroyed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      panel.remove()
    },
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `node --test client/ui/detail.test.ts client/ui/photo.test.ts`
Expected: PASS, `ℹ tests 27`, `ℹ pass 27`, `ℹ fail 0` (9 photo + 18 detail).

- [ ] **Step 6: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui/(detail|photo)'`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add client/ui/detail.ts client/ui/detail.css client/ui/detail.test.ts
git commit -m "feat(ui): detail panel for the selected aircraft (identity, spatial, signal, FMS, wind)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Harness page

**Files:**
- Create: `harness/detail.html`, `harness/detail.ts`

**Interfaces:**
- Consumes: `mountDetail`, `detailRows`, `Lookup` (Task 2), `PhotoCache` (Task 1), `toInfo` (B0), `mountHud` (V6)
- Produces: `/harness/detail.html`. Its scenario buttons are golden, raw only, squawk 7700, ground v0, MLAT sparse, non-ICAO `~` and nothing selected. `play` calls `update()` every frame and reports its cost and the text rewrites per second. `bench` times the throttled path, full renders and `detailRows()`. The background buttons are map, satellite and snow. Only the golden hex (`4691c4`) may reach planespotters.net, once per page load. `?photos=off` keeps even that one offline, and `?photos=demo` shows a local placeholder drawing (labelled, not a planespotters photo) to check the photo layout without the network.

- [ ] **Step 1: Write the page**

```html
<!-- harness/detail.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: detail panel</title>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
      #stage { position: relative; width: 100%; height: 100%; }
      /* Stand-ins for the base layers the panel sits on: the browse street map and the chase satellite imagery. */
      body[data-bg='map'] #stage { background:
        linear-gradient(90deg, transparent 0 48%, #fff 48% 49%, transparent 49%) 0 0 / 180px 180px,
        linear-gradient(0deg, transparent 0 60%, #fcd6a4 60% 62%, transparent 62%) 0 0 / 240px 240px,
        radial-gradient(circle at 70% 30%, #aad3df 0 120px, transparent 121px), #f2efe9; }
      body[data-bg='satellite'] #stage { background: repeating-linear-gradient(35deg, #3f5f2a 0 40px, #6b7d4a 40px 90px, #a88b5b 90px 120px, #2f4a24 120px 170px); }
      body[data-bg='snow'] #stage { background: linear-gradient(160deg, #fff 0%, #e9eef3 40%, #cfd8e0 70%, #fff 100%); }
      #controls { position: absolute; top: 8px; right: 8px; z-index: 20; display: flex; flex-wrap: wrap; justify-content: flex-end;
        gap: 4px; max-width: min(520px, calc(100% - 330px)); font: 12px system-ui, sans-serif; }
      #controls button { font: inherit; padding: 3px 8px; }
      #controls button[aria-pressed='true'] { outline: 2px solid #1e88e5; }
      #stats { position: absolute; right: 8px; bottom: 8px; z-index: 20; max-width: 46ch; padding: 6px 8px; border-radius: 4px;
        background: rgba(255, 255, 255, 0.9); color: #111; font: 11px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
    </style>
  </head>
  <body data-bg="map">
    <div id="stage"></div>
    <div id="controls"></div>
    <div id="stats"></div>
    <script type="module" src="./detail.ts"></script>
  </body>
</html>
```

```ts
// harness/detail.ts
// WP-B-U2 harness: /harness/detail.html shows the detail panel, with the chase HUD to check that they do not overlap, for
// a real adsb.lol aircraft object over map-like backgrounds. The golden aircraft's photo is asked from the real
// planespotters.net API (one request per page load, only for that hex); when the API refuses (it sometimes answers
// without CORS headers) the panel reads "Photo unavailable". ?photos=off answers "no photo" offline, and ?photos=demo
// shows a local placeholder drawing (not a planespotters photo) to check the photo layout without the network.
// "play" calls update() every frame, like the app, and reports its cost and how often the text is rewritten; "bench"
// times the throttled path, full renders and detailRows().
import type { StatusBrief } from '../shared/api.ts'
import { toInfo } from '../shared/info.ts'
import type { AircraftInfo } from '../shared/info.ts'
import type { ReadsbAircraft } from '../shared/types.ts'
import type { RenderState } from '../client/types.ts'
import { detailRows, mountDetail } from '../client/ui/detail.ts'
import type { Lookup } from '../client/ui/detail.ts'
import { mountHud } from '../client/ui/hud.ts'
import { PhotoCache } from '../client/ui/photo.ts'

// A real adsb.lol /v2/point object (LLBG cell, 2026-09-22; © adsb.lol contributors, ODbL 1.0), as in detail.test.ts.
const RAW: ReadsbAircraft = {
  hex: '4691c4', type: 'adsb_icao', flight: 'AEE4266 ', r: 'SX-DND', t: 'A320', alt_baro: 7975, alt_geom: 8500, gs: 337.1,
  ias: 280, tas: 322, mach: 0.488, wd: 231, ws: 24, oat: 14, tat: 27, track: 101.81, track_rate: 0.06, roll: 0.53,
  mag_heading: 100.2, true_heading: 105.24, baro_rate: -960, geom_rate: -928, squawk: '7421', emergency: 'none',
  category: 'A3', nav_qnh: 1012.0, nav_altitude_mcp: 4992, lat: 32.371902, lon: 34.43291, nic: 8, rc: 186, seen_pos: 0.09,
  version: 2, nic_baro: 1, nac_p: 9, nac_v: 1, sil: 3, gva: 2, sda: 2, mlat: [], tisb: [], messages: 9956, seen: 0.0, rssi: -4.0,
}
const INFO = toInfo(RAW, 'LGAV-LLBG') // route made up for the harness
const S: RenderState = {
  hex: '4691c4', lat: 32.371902, lon: 34.43291, hM: 2620, headingDeg: 105.24, pitchDeg: -1.5, rollDeg: 0.5, gsKt: 337.1,
  trackDeg: 101.81, altBaroFt: 7975, vsFpm: -951, mode: 'interp', altSource: 'geom', onGround: false, ageS: -0.8,
  quality: 'adsb2', callsign: 'AEE4266', typeCode: 'A320',
}
// Synthetic (made-up hex and registration) sparse MLAT target, and a non-ICAO TIS-B one.
const MLAT_RAW: ReadsbAircraft = {
  hex: '73fffe', type: 'mlat', flight: 'ELY9999 ', r: '4X-ZZZ', t: 'B789', alt_baro: 37000, gs: 481, track: 291.4,
  lat: 33.104, lon: 33.512, mlat: ['lat', 'lon', 'gs', 'track'], messages: 1204, seen: 3.2, seen_pos: 3.2, rssi: -21.5,
}
const TISB_RAW: ReadsbAircraft = { hex: '~a330e6', type: 'tisb_other', alt_baro: 2500, gs: 110, track: 15, lat: 32.1, lon: 34.9, seen: 1.1, seen_pos: 1.1 }

const live: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: 12, chasePeriodP95S: 12 }
type Scene = [RenderState | null, ReadsbAircraft | null, AircraftInfo | null]

const emergency = { ...RAW, squawk: '7700', emergency: 'general' }
const scenarios: Record<string, Scene> = {
  golden: [S, RAW, INFO],
  'raw only': [null, RAW, null],
  'squawk 7700': [S, emergency, toInfo(emergency, INFO.route)],
  'ground, v0': [{ ...S, onGround: true, altBaroFt: null, gsKt: 12, vsFpm: 0 }, { ...RAW, alt_baro: 'ground', gs: 12, baro_rate: 0, version: 0 }, INFO],
  'MLAT, sparse': [{ ...S, hex: MLAT_RAW.hex, quality: 'mlat', callsign: 'ELY9999', typeCode: 'B789', altBaroFt: 37000, gsKt: 481, vsFpm: 0, trackDeg: 291.4, lat: 33.104, lon: 33.512 }, MLAT_RAW, null],
  'non-ICAO ~': [null, TISB_RAW, null],
  'nothing selected': [null, null, null],
}

const params = new URLSearchParams(location.search)
const photoMode = params.get('photos') ?? 'real' // real | off | demo
let realRequests = 0
// Only the golden hex may reach planespotters.net; every other hex (and ?photos=off|demo) gets "no photo" locally.
const photos = new PhotoCache((input, init) => {
  if (photoMode === 'real' && String(input).endsWith('/4691C4')) {
    realRequests++
    return fetch(input, init)
  }
  return Promise.resolve(new Response('{"photos":[]}', { status: 200 }))
})
// A 3:2 placeholder drawn here (sky, runway, a generic airliner side view), for ?photos=demo only. It goes around
// toPhoto's https check on purpose: this is a layout check, not a planespotters answer.
const DEMO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 280"><defs><linearGradient id="k" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#5b8fc7"/><stop offset="1" stop-color="#cfe3f3"/></linearGradient></defs>
<rect width="420" height="280" fill="url(#k)"/><rect y="226" width="420" height="54" fill="#6f7a63"/><rect y="240" width="420" height="14" fill="#44474a"/>
<g fill="#f4f6f8" stroke="#8c96a0" stroke-width="1.5"><path d="M60 150 Q48 150 44 160 Q48 172 64 172 L330 172 Q364 170 372 160 Q364 150 330 148 Z"/>
<path d="M74 150 L50 92 L78 92 L118 150 Z"/><path d="M180 166 L250 166 L200 204 L172 204 Z"/><ellipse cx="226" cy="186" rx="26" ry="10"/></g>
<g fill="#33495e">${Array.from({ length: 22 }, (_, i) => `<rect x="${112 + i * 10}" y="155" width="5" height="6" rx="2"/>`).join('')}</g>
<text x="210" y="40" text-anchor="middle" font-family="system-ui" font-size="18" fill="#fff">DEMO PLACEHOLDER</text></svg>`
if (photoMode === 'demo') {
  photos.get = (hex) =>
    Promise.resolve(hex === '4691c4' ? {
      thumbUrl: `data:image/svg+xml,${encodeURIComponent(DEMO_SVG)}`,
      link: 'https://www.planespotters.net/photos/reg/SX-DND',
      photographer: 'demo placeholder, not a planespotters photo',
    } : null)
}

// B-A wires countryOf/flagEmoji (B-C1) and airlineOf (B-C2) here. This package depends only on B0, so the harness
// answers for its own scenario hexes: 468000–46FFFF is Greece and 738000–73FFFF Israel (ICAO Annex 10 allocation).
const LOOKUPS: Record<string, Lookup> = {
  '4691c4': { country: { iso2: 'GR', name: 'Greece', flag: '🇬🇷' }, airline: 'Aegean Airlines' },
  '73fffe': { country: { iso2: 'IL', name: 'Israel', flag: '🇮🇱' }, airline: 'El Al Israel Airlines' },
}
function lookup(hex: string, callsign: string | null): Lookup {
  const hit = LOOKUPS[hex]
  // The airline follows the callsign, as airlineOf does: a changed or missing callsign loses it.
  return hit ? { country: hit.country, airline: callsign === null ? null : hit.airline } : { country: null, airline: null }
}

const stage = document.getElementById('stage')!
const stats = document.getElementById('stats')!
const controls = document.getElementById('controls')!
let current: Scene = scenarios.golden
let note = ''
const detail = mountDetail(stage, {
  onClose: () => {
    stop()
    current = scenarios['nothing selected']
    note = 'closed with ×'
    show()
  },
  photos,
  lookup,
})
const hud = mountHud(stage)
;(window as unknown as { fhDetail: unknown }).fhDetail = { detail, scenarios, photos } // for poking from the console

function show(): void {
  detail.update(...current)
  hud.update(current[0], live)
  report()
}

let photoOutcome = 'pending'
function report(extra = ''): void {
  const head = `photos=${photoMode}: ${realRequests} planespotters request(s) this page, golden photo ${photoOutcome}`
  stats.textContent = [head, note, extra].filter((l) => l).join('\n')
}

// ---------- play: update() every frame, as the app calls it ----------
let raf = 0
let observer: MutationObserver | null = null
function stop(): void {
  cancelAnimationFrame(raf)
  raf = 0
  observer?.disconnect()
  observer = null
}
function play(): void {
  stop()
  current = scenarios.golden
  show()
  const gsValue = stage.querySelector('[data-key="gs"] .fh-detail-value')!
  let rewrites = 0
  observer = new MutationObserver((records) => (rewrites += records.length))
  observer.observe(gsValue, { childList: true, characterData: true, subtree: true })
  const t0 = performance.now()
  let last = t0
  let frames = 0
  let updateMs = 0
  const frameMs: number[] = []
  const frame = (now: number): void => {
    const t = (now - t0) / 1000
    frameMs.push(now - last)
    last = now
    // A new state every frame. Groundspeed moves 40 kt/s, so every render (≤ 4/s) changes its text and the rewrite
    // count below is the render count.
    const s: RenderState = { ...S, gsKt: 300 + ((t * 40) % 200), altBaroFt: 7975 - t * 16, lat: S.lat + t * 1e-4, lon: S.lon + t * 5e-4 }
    const a = performance.now()
    detail.update(s, RAW, INFO)
    updateMs += performance.now() - a
    hud.update(s, live)
    frames++
    if (frames % 60 === 0) {
      const sorted = [...frameMs].sort((x, y) => x - y)
      const fps = (1000 * frames) / (now - t0)
      report(
        `play: ${frames} frames in ${t.toFixed(1)} s, ${fps.toFixed(0)} fps, frame p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} ms\n` +
          `detail.update(): mean ${((updateMs / frames) * 1000).toFixed(1)} µs/frame\n` +
          `groundspeed text rewritten ${rewrites} times = ${(rewrites / t).toFixed(2)}/s (limit 4/s)`,
      )
    }
    if (raf !== 0) raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
}

// ---------- bench: the throttled path, full renders, detailRows ----------
function bench(): void {
  stop()
  const box = document.createElement('div')
  box.style.cssText = 'position:absolute;left:-10000px;top:0;width:400px;height:900px'
  document.body.append(box)
  const d = mountDetail(box, { onClose() {}, lookup })
  const lines: string[] = []
  // 1. Same aircraft, called far more often than 4/s: all but the first call only check the clock.
  d.update(S, RAW, INFO)
  const n1 = 200_000
  let a = performance.now()
  for (let i = 0; i < n1; i++) d.update(S, RAW, INFO)
  let ms = performance.now() - a
  lines.push(`update() throttled: ${((ms / n1) * 1e6).toFixed(0)} ns/call (${n1} calls, ${ms.toFixed(1)} ms)`)
  // 2. Alternate two aircraft: every call is a new selection, so every call renders every row.
  const other: Scene = scenarios['MLAT, sparse']
  const n2 = 5_000
  a = performance.now()
  for (let i = 0; i < n2; i++) {
    if (i % 2) d.update(...other)
    else d.update(S, RAW, INFO)
  }
  ms = performance.now() - a
  lines.push(`full render: ${((ms / n2) * 1000).toFixed(1)} µs (${n2} renders, ${ms.toFixed(1)} ms)`)
  // 3. The pure text alone.
  const gr = lookup('4691c4', 'AEE4266')
  const n3 = 50_000
  a = performance.now()
  let rows = 0
  for (let i = 0; i < n3; i++) rows += detailRows(S, RAW, INFO, gr).length
  ms = performance.now() - a
  lines.push(`detailRows(): ${((ms / n3) * 1000).toFixed(2)} µs (${n3} calls, ${rows / n3} sections)`)
  d.destroy()
  box.remove()
  report(`bench:\n${lines.join('\n')}`)
  console.log('[detail bench]', lines.join(' | '))
}

function button(label: string, pressedGroup: string | null, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  if (pressedGroup) b.dataset.group = pressedGroup
  b.addEventListener('click', () => {
    if (pressedGroup) {
      for (const o of controls.querySelectorAll<HTMLButtonElement>(`button[data-group="${pressedGroup}"]`)) o.setAttribute('aria-pressed', String(o === b))
    }
    onClick()
  })
  controls.append(b)
  return b
}

for (const [name, scene] of Object.entries(scenarios)) {
  const b = button(name, 'scene', () => {
    stop()
    current = scene
    note = ''
    show()
  })
  if (name === 'golden') b.setAttribute('aria-pressed', 'true')
}
button('play', 'scene', play)
button('bench', null, bench)
for (const bg of ['map', 'satellite', 'snow']) button(`bg: ${bg}`, 'bg', () => (document.body.dataset.bg = bg))

show()
// The photo request resolves after the first render: report its outcome once it has settled.
photos.get(RAW.hex).then((p) => {
  photoOutcome = p ? 'shown' : photos.failed(RAW.hex) ? 'failed (see the console)' : 'none on planespotters'
  report()
})
```

- [ ] **Step 2: Type-check the page**

Run: `npx tsc --noEmit 2>&1 | grep -E 'harness/detail'`
Expected: no output.

- [ ] **Step 3: Look at it**

Run `npx vite --port 5415 --strictPort` and open `http://localhost:5415/harness/detail.html`. Expected:
- On load (golden): the panel at the top left shows `AEE4266` and `4691C4`, then the photo of SX-DND with `Image © …` below it (on 2026-09-22 this was `Image © Marvin Knitl`). The image and the credit both link to the photo's planespotters.net page. Then Reg. `SX-DND`, Country `🇬🇷 Greece`, Airline `Aegean Airlines`, Squawk `7421`, Route `LGAV – LLBG`, and the four sections with the values from Task 2's golden test. The HUD at the bottom left is not covered. The stats box reads `photos=real: 1 planespotters request(s) this page, golden photo shown`. If the API refuses the request (a CORS error in the console), the panel reads `Photo unavailable` and the stats box says `failed`.
- `squawk 7700`: the squawk row reads `7700 · general` on red.
- `MLAT, sparse` and `non-ICAO ~`: `No photo`. The missing values read `—`.
- `?photos=demo`: the placeholder drawing fills the 3:2 box with its labelled credit below. At 375 px wide, the panel spans the width less the 8 px margins, the photo is a 120 px strip, and the page does not scroll sideways.
- `nothing selected` and `×`: the panel disappears.
- `play`: the groundspeed text changes about 4 times a second (the counter stays ≤ 4/s), the frame rate holds, and `detail.update()` costs a few µs per frame.
- `bench`: prints the per-call costs (see **Validated**).
- `Copy link` changes to `Copied`, and the clipboard holds `http://localhost:5415/?hex=4691c4`.

- [ ] **Step 4: Commit**

```bash
git add harness/detail.html harness/detail.ts
git commit -m "test(harness): detail panel page with a real photo, per-frame play and bench" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/ui/photo.test.ts client/ui/detail.test.ts`
Expected: `ℹ tests 27`, `ℹ pass 27`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui/(detail|photo)|harness/detail'`
Expected: no output.

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: tsc silent and every test passes (this package adds 27).

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short client/ui/detail* client/ui/photo* harness/detail*`
Expected: no output.
