# WP-S1 — Live Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the two live upstreams (adsb.lol v2 and your own readsb receiver) into `Source` objects. Each one sends one polite HTTP GET per call and returns a `FetchResult` that never throws on network trouble and carries the upstream's `Retry-After`. It also carries a normalized `Snapshot` only when the response is a 200 whose body parses.

**Architecture:** One shared transport (`server/sources/http.ts`): `timedFetch` wraps Node's global `fetch` with `AbortSignal.timeout`, `User-Agent` and `Accept-Encoding: gzip`, and folds every failure into `status 0`. `fetchSnapshot` adds the envelope normalizer from WP-00, and `hexList` builds a batch. The two sources are small factories that only build URLs and caps: `makeAdsblol` (area source, 1 req/s, `/v2/point` and `/v2/hex`) and `makeReadsb` (full-snapshot source, `/?all_with_pos`, `/?circle=`, `/?find_hex=`). Rate limiting and backoff are **not** here: S3's `TokenBucket` and I1's `Poller` decide *when* to call. This package only reports `status` and `retryAfterS` faithfully.

**Tech Stack:** Node ≥ 24.2 global `fetch` (undici) + `AbortSignal.timeout`; tests use `node:http` mock upstreams on port 0, `node:zlib` (gzip case), `node:test` + `node:assert/strict`. No new dependencies.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 1–1.5 h. **Validated:** every file below was run in a scratch copy of the WP-00 tree on 2026-09-22 (Node v25.2.1). `node --test server/sources/http.test.ts server/sources/adsblol.test.ts server/sources/readsb.test.ts` → 32/32 pass, stable over 5 consecutive runs, about 0.5 s per run. `npx tsc --noEmit` reports nothing in these six files. A clean rebuild was also run: the WP-00 files plus the six code blocks extracted from this plan, with nothing else. It gave `npx tsc --noEmit` exit 0 and `npm test` 72/72 (WP-00's 40 + these 32). No test touches the network: every URL is `http://127.0.0.1:<port 0>`.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints; they apply to every task here. The ones that matter most for this package:
- **Upstream politeness:** `Accept-Encoding: gzip` and `User-Agent: FlightHopper/0.1 (+${CONTACT})` on every adsb.lol request. 429 and `Retry-After` are *reported* (`status`, `retryAfterS`), not retried here. The budget (S3) and the poller (I1) act on them. 401/403 come back as that status, and this package never loops on them.
- **Unit tests never touch the network.** Tests use local `node:http` mock servers on port 0 that serve the WP-00 golden bodies. Never point a test or a manual run of this package at `adsb.lol`, `api.adsb.lol` or `globe.adsb.lol`: the day-1 recorder owns that budget.
- Erasable TypeScript only, `.ts` extensions on relative imports, `node:test` files next to the code.

**Verified upstream facts (read from source, no request sent to adsb.lol):**
- adsb.lol `github.com/adsblol/api` @ `3c969c8`, `src/adsb_api/utils/api_v2.py`: `/v2/point/{lat}/{lon}/{radius}` forwards `circle=lat,lon,min(int(radius), 250)` with `radius` constrained `ge=0, le=250` and parsed with `int()` (so it must be an integer string). `lat` is in [−90, 90] and `lon` in [−180, 180]. `/v2/hex/{icao_hex}` forwards `find_hex={icao_hex}` verbatim, so a comma list is one batched request.
- readsb `github.com/wiedehopf/readsb` `README-json.md` (dev): `/?circle=<lat>,<lon>,<radius in nmi>`, `/?find_hex=<hex1>,<hex2>,…` ("limited to 1000"), `/?all_with_pos` (position in the last minute), envelope `now` in **seconds**.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `server/sources/http.ts` | `timedFetch` (never throws), `parseRetryAfter`, `fetchSnapshot`, `hexList`, `FetchOpts` |
| `server/sources/http.test.ts` | mock-upstream tests: 200, chunked, gzip, headers, 429 (seconds and HTTP-date), 403, 500, timeout, refused, malformed |
| `server/sources/adsblol.ts` | `makeAdsblol(opts): Source`, `ADSBLOL_BASE` |
| `server/sources/adsblol.test.ts` | URL formats, caps, batch limits, `all()` unsupported, headers, failure statuses |
| `server/sources/readsb.ts` | `makeReadsb(opts): Source` |
| `server/sources/readsb.test.ts` | URL formats, caps, batch limits, the flip (readsb snapshot equals the adsb.lol snapshot) |

---

### Task 1: Polite timed fetch

**Files:**
- Create: `server/sources/http.ts`, `server/sources/http.test.ts`
- Test: `server/sources/http.test.ts`

**Interfaces:**
- Consumes: `FetchResult` (WP-00 `server/sources/types.ts`), `Snapshot` (WP-00 `shared/types.ts`), `normalizeAdsblol` (WP-00 `shared/readsb.ts`, test only), golden `data/fixtures/golden/adsblol-point-ksfo.json`
- Produces:
  - `interface FetchOpts { userAgent?: string; timeoutMs?: number }`
  - `timedFetch(url: string, opts: { userAgent?: string; timeoutMs?: number }): Promise<Omit<FetchResult, 'snapshot'>>`. It never throws. `status` is 0 on a network error, a timeout (default 10 s) or a failed body read, and then `body` is `''`, `bytes` is 0 and `retryAfterS` is null. `bytes` is `Content-Length` when present, else `Buffer.byteLength(body)`.
  - `parseRetryAfter(value: string | null, dateHeader: string | null, nowMs: number): number | null`. It reads delay-seconds, or an HTTP-date measured against the response `Date` header (else `nowMs`). It rounds up and is never negative.
  - `fetchSnapshot(url: string, normalize: (body: string) => Snapshot, opts: FetchOpts): Promise<FetchResult>`. `snapshot` is null unless the status is 200 **and** `normalize` succeeds.
  - `hexList(hexes: string[], max: number): string`. It lowercases and comma-joins the hexes, and throws `RangeError` when the list is empty or longer than `max`.

- [ ] **Step 1: Write the failing test**

```ts
// server/sources/http.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fetchSnapshot, hexList, parseRetryAfter, timedFetch } from './http.ts'
import { normalizeAdsblol } from '../../shared/readsb.ts'

const KSFO = readFileSync(new URL('../../data/fixtures/golden/adsblol-point-ksfo.json', import.meta.url), 'utf8')
const T = Date.UTC(2026, 8, 22, 12, 0, 0) // server clock for the HTTP-date case
const seen: { url: string; ua: string | undefined; ae: string | undefined }[] = []
let server: Server
let base = ''

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', ua: req.headers['user-agent'], ae: req.headers['accept-encoding'] })
    switch (req.url) {
      case '/ok': return void res.end(KSFO)                      // Node sets Content-Length
      case '/chunked': res.write('äöü'); return void res.end()    // no Content-Length
      case '/gzip': {
        const gz = gzipSync(KSFO)
        res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length })
        return void res.end(gz)
      }
      case '/429s': res.writeHead(429, { 'Retry-After': '7' }); return void res.end('slow down')
      case '/429d':
        res.writeHead(429, { Date: new Date(T).toUTCString(), 'Retry-After': new Date(T + 120_000).toUTCString() })
        return void res.end()
      case '/403': res.writeHead(403); return void res.end('blocked')
      case '/500': res.writeHead(500); return void res.end('oops')
      case '/bad': return void res.end('{"ac": [')
      case '/hang': return                                          // never responds
      default: res.writeHead(404); res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
  server.closeAllConnections()
  server.close()
})

test('200: body verbatim, bytes = Content-Length, times ordered', async () => {
  const r = await timedFetch(`${base}/ok`, {})
  assert.equal(r.url, `${base}/ok`)
  assert.equal(r.status, 200)
  assert.equal(r.body, KSFO)
  assert.equal(r.bytes, Buffer.byteLength(KSFO))
  assert.equal(r.retryAfterS, null)
  assert.ok(r.tSendMs <= r.tRecvMs && r.tRecvMs - r.tSendMs < 5000)
})

test('no Content-Length: bytes = UTF-8 byte length of the body', async () => {
  const r = await timedFetch(`${base}/chunked`, {})
  assert.equal(r.body, 'äöü')
  assert.equal(r.bytes, 6)
})

test('gzip: body is decoded, bytes are the compressed wire bytes', async () => {
  const r = await timedFetch(`${base}/gzip`, {})
  assert.equal(r.body, KSFO)
  assert.equal(r.bytes, gzipSync(KSFO).length)
  assert.ok(r.bytes < Buffer.byteLength(KSFO))
})

test('sends User-Agent and Accept-Encoding: gzip', async () => {
  await timedFetch(`${base}/ok?ua`, { userAgent: 'FlightHopper/0.1 (+test@example.com)' })
  const req = seen.find((s) => s.url === '/ok?ua')!
  assert.equal(req.ua, 'FlightHopper/0.1 (+test@example.com)')
  assert.equal(req.ae, 'gzip')
})

test('429 with Retry-After in seconds', async () => {
  const r = await timedFetch(`${base}/429s`, {})
  assert.equal(r.status, 429)
  assert.equal(r.retryAfterS, 7)
  assert.equal(r.body, 'slow down')
})

test('429 with Retry-After as HTTP-date, measured against the response Date header', async () => {
  const r = await timedFetch(`${base}/429d`, {})
  assert.equal(r.status, 429)
  assert.equal(r.retryAfterS, 120)
})

test('403 and 500 are returned as statuses, not thrown', async () => {
  assert.equal((await timedFetch(`${base}/403`, {})).status, 403)
  const r = await timedFetch(`${base}/500`, {})
  assert.equal(r.status, 500)
  assert.equal(r.body, 'oops')
})

test('timeout → status 0, empty body, no throw', async () => {
  const t0 = Date.now()
  const r = await timedFetch(`${base}/hang`, { timeoutMs: 200 })
  assert.equal(r.status, 0)
  assert.equal(r.body, '')
  assert.equal(r.bytes, 0)
  assert.equal(r.retryAfterS, null)
  assert.ok(Date.now() - t0 < 2000, 'timed out promptly')
})

test('connection refused → status 0', async () => {
  const dead = createServer()
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}/`
  await new Promise((r) => dead.close(r))
  const r = await timedFetch(url, { timeoutMs: 2000 })
  assert.equal(r.status, 0)
  assert.equal(r.body, '')
})

test('parseRetryAfter: seconds, HTTP-date, garbage', () => {
  assert.equal(parseRetryAfter(null, null, 0), null)
  assert.equal(parseRetryAfter('', null, 0), null)
  assert.equal(parseRetryAfter('soon', null, 0), null)
  assert.equal(parseRetryAfter(' 30 ', null, 0), 30)
  assert.equal(parseRetryAfter('1.5', null, 0), 1.5)
  // HTTP-date without a Date header: measured against nowMs, rounded up, never negative
  assert.equal(parseRetryAfter(new Date(T + 4500).toUTCString(), null, T), 4)
  assert.equal(parseRetryAfter(new Date(T + 4000).toUTCString(), null, T + 500), 4)
  assert.equal(parseRetryAfter(new Date(T - 60_000).toUTCString(), null, T), 0)
  // a Date header wins over the local clock (no skew)
  assert.equal(parseRetryAfter(new Date(T + 60_000).toUTCString(), new Date(T).toUTCString(), T + 3_600_000), 60)
})

test('fetchSnapshot: 200 → normalized snapshot', async () => {
  const r = await fetchSnapshot(`${base}/ok`, normalizeAdsblol, {})
  assert.deepEqual(r.snapshot, normalizeAdsblol(KSFO))
})

test('fetchSnapshot: malformed 200 body, non-200 and status 0 → snapshot null', async () => {
  const bad = await fetchSnapshot(`${base}/bad`, normalizeAdsblol, {})
  assert.equal(bad.status, 200)
  assert.equal(bad.body, '{"ac": [')
  assert.equal(bad.snapshot, null)
  assert.equal((await fetchSnapshot(`${base}/429s`, normalizeAdsblol, {})).snapshot, null)
  assert.equal((await fetchSnapshot(`${base}/hang`, normalizeAdsblol, { timeoutMs: 100 })).snapshot, null)
})

test('hexList: lowercased, comma-joined; empty or over the cap → RangeError', () => {
  assert.equal(hexList(['ABC123', '~a330E6'], 100), 'abc123,~a330e6')
  assert.throws(() => hexList([], 100), RangeError)
  assert.throws(() => hexList(Array.from({ length: 101 }, (_, i) => i.toString(16)), 100), RangeError)
  assert.equal(hexList(Array.from({ length: 100 }, () => 'a'), 100).split(',').length, 100)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/sources/http.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/sources/http.ts'`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// server/sources/http.ts
import type { Snapshot } from '../../shared/types.ts'
import type { FetchResult } from './types.ts'

export interface FetchOpts {
  userAgent?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Retry-After → seconds, or null when absent or unparseable.
 * delay-seconds are used as-is. An HTTP-date is measured against the response's own Date header when there is one
 * (no clock skew), else against nowMs; rounded up, never negative.
 */
export function parseRetryAfter(value: string | null, dateHeader: string | null, nowMs: number): number | null {
  const v = value?.trim() ?? ''
  if (v === '') return null
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v)
  const at = Date.parse(v)
  if (Number.isNaN(at)) return null
  const ref = dateHeader === null ? Number.NaN : Date.parse(dateHeader)
  return Math.max(0, Math.ceil((at - (Number.isNaN(ref) ? nowMs : ref)) / 1000))
}

/**
 * One polite GET. Never throws: network errors, timeouts and body-read failures come back as status 0 with an empty body.
 * Any HTTP status (403, 429, 5xx…) is returned as-is with its body. bytes = Content-Length (the wire size, compressed
 * when gzip was used) when present, else the UTF-8 length of the decoded body.
 */
export async function timedFetch(url: string, opts: FetchOpts): Promise<Omit<FetchResult, 'snapshot'>> {
  const headers: Record<string, string> = { 'Accept-Encoding': 'gzip' }
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent
  const tSendMs = Date.now()
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) })
    const body = await res.text()
    const tRecvMs = Date.now()
    const len = res.headers.get('content-length')
    return {
      url,
      status: res.status,
      tSendMs,
      tRecvMs,
      bytes: len !== null && /^\d+$/.test(len) ? Number(len) : Buffer.byteLength(body),
      body,
      retryAfterS: parseRetryAfter(res.headers.get('retry-after'), res.headers.get('date'), tRecvMs),
    }
  } catch {
    return { url, status: 0, tSendMs, tRecvMs: Date.now(), bytes: 0, body: '', retryAfterS: null }
  }
}

/** timedFetch + envelope normalizer. snapshot is null unless status is 200 AND the body normalizes. */
export async function fetchSnapshot(url: string, normalize: (body: string) => Snapshot, opts: FetchOpts): Promise<FetchResult> {
  const r = await timedFetch(url, opts)
  let snapshot: Snapshot | null = null
  if (r.status === 200) {
    try {
      snapshot = normalize(r.body)
    } catch {
      snapshot = null
    }
  }
  return { ...r, snapshot }
}

/** Hex batch for a URL: lowercased, comma-joined. Throws RangeError when empty or longer than max. */
export function hexList(hexes: string[], max: number): string {
  if (hexes.length === 0 || hexes.length > max) throw new RangeError(`need 1..${max} hexes, got ${hexes.length}`)
  return hexes.map((h) => h.toLowerCase()).join(',')
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/sources/http.test.ts`
Expected: PASS — `ℹ tests 13`, `ℹ pass 13`, `ℹ fail 0`.
The timeout case takes about 200 ms. The run exits on its own; if it hangs, a mock socket was left open (the `after` hook must call `closeAllConnections()`).

- [ ] **Step 5: Commit**

```bash
git add server/sources/http.ts server/sources/http.test.ts
git commit -m "feat(server): polite timed fetch with Retry-After parsing that never throws" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: adsb.lol source

**Files:**
- Create: `server/sources/adsblol.ts`, `server/sources/adsblol.test.ts`
- Test: `server/sources/adsblol.test.ts`

**Interfaces:**
- Consumes: `Source` (WP-00 `server/sources/types.ts`), `normalizeAdsblol` (WP-00 `shared/readsb.ts`), `fetchSnapshot`, `hexList` (Task 1), golden `adsblol-point-ksfo.json`, `adsblol-hex.json`, `readsb-circle.json`
- Produces:
  - `ADSBLOL_BASE = 'https://api.adsb.lol'` (default base URL; tests always pass a mock `baseUrl`)
  - `makeAdsblol(opts: { userAgent: string; baseUrl?: string; timeoutMs?: number }): Source` with:
    - `circle(lat, lon, nm)` → `GET {base}/v2/point/{lat.toFixed(4)}/{lon.toFixed(4)}/{min(250, round(nm))}`
    - `hexes(hs)` → `GET {base}/v2/hex/{hs lowercased, comma-joined}`. It rejects with `RangeError` when `hs` is empty or has more than 100 hexes, and sends no request.
    - `all()` rejects with `Error('unsupported')`
    - `caps = { kind: 'adsblol', fullSnapshot: false, maxRps: 1, coverage: null, attribution: 'adsb.lol (ODbL 1.0)' }`
  - A trailing `/` on `baseUrl` is tolerated.

- [ ] **Step 1: Write the failing test**

```ts
// server/sources/adsblol.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { ADSBLOL_BASE, makeAdsblol } from './adsblol.ts'
import { normalizeAdsblol } from '../../shared/readsb.ts'
import type { Source } from './types.ts'

const golden = (f: string): string => readFileSync(new URL(`../../data/fixtures/golden/${f}`, import.meta.url), 'utf8')
const POINT = golden('adsblol-point-ksfo.json')
const HEX = golden('adsblol-hex.json')
const UA = 'FlightHopper/0.1 (+test@example.com)'

// The mock answers by path prefix; `mode` switches the next responses to a failure.
let mode: 'ok' | '429' | '403' | '500' | 'bad' | 'readsb' = 'ok'
const seen: { url: string; ua: string | undefined; ae: string | undefined }[] = []
let server: Server
let src: Source
let base = ''

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', ua: req.headers['user-agent'], ae: req.headers['accept-encoding'] })
    if (mode === '429') { res.writeHead(429, { 'Retry-After': '30' }); return void res.end() }
    if (mode === '403') { res.writeHead(403); return void res.end('blocked') }
    if (mode === '500') { res.writeHead(500); return void res.end() }
    if (mode === 'bad') return void res.end('<html>maintenance</html>')
    if (mode === 'readsb') return void res.end(golden('readsb-circle.json'))
    if (req.url?.startsWith('/v2/point/')) return void res.end(POINT)
    if (req.url?.startsWith('/v2/hex/')) return void res.end(HEX)
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  src = makeAdsblol({ userAgent: UA, baseUrl: `${base}/`, timeoutMs: 2000 })
})

after(() => {
  server.closeAllConnections()
  server.close()
})

const last = () => seen[seen.length - 1]

test('caps: area source, 1 req/s, global, ODbL attribution', () => {
  assert.deepEqual(src.caps, { kind: 'adsblol', fullSnapshot: false, maxRps: 1, coverage: null, attribution: 'adsb.lol (ODbL 1.0)' })
  assert.equal(ADSBLOL_BASE, 'https://api.adsb.lol') // default; never contacted by tests
})

test('circle → /v2/point/{lat.toFixed(4)}/{lon.toFixed(4)}/{round(nm)}; snapshot = normalizeAdsblol(body)', async () => {
  mode = 'ok'
  const r = await src.circle(37.61881234, -122.37579999, 39.6)
  assert.equal(r.url, `${base}/v2/point/37.6188/-122.3758/40`)
  assert.equal(last().url, '/v2/point/37.6188/-122.3758/40')
  assert.equal(r.status, 200)
  assert.equal(r.body, POINT)
  assert.equal(r.bytes, Buffer.byteLength(POINT))
  assert.deepEqual(r.snapshot, normalizeAdsblol(POINT))
})

test('circle radius is capped at 250 nm', async () => {
  mode = 'ok'
  const r = await src.circle(0, 0, 400)
  assert.equal(r.url, `${base}/v2/point/0.0000/0.0000/250`)
})

test('hexes → /v2/hex/{lowercased,comma-joined}; snapshot = normalizeAdsblol(body)', async () => {
  mode = 'ok'
  const r = await src.hexes(['71BD79', 'A0B88D', '~a330e6'])
  assert.equal(r.url, `${base}/v2/hex/71bd79,a0b88d,~a330e6`)
  assert.equal(last().url, '/v2/hex/71bd79,a0b88d,~a330e6')
  assert.deepEqual(r.snapshot, normalizeAdsblol(HEX))
})

test('hexes: empty or more than 100 → RangeError, no request sent', async () => {
  const n0 = seen.length
  await assert.rejects(src.hexes([]), RangeError)
  await assert.rejects(src.hexes(Array.from({ length: 101 }, (_, i) => (0xa00000 + i).toString(16))), RangeError)
  assert.equal(seen.length, n0)
  mode = 'ok'
  assert.equal((await src.hexes(Array.from({ length: 100 }, (_, i) => (0xa00000 + i).toString(16)))).status, 200)
})

test('all() rejects with Error("unsupported")', async () => {
  await assert.rejects(src.all(), { name: 'Error', message: 'unsupported' })
})

test('sends User-Agent and Accept-Encoding: gzip', async () => {
  mode = 'ok'
  await src.circle(1, 2, 3)
  assert.equal(last().ua, UA)
  assert.equal(last().ae, 'gzip')
})

test('429: status, Retry-After, no snapshot', async () => {
  mode = '429'
  const r = await src.circle(1, 2, 3)
  assert.equal(r.status, 429)
  assert.equal(r.retryAfterS, 30)
  assert.equal(r.snapshot, null)
})

test('403 and 500: status kept, snapshot null', async () => {
  mode = '403'
  const blocked = await src.hexes(['abc123'])
  assert.equal(blocked.status, 403)
  assert.equal(blocked.snapshot, null)
  mode = '500'
  assert.equal((await src.circle(1, 2, 3)).status, 500)
})

test('200 with a body that does not normalize → snapshot null, body kept', async () => {
  mode = 'bad'
  const r = await src.circle(1, 2, 3)
  assert.equal(r.status, 200)
  assert.equal(r.body, '<html>maintenance</html>')
  assert.equal(r.snapshot, null)
  mode = 'readsb' // right JSON, wrong envelope
  assert.equal((await src.circle(1, 2, 3)).snapshot, null)
})

test('timeout → status 0', async () => {
  const hang = createServer(() => {})
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r))
  const s = makeAdsblol({ userAgent: UA, baseUrl: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`, timeoutMs: 200 })
  const r = await s.circle(1, 2, 3)
  assert.equal(r.status, 0)
  assert.equal(r.snapshot, null)
  hang.closeAllConnections()
  hang.close()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/sources/adsblol.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/sources/adsblol.ts'`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// server/sources/adsblol.ts
// adsb.lol v2 as a Source. Routes verified against github.com/adsblol/api src/adsb_api/utils/api_v2.py:
// /v2/point/{lat}/{lon}/{radius} → readsb circle= (radius int, 0..250 nm); /v2/hex/{hexes} → readsb find_hex= (comma list).
import { normalizeAdsblol } from '../../shared/readsb.ts'
import { fetchSnapshot, hexList } from './http.ts'
import type { Source } from './types.ts'

export const ADSBLOL_BASE = 'https://api.adsb.lol'
const MAX_RADIUS_NM = 250
// ponytail: 100 per batch keeps one chase request small; the upstream allows 1000. Raise it only if chases exceed 100.
const MAX_HEXES = 100

export function makeAdsblol(opts: { userAgent: string; baseUrl?: string; timeoutMs?: number }): Source {
  const base = (opts.baseUrl ?? ADSBLOL_BASE).replace(/\/+$/, '')
  const get = (path: string) => fetchSnapshot(base + path, normalizeAdsblol, { userAgent: opts.userAgent, timeoutMs: opts.timeoutMs })
  return {
    caps: { kind: 'adsblol', fullSnapshot: false, maxRps: 1, coverage: null, attribution: 'adsb.lol (ODbL 1.0)' },
    async circle(lat, lon, radiusNm) {
      return get(`/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.min(MAX_RADIUS_NM, Math.round(radiusNm))}`)
    },
    async hexes(hexes) {
      return get(`/v2/hex/${hexList(hexes, MAX_HEXES)}`)
    },
    async all() {
      throw new Error('unsupported')
    },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/sources/adsblol.test.ts`
Expected: PASS — `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/sources/adsblol.ts server/sources/adsblol.test.ts
git commit -m "feat(server): adsb.lol v2 source (point and hex batch, 250 nm and 100-hex caps)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: readsb receiver source

**Files:**
- Create: `server/sources/readsb.ts`, `server/sources/readsb.test.ts`
- Test: `server/sources/readsb.test.ts`

**Interfaces:**
- Consumes: `Source` (WP-00 `server/sources/types.ts`), `normalizeReadsb`, `normalizeAdsblol` (WP-00 `shared/readsb.ts`), `fetchSnapshot`, `hexList` (Task 1), golden `readsb-circle.json`, `adsblol-point-ksfo.json`
- Produces:
  - `makeReadsb(opts: { baseUrl: string; coverage: { lat: number; lon: number; radiusNm: number }; timeoutMs?: number }): Source` with:
    - `all()` → `GET {base}/?all_with_pos`
    - `circle(lat, lon, nm)` → `GET {base}/?circle={lat.toFixed(4)},{lon.toFixed(4)},{round(nm)}`
    - `hexes(hs)` → `GET {base}/?find_hex={hs lowercased, comma-joined}`. It rejects with `RangeError` when `hs` is empty or has more than 1000 hexes (readsb's own limit).
    - `caps = { kind: 'readsb', fullSnapshot: true, maxRps: 5, coverage: opts.coverage, attribution: 'own receiver (readsb)' }`
  - No `User-Agent` is set (it is your own box). `Accept-Encoding: gzip` is still sent, which is harmless if readsb ignores it.

- [ ] **Step 1: Write the failing test**

```ts
// server/sources/readsb.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { makeReadsb } from './readsb.ts'
import { normalizeAdsblol, normalizeReadsb } from '../../shared/readsb.ts'
import type { Source } from './types.ts'

const golden = (f: string): string => readFileSync(new URL(`../../data/fixtures/golden/${f}`, import.meta.url), 'utf8')
const CIRCLE = golden('readsb-circle.json')
const COVERAGE = { lat: 32.01, lon: 34.88, radiusNm: 200 }

let mode: 'ok' | '500' | 'bad' = 'ok'
const seen: string[] = []
let server: Server
let src: Source
let base = ''

before(async () => {
  server = createServer((req, res) => {
    seen.push(req.url ?? '')
    if (mode === '500') { res.writeHead(500); return void res.end() }
    if (mode === 'bad') return void res.end('{"now": 1790081633.5, "aircraft": [')
    res.end(CIRCLE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  src = makeReadsb({ baseUrl: base, coverage: COVERAGE, timeoutMs: 2000 })
})

after(() => {
  server.closeAllConnections()
  server.close()
})

const last = () => seen[seen.length - 1]

test('caps: full-snapshot receiver with its own coverage', () => {
  assert.deepEqual(src.caps, { kind: 'readsb', fullSnapshot: true, maxRps: 5, coverage: COVERAGE, attribution: 'own receiver (readsb)' })
})

test('all() → /?all_with_pos; snapshot = normalizeReadsb(body)', async () => {
  mode = 'ok'
  const r = await src.all()
  assert.equal(r.url, `${base}/?all_with_pos`)
  assert.equal(last(), '/?all_with_pos')
  assert.equal(r.status, 200)
  assert.equal(r.bytes, Buffer.byteLength(CIRCLE))
  assert.deepEqual(r.snapshot, normalizeReadsb(CIRCLE))
})

test('the flip: a readsb snapshot equals the adsb.lol snapshot of the same moment', async () => {
  mode = 'ok'
  const r = await src.all()
  assert.deepEqual(r.snapshot, normalizeAdsblol(golden('adsblol-point-ksfo.json')))
})

test('circle → /?circle=lat,lon,nm', async () => {
  mode = 'ok'
  const r = await src.circle(32.01141234, 34.88669999, 39.6)
  assert.equal(r.url, `${base}/?circle=32.0114,34.8867,40`)
  assert.equal(last(), '/?circle=32.0114,34.8867,40')
  assert.deepEqual(r.snapshot, normalizeReadsb(CIRCLE))
})

test('hexes → /?find_hex=lowercased,comma-joined; 1..1000 else RangeError', async () => {
  mode = 'ok'
  const r = await src.hexes(['738065', 'ABC123'])
  assert.equal(r.url, `${base}/?find_hex=738065,abc123`)
  const n0 = seen.length
  await assert.rejects(src.hexes([]), RangeError)
  await assert.rejects(src.hexes(Array.from({ length: 1001 }, () => 'abc123')), RangeError)
  assert.equal(seen.length, n0)
  assert.equal((await src.hexes(Array.from({ length: 1000 }, () => 'abc123'))).status, 200)
})

test('trailing slash on baseUrl is tolerated', async () => {
  mode = 'ok'
  const r = await makeReadsb({ baseUrl: `${base}/`, coverage: COVERAGE }).all()
  assert.equal(r.url, `${base}/?all_with_pos`)
})

test('500 and malformed 200 → snapshot null', async () => {
  mode = '500'
  const down = await src.all()
  assert.equal(down.status, 500)
  assert.equal(down.snapshot, null)
  mode = 'bad'
  const bad = await src.all()
  assert.equal(bad.status, 200)
  assert.equal(bad.snapshot, null)
})

test('receiver not running → status 0', async () => {
  const dead = createServer()
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`
  await new Promise((r) => dead.close(r))
  const r = await makeReadsb({ baseUrl: url, coverage: COVERAGE, timeoutMs: 500 }).all()
  assert.equal(r.status, 0)
  assert.equal(r.snapshot, null)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/sources/readsb.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/sources/readsb.ts'`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// server/sources/readsb.ts
// Your own receiver as a Source: readsb --net-api-port. Query syntax from github.com/wiedehopf/readsb README-json.md:
// /?circle=<lat>,<lon>,<radius nmi>, /?find_hex=<hex>,<hex>,… (limited to 1000), /?all_with_pos. Envelope: now in seconds.
import { normalizeReadsb } from '../../shared/readsb.ts'
import { fetchSnapshot, hexList } from './http.ts'
import type { Source } from './types.ts'

const MAX_HEXES = 1000

export function makeReadsb(opts: { baseUrl: string; coverage: { lat: number; lon: number; radiusNm: number }; timeoutMs?: number }): Source {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const get = (query: string) => fetchSnapshot(`${base}/?${query}`, normalizeReadsb, { timeoutMs: opts.timeoutMs })
  return {
    caps: { kind: 'readsb', fullSnapshot: true, maxRps: 5, coverage: opts.coverage, attribution: 'own receiver (readsb)' },
    async circle(lat, lon, radiusNm) {
      return get(`circle=${lat.toFixed(4)},${lon.toFixed(4)},${Math.round(radiusNm)}`)
    },
    async hexes(hexes) {
      return get(`find_hex=${hexList(hexes, MAX_HEXES)}`)
    },
    async all() {
      return get('all_with_pos')
    },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/sources/readsb.test.ts`
Expected: PASS — `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/sources/readsb.ts server/sources/readsb.test.ts
git commit -m "feat(server): readsb receiver source (all_with_pos, circle, find_hex)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: All tests of this package**

Run: `node --test server/sources/http.test.ts server/sources/adsblol.test.ts server/sources/readsb.test.ts`
Expected: `ℹ tests 32`, `ℹ pass 32`, `ℹ fail 0`.

- [ ] **Step 2: Type-check, filtered to this package**

Run: `npx tsc --noEmit 2>&1 | grep -E 'server/sources/(http|adsblol|readsb)'`
Expected: no output (grep exits 1).

- [ ] **Step 3: No test can reach the real upstream**

Run: `grep -nE 'https?://' server/sources/http.test.ts server/sources/adsblol.test.ts server/sources/readsb.test.ts | grep -v 127.0.0.1`
Expected: exactly one line, the `ADSBLOL_BASE` constant assertion in `adsblol.test.ts`, which is compared as a string and never fetched.

- [ ] **Step 4: Full check on the WP branch**

Run: `npm run check`
Expected: `tsc` silent and `ℹ fail 0`. On a branch cut from `wave-0` that is `ℹ tests 73` (WP-00's 41 + these 32).
