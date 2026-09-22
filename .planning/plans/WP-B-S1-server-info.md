# WP-B-S1 — Server Info Store, Routes and Gzip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the browse table and the detail panel what they need from the server, cheaply enough for thousands of aircraft: each aircraft's identity (`AircraftInfo`: callsign, registration, type, squawk, route…) on `/api/view`, sent only to clients that lack it; the newest full upstream object (`raw`) plus its info on `/api/chase`; gzip for JSON bodies; and, only with `ADSB_SOURCE=adsblol` and `ROUTES=1`, flight routes from adsb.lol's batched routeset endpoint within the poller's request budget.

**Architecture:**
- `server/infoStore.ts` — `InfoStore` keeps, per hex, the newest raw `ReadsbAircraft`, its receive time (`rxMs`, server clock), its `AircraftInfo` (`toInfo` from WP-B0) and `changedMs`, the server-clock time the info last changed (`sameInfo` false). It also holds the route cache, callsign → route or `null` (a miss), which `update()` puts into each new info. `setRoute(callsign, route)` caches for 6 h (a miss for 1 h) and rewrites the info of every aircraft flying that callsign. It stamps the change at `max(now, rxMs + 1)`, so the change always counts as after that aircraft's newest sample. `needRoutes(max)` lists airline-style callsigns (`/^[A-Z]{3}[0-9][0-9A-Z]{0,4}$/`) that have a position and no fresh cached answer, never-asked ones first. `prune(now, horizon)` forgets silent aircraft, and forgets expired routes 6 h after they expire.
- `server/poller.ts` (modified) — `PollerOpts.info?: InfoStore`. Every good answer feeds every non-hidden aircraft object to `info.update(ac, r.tRecvMs)`, including objects without a position, then prunes the store with `INFO_HORIZON_MS` (180 s, the same horizon as the SampleStore).
- `server/routes.ts` — `RouteFetcher.tick(store)` sends at most one `POST https://api.adsb.lol/api/0/routeset` with `{"planes":[{callsign,lat,lng}]}` (≤ 100 planes, lat/lng rounded to 3 decimals). The requests are ≥ `minIntervalMs` apart (default 60 s). Each request needs a token from the poller's `TokenBucket`, and each answer goes to `bucket.onResult(status, retryAfterS)` (429 pause and Retry-After; 401/403 blocks the whole adsb.lol source). `parseRouteset` reads the answer defensively. It takes ICAO `airport_codes` first, then `_airport_codes`, then `_airport_codes_iata`, and checks each code. Only `plausible: false` makes a route implausible. It returns `null` for a body that is not an array. The fetcher stores each plausible route. A requested callsign with no plausible route is stored as a miss. A failed request (network, 4xx/5xx, a body that is not a routeset) stores nothing.
- `server/main.ts` (modified) —
  - `/api/view` adds `info`. With `since=0` it sends every returned aircraft's info. After that it sends one aircraft's info only when that aircraft is new to the client (no stored sample at or before `since` inside the circle), was silent for ≥ 60 s (the client may have dropped it), or its info changed after the client's last sample of it. This is a superset of B0's "changed after `since`" rule. That rule loses aircraft that fly into a fixed view, and routes that arrive between two samples.
  - `/api/chase` adds `raw` (the newest full object, with `seen`/`seen_pos` aged to `serverNowMs`) and `info`. Both are `null` for unknown or hidden aircraft.
  - Every JSON body over 1 KB is gzipped (level 1, zlib thread pool) when `Accept-Encoding` lists gzip with q > 0. The response then gets `Content-Encoding: gzip`, `Vary: accept-encoding` and a compressed `Content-Length`.
  - A 100 ms route timer runs only when `ROUTES=1` and `ADSB_SOURCE=adsblol`. It is armed just before the poller's timer, in the same call. Node keeps same-period timers in one list and re-arms them in firing order, so the route tick always runs first. A due route request (≤ 1 a minute) therefore wins the next token, instead of losing every race to a cell poll (at `MAX_RPS` 0.08, cell polls want every token). A test proves this with one token and both requests due.
  - `createServer` also returns `info`. `deps.routesFetch` replaces `fetch` in tests.
- `server/config.ts` (modified) — `ROUTES` (`0`/`1`, default off; anything else throws). `SHOW_PIA_LADD` uses the same `flag()` parser.

Conventions consumers rely on (B-A, B-V2, B-U1, B-U2):
- The client merges `ViewResponse.info` by hex. `info` is always present, often empty.
- If `Fleet.prune` drops entries younger than 60 s, it must keep their `AircraftInfo`: the server resends info only after ≥ 60 s of silence.
- `ChaseResponse.raw` ages are current at `serverNowMs`. The detail panel can show `raw.seen` as "last seen" directly.
- Routes are ICAO codes joined by `-` (`LROP-OTHH`), per B0's `AircraftInfo.route`.
- Browsers and `ApiClient` (`fetch`) inflate gzip transparently. No client change is needed.

**Tech Stack:** Node ≥ 24.2 stdlib only: `node:http`, `node:zlib` (`gzip`, level 1), `node:util` `promisify`, and global `fetch` (for the routeset POST only). `node:test` + `node:assert/strict`. No new dependencies. The routeset shape was verified from source, never by calling the API. Source: github.com/adsblol/api at commit `3c969c84f6f659e1c83715a73cb6c2b6eb1d1d89` (2026-06-03), `src/adsb_api/utils/api_routes.py` (`api_routeset`, `calc_plausible`), `src/adsb_api/utils/provider.py` (`RedisVRS._route`, `get_routes_bulk`, `cache_route`), `src/adsb_api/utils/models.py` (`PlaneList`, `PlaneInstance`) and `src/adsb_api/utils/plausible.py`. Fetched from https://raw.githubusercontent.com/adsblol/api/3c969c84f6f659e1c83715a73cb6c2b6eb1d1d89/src/adsb_api/utils/api_routes.py (and the sibling files). The route data comes from vradarserver/standing-data. This package ships no data and copies no code: `parseRouteset` is our own reader of the published JSON shape.

**Wave:** B (parallel with B-C1, B-C2, B-V1, B-V2, B-V3, B-U1 and B-U2; depends only on WP-B0). Consumed by B-A (view `info`, chase `raw` + `info`, `ROUTES`). **Estimated:** 2.5 h. **Validated:** on 2026-09-22 (Node 25.2.1, TypeScript 7.0.2). Setting: the integrated tree (27 WPs + V4 Task 4 + B0), while the other B-* packages were being written in the same tree. This package's 7 test files (5 new or changed, plus `poller.test.ts` and `main.test.ts`): 54/54 pass. `npx tsc --noEmit` shows no errors under `server/`. Full `npm test` in that tree: 578/578.

**Replay.** An isolated copy of the B0 tree (tsc clean, 460/460) was rebuilt from this plan alone, task by task:
- Task 1: 9/12, then 12/12.
- Task 2: `ERR_MODULE_NOT_FOUND`, then 5/5.
- Task 3: missing export `INFO_HORIZON_MS`, then 19/19.
- Task 4: `ERR_MODULE_NOT_FOUND`, then 6/6.
- Task 5: 0/5, then 5/5, and `main.test.ts` 7/7.

Every code block is byte-identical to the tested file. After the replay: tsc clean, `npm test` 480/480.

**Budget** (≤ 50 ms): `/api/view` for a 250 nm circle holding 5,000 aircraft (11 samples each), server side, request to the last gzipped byte:
- Run alone: `since=0` median 12–16 ms (2.7 MB of JSON → 199,671 B gzip); a client one poll behind, median 15–21 ms (166,305 B).
- While the whole suite runs in parallel: 23 ms and 26 ms.

**Profile** (5,000 aircraft with randomised fields):

| Step | Time |
|---|---|
| `store.view` | 0.4 ms |
| `InfoStore.since` | 0.7 ms |
| per-aircraft `track` windows | 0.8 ms |
| `JSON.stringify` (2.67 MB) | 2.6 ms |
| gzip level 1 | 10.1 ms → 429 KB |
| gzip level 4 | 17.3 ms → 392 KB |
| gzip level 6 | 23.7 ms → 348 KB |
| ingest of one 5,000-aircraft answer (`toSample` + `InfoStore.update`) | 4–5 ms |

**Mutations** (each one was killed by a test):
- Route timer armed after the poller's: the routes test times out, because a cell poll wins the only token.
- Circle-entry rule, silence rule or `setRoute`'s `rxMs + 1` stamp removed: the view test fails.
- A late answer overwrites a newer `raw`, an implausible route is accepted, or the poller stamps another `rxMs`: the unit tests fail.

**CLI check** (Task 6 Step 4) on port 8797: `content-encoding: gzip` and `vary: accept-encoding` on the view; the chase has `raw.seen` aged to now and `info.callsign` `SKW5549`.

**Network:** only api.github.com and raw.githubusercontent.com, for the adsblol/api source. No request went to any adsb.lol host.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- **Upstream politeness.** Route requests share the poller's `TokenBucket`, so they count against `MAX_RPS` and obey its 429, Retry-After and 403 handling. They run only with `ADSB_SOURCE=adsblol` **and** `ROUTES=1` (default off). At `MAX_RPS=0.08` one request a minute uses about 21 % of the budget, so leave `ROUTES` off while the recorder owns the adsb.lol budget. **Unit tests never touch the network**: they use a fake `fetch`, an in-memory source and 127.0.0.1 only.
- **Time.** `rxMs`, `changedMs` and route expiry are server clock (the injected `nowMs`).
- **Privacy.** PIA/LADD aircraft never reach the InfoStore unless `SHOW_PIA_LADD=1` (the poller skips them before `info.update`).
- **File ownership.** This package creates `server/infoStore.ts`, `server/routes.ts` and their tests, and edits `server/poller.ts`, `server/main.ts` and `server/config.ts`. It also edits one existing test, `server/config.test.ts`, because that test compares the whole `ServerConfig` with `deepEqual` and so must list the new `routes: false` default (a forced change). Every other existing test passes unchanged. `.env.example` (WP-00) is not touched. B-A may add a `ROUTES=0` line there.

## Files owned by this package

| Path | Change |
|---|---|
| `server/config.ts` | modified: `ServerConfig.routes` from `ROUTES` (`0`/`1`, default off) |
| `server/config.test.ts` | modified: the defaults `deepEqual` gains `routes: false`; one new `ROUTES` test; one new invalid case |
| `server/infoStore.ts`, `server/infoStore.test.ts` | new: `InfoStore`, `ROUTE_TTL_MS`, `MISS_TTL_MS` |
| `server/poller.ts` | modified: `PollerOpts.info?`, `INFO_HORIZON_MS`, the feed and prune in `#ingest` |
| `server/poller.info.test.ts` | new: the poller → InfoStore feed |
| `server/routes.ts`, `server/routes.test.ts` | new: `RouteFetcher`, `parseRouteset`, `ROUTESET_URL`, `MAX_PLANES` |
| `server/main.ts` | modified: view `info`, chase `raw` + `info`, gzip, route timer, `createServer(...).info`, `deps.routesFetch` |
| `server/main.browse.test.ts` | new: end-to-end view/chase/gzip/routes, and the 5,000-aircraft view budget |

---

### Task 1: `ROUTES` setting

**Files:**
- Modify: `server/config.ts`, `server/config.test.ts`
- Test: `server/config.test.ts`

**Interfaces:**
- Consumes: `readServerConfig`, `ServerConfig` (WP-A1)
- Produces: `ServerConfig.routes: boolean` (`ROUTES=1` → true; unset, empty or `0` → false; anything else throws `ROUTES must be 0 or 1, got "…"`)

- [ ] **Step 1: Write the failing tests** (the whole file; changes: `routes: false` in the defaults, a new `ROUTES` test, a new invalid case)

File: `server/config.test.ts`
```ts
// server/config.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readServerConfig } from './config.ts'

const FILE = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))

test('defaults: replay at 1 req/s on port 8787, no recording, PIA/LADD hidden, client from dist/', () => {
  assert.deepEqual(readServerConfig({ REPLAY_FILES: FILE }), {
    source: 'replay',
    contact: null,
    maxRps: 1,
    readsbUrl: 'http://127.0.0.1:8042',
    readsbCoverage: null,
    replayFiles: [FILE],
    replaySpeed: 1,
    recordDir: null,
    port: 8787,
    showPiaLadd: false,
    routes: false,
    staticDir: 'dist',
  })
})

test('REPLAY_FILES defaults to data/fixtures/*.jsonl (relative to the working directory)', () => {
  // The curated fixtures are promoted from recordings later, so the default pattern may match nothing yet.
  try {
    const cfg = readServerConfig({})
    assert.ok(cfg.replayFiles.length > 0)
    for (const f of cfg.replayFiles) assert.match(f, /^data\/fixtures\/[^/]+\.jsonl$/)
  } catch (e) {
    assert.match((e as Error).message, /^REPLAY_FILES matched no files: data\/fixtures\/\*\.jsonl/)
  }
})

test('REPLAY_FILES: comma-separated paths and globs, each glob sorted, duplicates dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fh-config-'))
  for (const f of ['b.jsonl', 'a.jsonl', 'c.txt']) writeFileSync(join(dir, f), '')
  const cfg = readServerConfig({ REPLAY_FILES: ` ${FILE} , ${dir}/*.jsonl,${join(dir, 'a.jsonl')}` })
  assert.deepEqual(cfg.replayFiles, [FILE, join(dir, 'a.jsonl'), join(dir, 'b.jsonl')])
})

test('REPLAY_FILES that match nothing throw', () => {
  assert.throws(() => readServerConfig({ REPLAY_FILES: '/nonexistent/*.jsonl' }), /^Error: REPLAY_FILES matched no files: \/nonexistent\/\*\.jsonl/)
  assert.throws(() => readServerConfig({ REPLAY_FILES: '/nonexistent/day.jsonl' }), /REPLAY_FILES matched no files/)
})

test('adsblol without CONTACT throws: adsb.lol asks for a contact in the User-Agent', () => {
  assert.throws(() => readServerConfig({ ADSB_SOURCE: 'adsblol' }), /CONTACT is required for ADSB_SOURCE=adsblol/)
  assert.throws(() => readServerConfig({ ADSB_SOURCE: 'adsblol', CONTACT: '   ' }), /CONTACT is required/)
})

test('adsblol: MAX_RPS is clamped to 1 and replay files are not looked at', () => {
  const env = { ADSB_SOURCE: 'adsblol', CONTACT: ' me@example.invalid ', REPLAY_FILES: '/nonexistent/*.jsonl' }
  const cfg = readServerConfig(env)
  assert.equal(cfg.source, 'adsblol')
  assert.equal(cfg.contact, 'me@example.invalid')
  assert.equal(cfg.maxRps, 1)
  assert.deepEqual(cfg.replayFiles, [])
  assert.equal(readServerConfig({ ...env, MAX_RPS: '5' }).maxRps, 1)
  assert.equal(readServerConfig({ ...env, MAX_RPS: '0.5' }).maxRps, 0.5)
})

test('readsb: READSB_URL and READSB_COVERAGE "lat,lon,nm"; MAX_RPS is not clamped', () => {
  const cfg = readServerConfig({ ADSB_SOURCE: 'readsb', READSB_URL: 'http://pi.local:8042/', READSB_COVERAGE: '32.01, 34.88, 200' })
  assert.equal(cfg.source, 'readsb')
  assert.equal(cfg.readsbUrl, 'http://pi.local:8042/')
  assert.deepEqual(cfg.readsbCoverage, { lat: 32.01, lon: 34.88, radiusNm: 200 })
  assert.equal(cfg.maxRps, 1)
  assert.deepEqual(cfg.replayFiles, [])
  assert.equal(readServerConfig({ ADSB_SOURCE: 'readsb', READSB_COVERAGE: '32,34,200', MAX_RPS: '5' }).maxRps, 5)
})

test('readsb: coverage is required and checked; the URL must be http(s)', () => {
  assert.throws(() => readServerConfig({ ADSB_SOURCE: 'readsb' }), /READSB_COVERAGE is required for ADSB_SOURCE=readsb/)
  for (const bad of ['32,34', '32,,200', '91,34,200', '32,181,200', '32,34,0', '32,34,x', '32,34,200,1']) {
    assert.throws(() => readServerConfig({ ADSB_SOURCE: 'readsb', READSB_COVERAGE: bad }), /READSB_COVERAGE must be/, bad)
  }
  for (const bad of ['not a url', 'ftp://pi.local:8042', 'pi.local:8042']) {
    assert.throws(() => readServerConfig({ ADSB_SOURCE: 'readsb', READSB_COVERAGE: '32,34,200', READSB_URL: bad }), /READSB_URL must be/, bad)
  }
})

test('RECORD_DIR, REPLAY_SPEED, PORT, SHOW_PIA_LADD', () => {
  const cfg = readServerConfig({ REPLAY_FILES: FILE, RECORD_DIR: 'data/recordings', REPLAY_SPEED: '10', PORT: '0', SHOW_PIA_LADD: '1' })
  assert.equal(cfg.recordDir, 'data/recordings')
  assert.equal(cfg.replaySpeed, 10)
  assert.equal(cfg.port, 0)
  assert.equal(cfg.showPiaLadd, true)
  const blank = readServerConfig({ REPLAY_FILES: FILE, RECORD_DIR: '', PORT: '', SHOW_PIA_LADD: '0' })
  assert.equal(blank.recordDir, null)
  assert.equal(blank.port, 8787)
  assert.equal(blank.showPiaLadd, false)
})

test('ROUTES: 1 turns route lookups on, 0 or unset leaves them off', () => {
  assert.equal(readServerConfig({ REPLAY_FILES: FILE, ROUTES: '1' }).routes, true)
  assert.equal(readServerConfig({ REPLAY_FILES: FILE, ROUTES: '0' }).routes, false)
  assert.equal(readServerConfig({ REPLAY_FILES: FILE, ROUTES: ' ' }).routes, false)
  assert.equal(readServerConfig({ ADSB_SOURCE: 'adsblol', CONTACT: 'me@example.invalid', ROUTES: '1' }).routes, true)
})

test('invalid values throw a message that names the variable', () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ ADSB_SOURCE: 'opensky' }, /^Error: ADSB_SOURCE must be one of adsblol, readsb, replay, got "opensky"$/],
    [{ MAX_RPS: 'fast' }, /^Error: MAX_RPS must be a number > 0, got "fast"$/],
    [{ MAX_RPS: '0' }, /MAX_RPS must be a number > 0/],
    [{ MAX_RPS: '-1' }, /MAX_RPS must be a number > 0/],
    [{ MAX_RPS: 'Infinity' }, /MAX_RPS must be a number > 0/],
    [{ REPLAY_SPEED: '0' }, /REPLAY_SPEED must be a number > 0/],
    [{ PORT: '70000' }, /PORT must be an integer 0..65535/],
    [{ PORT: '80.5' }, /PORT must be an integer 0..65535/],
    [{ PORT: 'http' }, /PORT must be an integer 0..65535/],
    [{ SHOW_PIA_LADD: 'yes' }, /^Error: SHOW_PIA_LADD must be 0 or 1, got "yes"$/],
    [{ ROUTES: 'on' }, /^Error: ROUTES must be 0 or 1, got "on"$/],
  ]
  for (const [env, re] of cases) assert.throws(() => readServerConfig({ REPLAY_FILES: FILE, ...env }), re, JSON.stringify(env))
})

test('accepts process.env as it is', () => {
  const cfg = readServerConfig({ ...process.env, ADSB_SOURCE: 'replay', REPLAY_FILES: FILE, PORT: '0', MAX_RPS: '', REPLAY_SPEED: '', SHOW_PIA_LADD: '' })
  assert.equal(cfg.source, 'replay')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test server/config.test.ts`
Expected: FAIL — `ℹ tests 12`, `ℹ pass 9`, `ℹ fail 3`: the defaults test (`routes` missing), `ROUTES: 1 turns route lookups on…` (`actual: undefined, expected: true`), and `invalid values…` (`Missing expected exception: {"ROUTES":"on"}`).

- [ ] **Step 3: Write the implementation** (the whole file)

File: `server/config.ts`
```ts
// server/config.ts
// Server settings from environment variables. `npm run server` loads .env.local; .env.example lists them all.
import { globSync } from 'node:fs'
import type { SourceKind } from '../shared/types.ts'

export interface ServerConfig {
  source: SourceKind // ADSB_SOURCE, default replay
  contact: string | null // CONTACT, required for adsblol (it goes into the User-Agent)
  maxRps: number // MAX_RPS, default 1; never above 1 for adsblol
  readsbUrl: string // READSB_URL, default http://127.0.0.1:8042
  readsbCoverage: { lat: number; lon: number; radiusNm: number } | null // READSB_COVERAGE "lat,lon,nm", required for readsb
  replayFiles: string[] // REPLAY_FILES expanded to files (replay only), default data/fixtures/*.jsonl
  replaySpeed: number // REPLAY_SPEED, default 1
  recordDir: string | null // RECORD_DIR; unset or empty = no recording (replay is never recorded)
  port: number // PORT, default 8787
  showPiaLadd: boolean // SHOW_PIA_LADD=1 serves PIA/LADD-flagged aircraft
  routes: boolean // ROUTES=1 looks up flight routes on adsb.lol (only used with ADSB_SOURCE=adsblol); default off
  staticDir: string // the built client (`npm run build` → dist/)
}

type Env = Record<string, string | undefined>

const SOURCES: readonly string[] = ['adsblol', 'readsb', 'replay'] satisfies SourceKind[]
const DEFAULT_REPLAY_FILES = 'data/fixtures/*.jsonl'
const DEFAULT_READSB_URL = 'http://127.0.0.1:8042'

/** Trimmed value; unset and empty mean the same. */
const str = (env: Env, name: string): string => env[name]?.trim() ?? ''

function num(env: Env, name: string, def: number, ok: (v: number) => boolean, rule: string): number {
  const raw = str(env, name)
  if (raw === '') return def
  const v = Number(raw)
  if (!Number.isFinite(v) || !ok(v)) throw new Error(`${name} must be ${rule}, got "${raw}"`)
  return v
}

/** An unset/empty, 0 or 1 switch; anything else throws. */
function flag(env: Env, name: string): boolean {
  const v = str(env, name)
  if (v !== '' && v !== '0' && v !== '1') throw new Error(`${name} must be 0 or 1, got "${v}"`)
  return v === '1'
}

function coverage(raw: string): { lat: number; lon: number; radiusNm: number } {
  if (raw === '') throw new Error('READSB_COVERAGE is required for ADSB_SOURCE=readsb: "lat,lon,nm" around your receiver, e.g. 32.01,34.88,200')
  const p = raw.split(',').map((x) => (x.trim() === '' ? NaN : Number(x)))
  const [lat, lon, radiusNm] = p
  if (p.length !== 3 || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || !(radiusNm > 0) || !Number.isFinite(radiusNm)) {
    throw new Error(`READSB_COVERAGE must be "lat,lon,nm" with |lat| ≤ 90, |lon| ≤ 180, nm > 0, got "${raw}"`)
  }
  return { lat, lon, radiusNm }
}

/** Comma-separated paths and globs → existing files. Each pattern's matches are sorted; the first occurrence wins. */
function expand(patterns: string): string[] {
  const files = patterns
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .flatMap((p) => globSync(p).sort())
  return [...new Set(files)]
}

/** Reads and checks every setting; throws an Error naming the variable when one is invalid. */
export function readServerConfig(env: Env): ServerConfig {
  const source = str(env, 'ADSB_SOURCE') || 'replay'
  if (!SOURCES.includes(source)) throw new Error(`ADSB_SOURCE must be one of ${SOURCES.join(', ')}, got "${source}"`)
  const kind = source as SourceKind

  const contact = str(env, 'CONTACT') || null
  if (kind === 'adsblol' && contact === null) {
    throw new Error('CONTACT is required for ADSB_SOURCE=adsblol: adsb.lol asks every client for a contact (email or URL) in its User-Agent')
  }
  const maxRps = num(env, 'MAX_RPS', 1, (v) => v > 0, 'a number > 0')

  const readsbUrl = str(env, 'READSB_URL') || DEFAULT_READSB_URL
  let readsbCoverage: ServerConfig['readsbCoverage'] = null
  if (kind === 'readsb') {
    if (!/^https?:\/\//.test(readsbUrl) || !URL.canParse(readsbUrl)) throw new Error(`READSB_URL must be an http(s) URL, got "${readsbUrl}"`)
    readsbCoverage = coverage(str(env, 'READSB_COVERAGE'))
  }

  const patterns = str(env, 'REPLAY_FILES') || DEFAULT_REPLAY_FILES
  const replayFiles = kind === 'replay' ? expand(patterns) : []
  if (kind === 'replay' && replayFiles.length === 0) throw new Error(`REPLAY_FILES matched no files: ${patterns}`)

  return {
    source: kind,
    contact,
    maxRps: kind === 'adsblol' ? Math.min(1, maxRps) : maxRps,
    readsbUrl,
    readsbCoverage,
    replayFiles,
    replaySpeed: num(env, 'REPLAY_SPEED', 1, (v) => v > 0, 'a number > 0'),
    recordDir: str(env, 'RECORD_DIR') || null,
    port: num(env, 'PORT', 8787, (v) => Number.isInteger(v) && v >= 0 && v <= 65535, 'an integer 0..65535'),
    showPiaLadd: flag(env, 'SHOW_PIA_LADD'),
    routes: flag(env, 'ROUTES'),
    staticDir: 'dist',
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test server/config.test.ts`
Expected: PASS — `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/config.ts server/config.test.ts
git commit -m "feat(server): ROUTES setting for adsb.lol route lookups (default off)"
```

---

### Task 2: InfoStore

**Files:**
- Create: `server/infoStore.ts`, `server/infoStore.test.ts`
- Test: `server/infoStore.test.ts`

**Interfaces:**
- Consumes: `ReadsbAircraft` (`shared/types.ts`), `AircraftInfo`, `toInfo`, `sameInfo` (`shared/info.ts`, WP-B0); golden fixture `data/fixtures/golden/adsblol-point-ksfo.json` (WP-00)
- Produces (PLAN.md §5.3, exactly): `class InfoStore { update(ac: ReadsbAircraft, rxMs: number): void; since(hexes: Iterable<string>, sinceRxMs: number): AircraftInfo[]; get(hex): AircraftInfo | null; raw(hex): ReadsbAircraft | null; setRoute(callsign: string, route: string | null): void; needRoutes(max: number): { callsign: string; lat: number; lon: number }[]; prune(nowMs: number, horizonMs: number): void }`. Extras: `constructor(opts?: { nowMs?: () => number })`, `changedMs(hex): number | null`, `rxMs(hex): number | null`, `get size(): number`, `ROUTE_TTL_MS` (6 h), `MISS_TTL_MS` (1 h)

- [ ] **Step 1: Write the failing test**

```ts
// server/infoStore.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeAdsblol } from '../shared/readsb.ts'
import type { ReadsbAircraft } from '../shared/types.ts'
import { InfoStore, MISS_TTL_MS, ROUTE_TTL_MS } from './infoStore.ts'

// adsb.lol envelope, 7 aircraft near KSFO: 71bd79 AAR202, a448f2 UAL1724, a1c7e4 UAL872, a0b88d (no callsign),
// a37732 OPS12, ~a330e6 (TIS-B, nothing but a position), 000001 (LADD)
const KSFO = normalizeAdsblol(readFileSync(new URL('../data/fixtures/golden/adsblol-point-ksfo.json', import.meta.url), 'utf8'))
const byHex = (hex: string): ReadsbAircraft => KSFO.aircraft.find((a) => a.hex === hex)!

const T0 = 2_000_000_000_000

function setup() {
  const clock = { t: T0 }
  return { clock, store: new InfoStore({ nowMs: () => clock.t }) }
}

test('update keeps the newest full object and its info per hex; get and raw take any case', () => {
  const { store } = setup()
  const ac = byHex('a448f2')
  store.update(ac, T0)
  assert.equal(store.raw('A448F2'), ac)
  assert.deepEqual(store.get('a448f2'), {
    hex: 'a448f2', callsign: 'UAL1724', reg: 'N37510', typeCode: 'B39M', category: 'A3', squawk: '2737', emergency: null, military: false, route: null,
  })
  assert.equal(store.rxMs('a448f2'), T0)
  assert.equal(store.get('abcdef'), null)
  assert.equal(store.raw('abcdef'), null)
  assert.equal(store.rxMs('abcdef'), null)

  const newer = { ...ac, seen: 0.1 }
  store.update(newer, T0 + 1000)
  assert.equal(store.raw('a448f2'), newer)
  store.update(ac, T0 + 500) // an older answer arriving late never replaces a newer one
  assert.equal(store.raw('a448f2'), newer)
  assert.equal(store.rxMs('a448f2'), T0 + 1000)
  assert.equal(store.size, 1)
})

test('since: everything when 0, else only infos that changed after sinceRxMs; unknown hexes are skipped', () => {
  const { store } = setup()
  for (const ac of KSFO.aircraft) store.update(ac, T0)
  const hexes = ['71bd79', 'a448f2', 'a1c7e4', 'nothere']
  assert.deepEqual(store.since(hexes, 0).map((i) => i.hex), ['71bd79', 'a448f2', 'a1c7e4'])
  assert.deepEqual(store.since(hexes, T0), [], 'nothing changed after T0')

  // A new position with the same identity is not a change; a new squawk is.
  store.update({ ...byHex('71bd79'), lat: 39 }, T0 + 1000)
  store.update({ ...byHex('a448f2'), squawk: '7700' }, T0 + 1000)
  const changed = store.since(new Set(hexes), T0)
  assert.deepEqual(changed.map((i) => [i.hex, i.squawk]), [['a448f2', '7700']])
  assert.equal(store.changedMs('A448F2'), T0 + 1000)
  assert.equal(store.changedMs('71bd79'), T0)
  assert.equal(store.changedMs('nothere'), null)
})

test('setRoute fills the route of every aircraft with that callsign, marks them changed, and is used for newcomers', () => {
  const { clock, store } = setup()
  store.update(byHex('a1c7e4'), T0) // UAL872
  store.update({ ...byHex('a448f2'), hex: 'aaaaaa', flight: 'UAL872  ' }, T0) // same callsign on another airframe
  store.update(byHex('71bd79'), T0)
  clock.t = T0 + 5000
  store.setRoute('UAL872', 'RJAA-KSFO')
  assert.equal(store.get('a1c7e4')?.route, 'RJAA-KSFO')
  assert.equal(store.get('aaaaaa')?.route, 'RJAA-KSFO')
  assert.equal(store.get('71bd79')?.route, null)
  assert.deepEqual(store.since(['a1c7e4', 'aaaaaa', '71bd79'], T0).map((i) => i.hex), ['a1c7e4', 'aaaaaa'])
  assert.equal(store.changedMs('a1c7e4'), T0 + 5000, 'changed at the store clock')

  // The next update keeps the cached route and is not a change.
  store.update({ ...byHex('a1c7e4'), lat: 40 }, T0 + 6000)
  assert.equal(store.get('a1c7e4')?.route, 'RJAA-KSFO')
  assert.equal(store.changedMs('a1c7e4'), T0 + 5000)
  // An aircraft that shows up later with a cached callsign gets the route at once.
  store.update({ ...byHex('a448f2'), hex: 'bbbbbb', flight: 'UAL872' }, T0 + 7000)
  assert.equal(store.get('bbbbbb')?.route, 'RJAA-KSFO')
  // A miss clears it; a change in the same millisecond as the newest answer is stamped just after it.
  clock.t = T0 + 7000
  store.setRoute('UAL872', null)
  assert.equal(store.get('a1c7e4')?.route, null)
  assert.equal(store.changedMs('bbbbbb'), T0 + 7001)
  assert.equal(store.changedMs('a1c7e4'), T0 + 7000)
})

test('needRoutes: airline-style callsigns with a position and no fresh cached answer, deduped, capped', () => {
  const { clock, store } = setup()
  for (const ac of KSFO.aircraft) store.update(ac, T0)
  store.update({ ...byHex('a448f2'), hex: 'aaaaaa' }, T0) // UAL1724 twice
  store.update({ ...byHex('a448f2'), hex: 'cccccc', flight: 'N37510', lat: undefined, lon: undefined }, T0) // registration, no position
  store.update({ ...byHex('a448f2'), hex: 'dddddd', flight: 'DAL45', lat: undefined }, T0) // no position
  const a448 = byHex('a448f2')
  assert.deepEqual(store.needRoutes(10), [
    { callsign: 'AAR202', lat: byHex('71bd79').lat, lon: byHex('71bd79').lon },
    { callsign: 'UAL1724', lat: a448.lat, lon: a448.lon },
    { callsign: 'UAL872', lat: byHex('a1c7e4').lat, lon: byHex('a1c7e4').lon },
    { callsign: 'OPS12', lat: byHex('a37732').lat, lon: byHex('a37732').lon },
  ])
  assert.equal(store.needRoutes(2).length, 2)
  assert.deepEqual(store.needRoutes(0), [])

  store.setRoute('AAR202', 'RKSI-KSFO')
  store.setRoute('OPS12', null)
  assert.deepEqual(store.needRoutes(10).map((p) => p.callsign), ['UAL1724', 'UAL872'])
  // A miss is asked again after an hour, a route after six; never-asked callsigns come before stale ones.
  clock.t = T0 + MISS_TTL_MS
  assert.deepEqual(store.needRoutes(10).map((p) => p.callsign), ['UAL1724', 'UAL872', 'OPS12'])
  clock.t = T0 + ROUTE_TTL_MS
  assert.deepEqual(store.needRoutes(10).map((p) => p.callsign), ['UAL1724', 'UAL872', 'AAR202', 'OPS12'])
  // A stale route is still shown until the new answer arrives.
  store.update({ ...byHex('71bd79'), lat: 38.5 }, T0 + ROUTE_TTL_MS)
  assert.equal(store.get('71bd79')?.route, 'RKSI-KSFO')
})

test('prune drops aircraft not updated within the horizon, and routes long expired', () => {
  const { clock, store } = setup()
  store.update(byHex('a1c7e4'), T0)
  store.update(byHex('a448f2'), T0 + 100_000)
  store.prune(T0 + 180_000, 180_000)
  assert.equal(store.size, 2, 'exactly at the horizon is kept')
  store.prune(T0 + 180_001, 180_000)
  assert.equal(store.get('a1c7e4'), null)
  assert.equal(store.get('a448f2')?.callsign, 'UAL1724')
  assert.equal(store.size, 1)

  store.setRoute('UAL872', 'RJAA-KSFO') // at T0: expires T0 + 6 h and is forgotten 6 h after that
  clock.t = T0 + 2 * ROUTE_TTL_MS
  store.prune(clock.t, 180_000)
  store.update(byHex('a1c7e4'), clock.t)
  assert.equal(store.get('a1c7e4')?.route, 'RJAA-KSFO')
  clock.t += 1
  store.prune(clock.t, 180_000)
  store.update(byHex('a1c7e4'), clock.t)
  assert.equal(store.get('a1c7e4')?.route, null)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/infoStore.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/infoStore.ts' imported from …/server/infoStore.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// server/infoStore.ts
// Per aircraft: the newest full upstream object (for the detail panel) and its AircraftInfo (for the table), with the
// server-clock time the info last changed. Plus the route cache (callsign → route) that RouteFetcher fills.
import { sameInfo, toInfo, type AircraftInfo } from '../shared/info.ts'
import type { ReadsbAircraft } from '../shared/types.ts'

/** A known route is asked again after 6 h, a miss (the upstream has none) after 1 h. */
export const ROUTE_TTL_MS = 6 * 3_600_000
export const MISS_TTL_MS = 3_600_000

// Route databases know airline flights only: an ICAO airline designator + a flight number (UAL872, EZY84AB).
// ponytail: registrations and military/GA callsigns are never asked; a few non-airline ones (OPS12 ground vehicles)
// still match and cost one negative-cache slot for an hour.
const AIRLINE_CALLSIGN = /^[A-Z]{3}[0-9][0-9A-Z]{0,4}$/

interface Entry {
  raw: ReadsbAircraft
  rxMs: number // server clock of the answer raw came from
  info: AircraftInfo
  changedMs: number // server clock when info last changed
}

interface CachedRoute {
  route: string | null // null = the upstream has no (plausible) route: negative cache
  expiresMs: number
}

export class InfoStore {
  #now: () => number
  #byHex = new Map<string, Entry>()
  #routes = new Map<string, CachedRoute>()

  /** nowMs is the server clock (setRoute's change time, route expiry). */
  constructor(opts: { nowMs?: () => number } = {}) {
    this.#now = opts.nowMs ?? Date.now
  }

  /** One upstream aircraft object received at rxMs (server clock). An object older than the stored one is ignored. */
  update(ac: ReadsbAircraft, rxMs: number): void {
    const hex = ac.hex.toLowerCase()
    const e = this.#byHex.get(hex)
    if (e && rxMs < e.rxMs) return
    const callsign = typeof ac.flight === 'string' ? ac.flight.trim() : ''
    const info = toInfo(ac, this.#routes.get(callsign)?.route ?? null)
    if (!e) {
      this.#byHex.set(hex, { raw: ac, rxMs, info, changedMs: rxMs })
      return
    }
    e.raw = ac
    e.rxMs = rxMs
    if (!sameInfo(e.info, info)) {
      e.info = info
      e.changedMs = rxMs
    }
  }

  /** Infos of these hexes that changed after sinceRxMs; every one of them when sinceRxMs ≤ 0. Pass each hex once. */
  since(hexes: Iterable<string>, sinceRxMs: number): AircraftInfo[] {
    const out: AircraftInfo[] = []
    for (const hex of hexes) {
      const e = this.#byHex.get(hex.toLowerCase())
      if (e && (sinceRxMs <= 0 || e.changedMs > sinceRxMs)) out.push(e.info)
    }
    return out
  }

  /** Server-clock time this hex's info last changed (first seen, identity change or route). */
  changedMs(hex: string): number | null {
    return this.#byHex.get(hex.toLowerCase())?.changedMs ?? null
  }

  get(hex: string): AircraftInfo | null {
    return this.#byHex.get(hex.toLowerCase())?.info ?? null
  }

  /** The newest full upstream object, as received (its seen / seen_pos count from rxMs(hex)). */
  raw(hex: string): ReadsbAircraft | null {
    return this.#byHex.get(hex.toLowerCase())?.raw ?? null
  }

  /** Server-clock receive time of raw(hex). */
  rxMs(hex: string): number | null {
    return this.#byHex.get(hex.toLowerCase())?.rxMs ?? null
  }

  /**
   * Caches a route (null = none) for this callsign and puts it into the info of every aircraft flying it. The change
   * is stamped now, but always after the aircraft's newest answer, so "changed after the client's last sample of it"
   * holds even when both fall in the same millisecond.
   */
  setRoute(callsign: string, route: string | null): void {
    const cs = callsign.trim()
    const now = this.#now()
    this.#routes.set(cs, { route, expiresMs: now + (route === null ? MISS_TTL_MS : ROUTE_TTL_MS) })
    // ponytail: a scan of every aircraft per callsign; ≤ 100 callsigns a minute × 5,000 aircraft is ~1 ms.
    for (const e of this.#byHex.values()) {
      if (e.info.callsign !== cs || e.info.route === route) continue
      e.info = { ...e.info, route }
      e.changedMs = Math.max(now, e.rxMs + 1)
    }
  }

  /**
   * Up to max airline callsigns (with the aircraft's position) that have no fresh cached answer:
   * never-asked ones first, then expired ones. Each callsign once.
   */
  needRoutes(max: number): { callsign: string; lat: number; lon: number }[] {
    const now = this.#now()
    const fresh: { callsign: string; lat: number; lon: number }[] = []
    const stale: { callsign: string; lat: number; lon: number }[] = []
    const seen = new Set<string>()
    for (const e of this.#byHex.values()) {
      if (fresh.length >= max) break
      const cs = e.info.callsign
      const { lat, lon } = e.raw
      if (cs === null || seen.has(cs) || !AIRLINE_CALLSIGN.test(cs)) continue
      if (typeof lat !== 'number' || typeof lon !== 'number') continue
      const cached = this.#routes.get(cs)
      if (cached && cached.expiresMs > now) continue
      seen.add(cs)
      ;(cached ? stale : fresh).push({ callsign: cs, lat, lon })
    }
    return fresh.concat(stale).slice(0, Math.max(0, max))
  }

  /**
   * Forgets aircraft not updated within horizonMs. An expired route stays (and is still shown) until it is fetched
   * again, but is forgotten ROUTE_TTL_MS after it expired, so the cache cannot grow without bound.
   */
  prune(nowMs: number, horizonMs: number): void {
    const cutoff = nowMs - horizonMs
    for (const [hex, e] of this.#byHex) if (e.rxMs < cutoff) this.#byHex.delete(hex)
    for (const [cs, r] of this.#routes) if (r.expiresMs + ROUTE_TTL_MS < nowMs) this.#routes.delete(cs)
  }

  /** Number of aircraft held. */
  get size(): number {
    return this.#byHex.size
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/infoStore.test.ts`
Expected: PASS — `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/infoStore.ts server/infoStore.test.ts
git commit -m "feat(server): InfoStore — newest raw aircraft, info with change time, route cache"
```

---

### Task 3: The poller feeds the InfoStore

**Files:**
- Modify: `server/poller.ts`
- Create: `server/poller.info.test.ts`
- Test: `server/poller.info.test.ts`, `server/poller.test.ts` (unchanged, must stay green)

**Interfaces:**
- Consumes: `InfoStore` (Task 2); `Poller`, `PollerOpts` (WP-I1/A1); `TokenBucket` (WP-S3); `SampleStore` (WP-S4)
- Produces: `PollerOpts.info?: InfoStore` (PLAN.md §5.3). Every good answer calls `info.update(ac, r.tRecvMs)` for every non-hidden aircraft, then `info.prune(now, INFO_HORIZON_MS)`. Extra: `export const INFO_HORIZON_MS = 180_000`

- [ ] **Step 1: Write the failing test**

```ts
// server/poller.info.test.ts
// The poller hands every non-hidden upstream aircraft to the InfoStore, stamped with the answer's receive time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeAdsblol } from '../shared/readsb.ts'
import { TokenBucket } from './budget.ts'
import { InfoStore } from './infoStore.ts'
import { INFO_HORIZON_MS, Poller } from './poller.ts'
import type { FetchResult, Source } from './sources/types.ts'
import { SampleStore } from './store.ts'

// adsb.lol envelope, 7 aircraft incl. 000001 (dbFlags 8 = LADD) and ~a330e6 (TIS-B)
const BODY = readFileSync(new URL('../data/fixtures/golden/adsblol-point-ksfo.json', import.meta.url), 'utf8')
const T0 = 1_000_000
const LLBG = [32.0114, 34.8867] as const

function setup(hideFlagged: boolean, body = BODY) {
  const clock = { t: T0 }
  const answer = { body }
  const reply = (): Promise<FetchResult> => {
    const b = answer.body
    return Promise.resolve({ url: 'fake:circle', status: 200, tSendMs: clock.t - 40, tRecvMs: clock.t, bytes: b.length, body: b, retryAfterS: null, snapshot: normalizeAdsblol(b) })
  }
  const source: Source = {
    caps: { kind: 'adsblol', fullSnapshot: false, maxRps: 1, coverage: null, attribution: 'test' },
    circle: reply,
    hexes: reply,
    all: () => Promise.reject(new Error('unsupported')),
  }
  const store = new SampleStore()
  const info = new InfoStore({ nowMs: () => clock.t })
  const poller = new Poller(source, store, new TokenBucket(100, () => clock.t, () => 0), {
    cellPeriodMs: 3000,
    chasePeriodMs: 1000,
    fullSnapshotPeriodMs: 1000,
    interestTtlMs: 600_000,
    chaseTtlMs: 10_000,
    recorder: null,
    hideFlagged,
    nowMs: () => clock.t,
    info,
  })
  poller.touchView(LLBG[0], LLBG[1], 5) // one cell
  return { clock, answer, store, info, poller }
}

test('every non-hidden aircraft goes to the InfoStore with rxMs = the answer receive time', async () => {
  const s = setup(true)
  s.clock.t = T0 + 250
  assert.equal(await s.poller.tick(), true)
  assert.equal(s.info.size, 6)
  assert.equal(s.info.get('000001'), null, 'LADD stays hidden')
  assert.equal(s.info.get('~a330e6')?.hex, '~a330e6')
  assert.equal(s.info.get('a1c7e4')?.callsign, 'UAL872')
  assert.equal(s.info.raw('a1c7e4')?.t, 'B77W')
  assert.equal(s.info.rxMs('a1c7e4'), T0 + 250)

  const shown = setup(false)
  await shown.poller.tick()
  assert.equal(shown.info.size, 7)
  assert.equal(shown.info.get('000001')?.hex, '000001')
})

test('an aircraft without a position still gets its info (the table can show it once a position arrives)', async () => {
  const body = JSON.stringify({ now: 1_790_000_000_000, ac: [{ hex: 'abc123', type: 'adsb_icao', flight: 'ELY1  ', t: 'B738', squawk: '1000', seen: 0.5, messages: 12, mlat: [], tisb: [], rssi: -20 }] })
  const s = setup(true, body)
  await s.poller.tick()
  assert.equal(s.store.size, 0)
  assert.equal(s.info.get('abc123')?.callsign, 'ELY1')
})

test('the InfoStore is pruned on each good answer with the sample horizon', async () => {
  assert.equal(INFO_HORIZON_MS, 180_000)
  const s = setup(true)
  await s.poller.tick()
  assert.equal(s.info.size, 6)
  s.answer.body = JSON.stringify({ now: 1_790_000_000_000, ac: [] })
  s.clock.t = T0 + INFO_HORIZON_MS
  await s.poller.tick()
  assert.equal(s.info.size, 6, 'exactly at the horizon is kept')
  s.clock.t += 3000
  await s.poller.tick()
  assert.equal(s.info.size, 0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/poller.info.test.ts`
Expected: FAIL — `SyntaxError: The requested module './poller.ts' does not provide an export named 'INFO_HORIZON_MS'`

- [ ] **Step 3: Write the implementation** (the whole file; changes: the `InfoStore` import, `PollerOpts.info`, `INFO_HORIZON_MS`, and three lines in `#ingest`)

File: `server/poller.ts`
```ts
// server/poller.ts
import type { CellStatus, StatusBrief, StatusReport } from '../shared/api.ts'
import { MinOffset } from '../shared/clock.ts'
import { isHidden, toSample } from '../shared/sample.ts'
import type { TokenBucket } from './budget.ts'
import { cellsForView, type Cell } from './cells.ts'
import type { InfoStore } from './infoStore.ts'
import type { Recorder } from './recorder.ts'
import type { FetchResult, Source } from './sources/types.ts'
import type { SampleStore } from './store.ts'

export interface PollerOpts {
  cellPeriodMs: number
  chasePeriodMs: number
  fullSnapshotPeriodMs: number
  interestTtlMs: number
  chaseTtlMs: number
  recorder: Recorder | null
  hideFlagged: boolean
  nowMs?: () => number
  info?: InfoStore // gets every non-hidden aircraft object of every good answer (identity, detail panel, routes)
}

/**
 * Suggested timing (WP-A1 may override). At adsb.lol's 1 req/s a 1.4 s chase uses 0.71 req/s and the view's cells
 * share the other 0.29 (one cell ≈ 4 s, three ≈ 11 s); a 1 s chase would starve them. The client's delay floor is
 * 3 s (WP-C3), so 1.4 s costs the chase nothing.
 */
export const POLLER_DEFAULTS = {
  cellPeriodMs: 3000,
  chasePeriodMs: 1400,
  fullSnapshotPeriodMs: 1000,
  interestTtlMs: 15_000,
  chaseTtlMs: 10_000,
} as const

const TICK_MS = 100
const MAX_HEXES = 100 // adsb.lol /v2/hex batch limit used by server/sources/adsblol.ts
const OFFSET_WINDOW_MS = 10 * 60_000
const HOUR_MS = 3_600_000
const MIN_SPAN_MS = 60_000 // bytes/hour is extrapolated from at least one minute
const KEEP_INTERVALS = 100 // p95 over the most recent intervals
/** The InfoStore forgets an aircraft after this long without an answer: the SampleStore's default horizon. */
export const INFO_HORIZON_MS = 180_000

/** p95 (nearest rank) of intervals in ms, as seconds; null when there are none. */
function p95S(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.ceil(0.95 * sorted.length) - 1] / 1000
}

/** Intervals between successive good (200 + parsed) answers for one thing we poll. */
class OkIntervals {
  lastOkMs: number | null = null
  intervals: number[] = []

  ok(t: number): void {
    if (this.lastOkMs !== null) {
      this.intervals.push(t - this.lastOkMs)
      if (this.intervals.length > KEEP_INTERVALS) this.intervals.shift()
    }
    this.lastOkMs = t
  }
}

interface CellState {
  cell: Cell
  expiresMs: number
  lastReqMs: number
  ok: OkIntervals
}

/**
 * Decides what to ask the upstream next and feeds the answers into the store.
 * Full-snapshot sources (readsb, replay): one all() per fullSnapshotPeriodMs serves every view and chase.
 * Area sources (adsb.lol): the batched chase first (every chasePeriodMs), else the most overdue cell that someone
 * viewed within interestTtlMs (every cellPeriodMs). Every request needs a bucket token first.
 */
export class Poller {
  #source: Source
  #store: SampleStore
  #bucket: TokenBucket
  #opts: PollerOpts
  #now: () => number
  #startMs: number
  #offset = new MinOffset(OFFSET_WINDOW_MS)
  #cells = new Map<string, CellState>()
  #chased = new Map<string, number>() // hex → expiresMs
  #lastChaseReqMs = -Infinity
  #lastAllReqMs = -Infinity
  #chaseOk = new OkIntervals()
  #snapOk = new OkIntervals()
  #bytes: { t: number; n: number }[] = [] // last hour of responses
  #requestsTotal = 0
  #busy = false
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(source: Source, store: SampleStore, bucket: TokenBucket, opts: PollerOpts) {
    this.#source = source
    this.#store = store
    this.#bucket = bucket
    this.#opts = opts
    this.#now = opts.nowMs ?? Date.now
    this.#startMs = this.#now()
  }

  /** Keeps the cells covering this view polled for interestTtlMs. Full-snapshot sources need no cells: []. */
  touchView(lat: number, lon: number, radiusNm: number): Cell[] {
    if (this.#source.caps.fullSnapshot) return []
    const expiresMs = this.#now() + this.#opts.interestTtlMs
    const cells = cellsForView(lat, lon, radiusNm)
    for (const cell of cells) {
      const c = this.#cells.get(cell.id)
      if (c) c.expiresMs = Math.max(c.expiresMs, expiresMs)
      else this.#cells.set(cell.id, { cell, expiresMs, lastReqMs: -Infinity, ok: new OkIntervals() })
    }
    return cells
  }

  /** Keeps this hex in the chase batch for chaseTtlMs. */
  touchChase(hex: string): void {
    this.#chased.set(hex.toLowerCase(), this.#now() + this.#opts.chaseTtlMs)
  }

  /** At most one upstream request. Returns whether one was made. Overlapping calls return false at once. */
  async tick(): Promise<boolean> {
    if (this.#busy) return false
    this.#busy = true
    try {
      const now = this.#now()
      this.#expire(now)
      this.#store.prune(now)
      if (this.#source.caps.fullSnapshot) {
        if (now - this.#lastAllReqMs < this.#opts.fullSnapshotPeriodMs || !this.#bucket.tryTake()) return false
        this.#lastAllReqMs = now
        if (this.#ingest(await this.#source.all())) {
          const t = this.#now()
          this.#snapOk.ok(t)
          if (this.#chased.size > 0) this.#chaseOk.ok(t)
        }
        return true
      }
      if (this.#chased.size > 0 && now - this.#lastChaseReqMs >= this.#opts.chasePeriodMs) {
        if (!this.#bucket.tryTake()) return false // a due chase never yields its token to a cell
        this.#lastChaseReqMs = now
        if (this.#ingest(await this.#source.hexes(this.#batch()))) this.#chaseOk.ok(this.#now())
        return true
      }
      const c = this.#mostOverdue(now)
      // While chasing, a cell takes a token only if one is left for the next chase: the chase never waits for a cell.
      if (!c || (this.#chased.size > 0 && this.#bucket.state().tokens < 2) || !this.#bucket.tryTake()) return false
      c.lastReqMs = now
      if (this.#ingest(await this.#source.circle(c.cell.lat, c.cell.lon, c.cell.radiusNm))) c.ok.ok(this.#now())
      return true
    } finally {
      this.#busy = false
    }
  }

  start(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => {
      this.tick().catch((e: unknown) => console.error('poller: tick failed:', e))
    }, TICK_MS)
    this.#timer.unref() // the HTTP server keeps the process alive, not the poller
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  brief(): StatusBrief {
    this.#expire(this.#now())
    const cellIntervals = this.#source.caps.fullSnapshot ? this.#snapOk.intervals : [...this.#cells.values()].flatMap((c) => c.ok.intervals)
    return {
      source: this.#source.caps.kind,
      degraded: this.#bucket.degraded,
      cellPeriodP95S: p95S(cellIntervals),
      chasePeriodP95S: p95S(this.#chaseOk.intervals),
    }
  }

  report(): StatusReport {
    const now = this.#now()
    const brief = this.brief() // also drops expired cells and chases
    const cells: CellStatus[] = [...this.#cells.values()].map(({ cell: { id, lat, lon, radiusNm }, ok }) => ({
      id,
      lat,
      lon,
      radiusNm,
      lastOkMs: ok.lastOkMs,
      periodP95S: p95S(ok.intervals),
    }))
    this.#pruneBytes(now)
    let bytes = 0
    for (const b of this.#bytes) bytes += b.n
    const spanMs = Math.min(HOUR_MS, Math.max(MIN_SPAN_MS, now - this.#startMs))
    return {
      ...brief,
      budget: this.#bucket.state(),
      cells,
      chasedHexes: [...this.#chased.keys()],
      bytesPerHourEstimate: Math.round((bytes * HOUR_MS) / spanMs),
      requestsTotal: this.#requestsTotal,
    }
  }

  /** Budget, recorder, clock offset, stores. Returns whether the answer was good (200 and parsed). */
  #ingest(r: FetchResult): boolean {
    const now = this.#now()
    this.#bucket.onResult(r.status, r.retryAfterS)
    this.#requestsTotal++
    this.#bytes.push({ t: now, n: r.bytes })
    this.#pruneBytes(now)
    try {
      this.#opts.recorder?.write(this.#source.caps.kind, r)
    } catch (e) {
      console.error('poller: recorder write failed:', e) // ponytail: a full disk logs once per request; polling goes on
    }
    const snap = r.snapshot
    if (r.status !== 200 || snap === null) return false
    this.#offset.update(r.tRecvMs, snap.nowMs)
    const offsetMs = this.#offset.get()
    const info = this.#opts.info
    for (const ac of snap.aircraft) {
      if (this.#opts.hideFlagged && isHidden(ac)) continue
      info?.update(ac, r.tRecvMs)
      const s = toSample(ac, snap.nowMs, offsetMs, r.tRecvMs)
      if (s) this.#store.add(s)
    }
    info?.prune(now, INFO_HORIZON_MS) // on good answers only: its route-cache sweep need not run every 100 ms tick
    return true
  }

  #expire(now: number): void {
    for (const [id, c] of this.#cells) if (c.expiresMs <= now) this.#cells.delete(id)
    for (const [hex, exp] of this.#chased) if (exp <= now) this.#chased.delete(hex)
    if (this.#chased.size === 0) this.#chaseOk.lastOkMs = null // a new chase must not count the idle gap
  }

  /** The ≤ 100 most recently touched chased hexes. ponytail: more than 100 concurrent chases starve the rest. */
  #batch(): string[] {
    return [...this.#chased]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_HEXES)
      .map(([hex]) => hex)
  }

  /** The due cell whose last request is oldest (never-polled first, then registration order); null if none is due. */
  #mostOverdue(now: number): CellState | null {
    let best: CellState | null = null
    for (const c of this.#cells.values()) {
      if (now - c.lastReqMs < this.#opts.cellPeriodMs) continue
      if (best === null || c.lastReqMs < best.lastReqMs) best = c
    }
    return best
  }

  #pruneBytes(now: number): void {
    while (this.#bytes.length > 0 && this.#bytes[0].t <= now - HOUR_MS) this.#bytes.shift()
  }
}
```

- [ ] **Step 4: Run the new and the existing poller tests**

Run: `node --test server/poller.info.test.ts server/poller.test.ts`
Expected: PASS — `ℹ tests 19`, `ℹ pass 19`, `ℹ fail 0` (3 new + 16 existing).

- [ ] **Step 5: Commit**

```bash
git add server/poller.ts server/poller.info.test.ts
git commit -m "feat(server): poller feeds every non-hidden aircraft to the InfoStore"
```

---

### Task 4: RouteFetcher

**Files:**
- Create: `server/routes.ts`, `server/routes.test.ts`
- Test: `server/routes.test.ts`

**Interfaces:**
- Consumes: `TokenBucket` (`tryTake`, `onResult(status, retryAfterS)`, WP-S3), `InfoStore` (`needRoutes`, `setRoute`; Task 2), `RouteInfo` (`shared/info.ts`, WP-B0), `parseRetryAfter` (`server/sources/http.ts`, WP-S1)
- Produces (PLAN.md §5.3, exactly): `class RouteFetcher { constructor(opts: { bucket: TokenBucket; userAgent: string; nowMs?: () => number; fetchFn?: typeof fetch; minIntervalMs?: number }); tick(store: InfoStore): Promise<boolean> }`. Extras: `parseRouteset(body: unknown): RouteInfo[] | null`, `ROUTESET_URL = 'https://api.adsb.lol/api/0/routeset'`, `MAX_PLANES = 100`

- [ ] **Step 1: Write the failing test** (a fake `fetch` and a fake clock; nothing touches the network)

```ts
// server/routes.test.ts
// RouteFetcher against a fake fetch on a fake clock. Nothing here touches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadsbAircraft } from '../shared/types.ts'
import { TokenBucket } from './budget.ts'
import { InfoStore } from './infoStore.ts'
import { MAX_PLANES, parseRouteset, ROUTESET_URL, RouteFetcher } from './routes.ts'

const T0 = 2_000_000_000_000
const UA = 'FlightHopper/0.1 (+me@example.invalid)'

/** One routeset item shaped like adsb.lol's (api_routes.py api_routeset → provider.py _route; orjson, sorted keys). */
function known(callsign: string, icao: string, iata: string, plausible = true) {
  const airports = icao.split('-').map((code, i) => ({ icao: code, iata: iata.split('-')[i], name: `${code} airport`, location: 'Somewhere', countryiso2: 'XX', lat: 44 + i, lon: 26 + i, alt_feet: 300, alt_meters: 91.44 }))
  return { _airport_codes_iata: iata, _airports: airports, airline_code: callsign.slice(0, 3), airport_codes: icao, callsign, number: callsign.slice(3), plausible }
}
const unknown = (callsign: string) => ({ _airports: [], airport_codes: 'unknown', callsign })

test('parseRouteset: ICAO airport_codes first, IATA as a fallback; unknown and malformed items are skipped', () => {
  const body = [
    known('ROT1234', 'LROP-OTHH', 'OTP-DOH'),
    known('QTR5', 'OTHH-EGLL-KJFK', 'DOH-LHR-JFK'),
    known('ELY27', 'LLBG-KJFK', 'TLV-JFK', false),
    unknown('UAL1'),
    { callsign: 'DAL45', _airport_codes_iata: 'ATL-LAX', _airports: [] }, // no ICAO field: IATA is used
    { callsign: 'AAL9', airport_codes: 'KJFK', _airports: [] }, // one airport is not a route
    { callsign: 'SWA1', airport_codes: 'KDAL-<script>' }, // not airport codes
    { callsign: 'BAW1', airport_codes: 'egll-kjfk' }, // lower case is normalised
    { callsign: 'KLM1', airport_codes: 'EHAM-KJFK', plausible: 0 }, // only false is implausible
    { airport_codes: 'EHAM-KJFK' },
    { callsign: '  ', airport_codes: 'EHAM-KJFK' },
    null,
    42,
    'EHAM-KJFK',
  ]
  assert.deepEqual(parseRouteset(body), [
    { callsign: 'ROT1234', route: 'LROP-OTHH', plausible: true },
    { callsign: 'QTR5', route: 'OTHH-EGLL-KJFK', plausible: true },
    { callsign: 'ELY27', route: 'LLBG-KJFK', plausible: false },
    { callsign: 'DAL45', route: 'ATL-LAX', plausible: true },
    { callsign: 'BAW1', route: 'EGLL-KJFK', plausible: true },
    { callsign: 'KLM1', route: 'EHAM-KJFK', plausible: true },
  ])
  assert.equal(parseRouteset({ planes: [] }), null, 'not an array: not a routeset answer')
  assert.equal(parseRouteset(null), null)
  assert.deepEqual(parseRouteset([]), [])
})

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: { planes: { callsign: string; lat: number; lng: number }[] }
}

type Reply = { status: number; body?: string; headers?: Record<string, string> } | 'network-error'

function setup(maxRps = 100) {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const calls: Call[] = []
  const replies: Reply[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) })
    const r = replies.shift() ?? { status: 200, body: '[]' }
    if (r === 'network-error') throw new TypeError('fetch failed')
    return new Response(r.body ?? '', { status: r.status, headers: r.headers })
  }) as typeof fetch
  const bucket = new TokenBucket(maxRps, nowMs, () => 0)
  const store = new InfoStore({ nowMs })
  const fetcher = new RouteFetcher({ bucket, userAgent: UA, nowMs, fetchFn })
  return { clock, calls, replies, bucket, store, fetcher }
}

const plane = (hex: string, flight: string, lat = 44.5712, lon = 26.0851): ReadsbAircraft => ({ hex, flight: `${flight}  `, lat, lon, seen_pos: 1 })

test('tick: one POST to /api/0/routeset with the callsigns that need a route; routes fill the store, the rest are misses', async () => {
  const s = setup()
  s.store.update(plane('4a8123', 'ROT1234', 44.571234, 26.085149), T0)
  s.store.update(plane('06a1e7', 'QTR5'), T0)
  s.store.update(plane('738065', 'ELY27'), T0)
  s.store.update(plane('a1c7e4', 'UAL1'), T0)
  s.store.update(plane('4b1805', 'HBJZA'), T0) // not an airline callsign: never asked
  s.replies.push({ status: 200, body: JSON.stringify([known('ROT1234', 'LROP-OTHH', 'OTP-DOH'), known('QTR5', 'OTHH-EGLL', 'DOH-LHR'), known('ELY27', 'LLBG-KJFK', 'TLV-JFK', false), unknown('UAL1')]) })

  assert.equal(await s.fetcher.tick(s.store), true)
  assert.equal(s.calls.length, 1)
  const c = s.calls[0]
  assert.equal(c.url, ROUTESET_URL)
  assert.equal(ROUTESET_URL, 'https://api.adsb.lol/api/0/routeset')
  assert.equal(c.method, 'POST')
  assert.equal(c.headers['Content-Type'], 'application/json')
  assert.equal(c.headers['User-Agent'], UA)
  assert.deepEqual(c.body, {
    planes: [
      { callsign: 'ROT1234', lat: 44.571, lng: 26.085 },
      { callsign: 'QTR5', lat: 44.571, lng: 26.085 },
      { callsign: 'ELY27', lat: 44.571, lng: 26.085 },
      { callsign: 'UAL1', lat: 44.571, lng: 26.085 },
    ],
  })
  assert.equal(s.store.get('4a8123')?.route, 'LROP-OTHH')
  assert.equal(s.store.get('06a1e7')?.route, 'OTHH-EGLL')
  assert.equal(s.store.get('738065')?.route, null, 'an implausible route is not shown')
  assert.equal(s.store.get('a1c7e4')?.route, null)
  assert.deepEqual(s.store.needRoutes(10), [], 'misses are cached too')
  assert.equal(s.bucket.state().counts.ok, 1)
})

test('at most one request per minIntervalMs (default 60 s), ≤ 100 callsigns each; nothing to ask → no request', async () => {
  const s = setup()
  assert.equal(await s.fetcher.tick(s.store), false, 'empty store')
  assert.equal(s.calls.length, 0)
  assert.equal(s.bucket.state().tokens, 2, 'no token spent')

  for (let i = 0; i < 150; i++) s.store.update(plane(i.toString(16).padStart(6, '0'), `DAL${i + 1}`), T0)
  assert.equal(await s.fetcher.tick(s.store), true)
  assert.equal(s.calls[0].body.planes.length, MAX_PLANES)
  assert.equal(MAX_PLANES, 100)
  s.clock.t = T0 + 59_999
  assert.equal(await s.fetcher.tick(s.store), false)
  s.clock.t = T0 + 60_000
  assert.equal(await s.fetcher.tick(s.store), true)
  assert.deepEqual(s.calls.map((c) => c.body.planes.length), [100, 50])
  assert.equal(s.calls[1].body.planes[0].callsign, 'DAL101')
  s.clock.t = T0 + 120_000
  assert.equal(await s.fetcher.tick(s.store), false, 'all answered (as misses)')

  const t = setup()
  const quick = new RouteFetcher({ bucket: t.bucket, userAgent: UA, nowMs: () => t.clock.t, fetchFn: (async () => new Response('[]')) as typeof fetch, minIntervalMs: 5000 })
  t.store.update(plane('000001', 'DAL1'), T0)
  assert.equal(await quick.tick(t.store), true)
  t.store.update(plane('000002', 'DAL2'), T0)
  t.clock.t = T0 + 4999
  assert.equal(await quick.tick(t.store), false)
  t.clock.t = T0 + 5000
  assert.equal(await quick.tick(t.store), true)
})

test('shares the budget: no token → no request; the answer goes to bucket.onResult (429 pauses, Retry-After honoured)', async () => {
  const s = setup(1)
  s.store.update(plane('4a8123', 'ROT1234'), T0)
  assert.ok(s.bucket.tryTake() && s.bucket.tryTake(), 'the poller took both tokens')
  assert.equal(await s.fetcher.tick(s.store), false)
  assert.equal(s.calls.length, 0)

  s.clock.t = T0 + 1000
  s.replies.push({ status: 429, headers: { 'retry-after': '30' } })
  assert.equal(await s.fetcher.tick(s.store), true)
  const st = s.bucket.state()
  assert.equal(st.counts.r429, 1)
  assert.equal(st.pausedUntilMs, T0 + 31_000)
  assert.equal(s.bucket.degraded, 'rate-limited')
  assert.deepEqual(s.store.needRoutes(10).map((p) => p.callsign), ['ROT1234'], 'a refused request caches nothing')

  s.clock.t = T0 + 61_000
  s.replies.push({ status: 403 })
  assert.equal(await s.fetcher.tick(s.store), true)
  assert.equal(s.bucket.degraded, 'blocked', 'a block stops the whole adsb.lol source')
  s.clock.t = T0 + 200_000
  assert.equal(await s.fetcher.tick(s.store), false)
  assert.equal(s.calls.length, 2)
})

test('network errors, 5xx and non-routeset bodies cache nothing and count against the bucket', async () => {
  const s = setup()
  s.store.update(plane('4a8123', 'ROT1234'), T0)
  s.replies.push('network-error')
  assert.equal(await s.fetcher.tick(s.store), true)
  assert.equal(s.bucket.state().counts.err, 1)

  s.clock.t += 120_000
  s.replies.push({ status: 503, body: 'busy' })
  assert.equal(await s.fetcher.tick(s.store), true)
  assert.equal(s.bucket.state().counts.r5xx, 1)

  for (const body of ['<html>proxy error</html>', '{"planes":[]}']) {
    s.clock.t += 120_000
    s.replies.push({ status: 200, body })
    assert.equal(await s.fetcher.tick(s.store), true)
  }
  assert.equal(s.calls.length, 4)
  assert.deepEqual(s.store.needRoutes(10).map((p) => p.callsign), ['ROT1234'])
})

test('overlapping ticks: the second returns false at once', async () => {
  const s = setup()
  s.store.update(plane('4a8123', 'ROT1234'), T0)
  const first = s.fetcher.tick(s.store)
  s.clock.t += 120_000
  assert.equal(await s.fetcher.tick(s.store), false)
  assert.equal(await first, true)
  assert.equal(s.calls.length, 1)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/routes.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/routes.ts' imported from …/server/routes.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// server/routes.ts
// Flight routes (origin → destination airports) for the browse table and detail panel, from adsb.lol's batched routeset.
// Shape verified against github.com/adsblol/api @ 3c969c8 (2026-06-03): src/adsb_api/utils/api_routes.py `api_routeset`
// and provider.py `_route` (route data: vradarserver/standing-data):
//   POST /api/0/routeset  {"planes": [{"callsign", "lat", "lng"}]}   1..100 planes, else 400
//   200 → JSON array, one object per distinct callsign:
//     { callsign, airport_codes: "LROP-OTHH" | "unknown", _airport_codes_iata: "OTP-DOH", _airports: [{ icao, iata, … }],
//       plausible?: boolean, number?, airline_code? }
// Never called unless ADSB_SOURCE=adsblol and ROUTES=1 (server/main.ts); tests use a fake fetch.
import type { RouteInfo } from '../shared/info.ts'
import type { TokenBucket } from './budget.ts'
import type { InfoStore } from './infoStore.ts'
import { parseRetryAfter } from './sources/http.ts'

export const ROUTESET_URL = 'https://api.adsb.lol/api/0/routeset'
/** The upstream answers 400 above 100 planes. */
export const MAX_PLANES = 100
const DEFAULT_MIN_INTERVAL_MS = 60_000
const TIMEOUT_MS = 10_000
const AIRPORT = /^[A-Z0-9]{3,4}$/

/** "LROP-OTHH" → itself (upper-cased); "unknown", one airport or anything that is not airport codes → null. */
function airportCodes(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const codes = v.trim().toUpperCase().split('-')
  return codes.length >= 2 && codes.every((c) => AIRPORT.test(c)) ? codes.join('-') : null
}

/**
 * A routeset answer → one RouteInfo per item with known airports: ICAO `airport_codes` first, then a hypothetical
 * `_airport_codes`, then `_airport_codes_iata`. Only `plausible: false` marks a route implausible. Malformed items
 * are skipped. null when the body is not an array (not a routeset answer at all).
 */
export function parseRouteset(body: unknown): RouteInfo[] | null {
  if (!Array.isArray(body)) return null
  const out: RouteInfo[] = []
  for (const item of body) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const callsign = typeof o.callsign === 'string' ? o.callsign.trim() : ''
    const route = airportCodes(o.airport_codes) ?? airportCodes(o._airport_codes) ?? airportCodes(o._airport_codes_iata)
    if (callsign === '' || route === null) continue
    out.push({ callsign, route, plausible: o.plausible !== false })
  }
  return out
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000

/**
 * Asks adsb.lol for the routes of the callsigns the InfoStore lacks: one POST of ≤ 100 callsigns at most every
 * minIntervalMs, only with a token from the poller's bucket, and every answer reported back to that bucket.
 * A route is cached 6 h and a miss (unknown or implausible) 1 h, in the InfoStore. A failed request caches nothing.
 */
export class RouteFetcher {
  #bucket: TokenBucket
  #userAgent: string
  #now: () => number
  #fetch: typeof fetch
  #minIntervalMs: number
  #lastReqMs = -Infinity
  #busy = false

  constructor(opts: { bucket: TokenBucket; userAgent: string; nowMs?: () => number; fetchFn?: typeof fetch; minIntervalMs?: number }) {
    this.#bucket = opts.bucket
    this.#userAgent = opts.userAgent
    this.#now = opts.nowMs ?? Date.now
    this.#fetch = opts.fetchFn ?? ((input, init) => fetch(input, init))
    this.#minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  }

  /** At most one request. Returns whether one was sent. Overlapping calls return false at once. */
  async tick(store: InfoStore): Promise<boolean> {
    if (this.#busy || this.#now() - this.#lastReqMs < this.#minIntervalMs) return false
    const planes = store.needRoutes(MAX_PLANES)
    if (planes.length === 0 || !this.#bucket.tryTake()) return false
    this.#busy = true
    this.#lastReqMs = this.#now()
    try {
      const r = await this.#post(planes.map((p) => ({ callsign: p.callsign, lat: round3(p.lat), lng: round3(p.lon) })))
      this.#bucket.onResult(r.status, r.retryAfterS)
      const routes = r.status === 200 ? parseRouteset(r.body) : null
      if (routes === null) return true
      const found = new Map<string, string>()
      for (const x of routes) if (x.plausible) found.set(x.callsign, x.route)
      // ponytail: an implausible route (flown on another leg today) counts as a miss; retried after an hour.
      for (const p of planes) store.setRoute(p.callsign, found.get(p.callsign) ?? null)
      return true
    } finally {
      this.#busy = false
    }
  }

  /** One POST that never throws: a network error or timeout comes back as status 0. */
  async #post(planes: { callsign: string; lat: number; lng: number }[]): Promise<{ status: number; retryAfterS: number | null; body: unknown }> {
    try {
      const res = await this.#fetch(ROUTESET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': this.#userAgent },
        body: JSON.stringify({ planes }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const text = await res.text()
      let body: unknown = null
      try {
        body = JSON.parse(text)
      } catch {
        // a 200 that is not JSON (a proxy error page): no routes, nothing cached
      }
      return { status: res.status, retryAfterS: parseRetryAfter(res.headers.get('retry-after'), res.headers.get('date'), this.#now()), body }
    } catch {
      return { status: 0, retryAfterS: null, body: null }
    }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/routes.test.ts`
Expected: PASS — `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "feat(server): RouteFetcher — batched adsb.lol routeset within the poller budget"
```

---

### Task 5: Serve info, raw, gzip and routes

**Files:**
- Modify: `server/main.ts`
- Create: `server/main.browse.test.ts`
- Test: `server/main.browse.test.ts`, `server/main.test.ts` (unchanged, must stay green: Node's `fetch` asks for gzip and inflates it)

**Interfaces:**
- Consumes: Tasks 1–4; `ViewResponse.info?`, `ChaseResponse.raw?` / `info?` (`shared/api.ts`, WP-B0); `userAgent(contact)` (`server/sources/index.ts`, WP-S1); `distanceNm` (`shared/geo.ts`)
- Produces: `/api/view` `info` (the rule under Architecture); `/api/chase` `raw` (aged to `serverNowMs`) + `info`; gzip for JSON over 1 KB; the route timer (`ADSB_SOURCE=adsblol` and `ROUTES=1` only); `createServer(cfg, deps?: { source?; nowMs?; routesFetch?: typeof fetch })` → `{ listen; close; poller; info: InfoStore }`

- [ ] **Step 1: Write the failing test**

```ts
// server/main.browse.test.ts
// The browse additions to the server: `info` on /api/view, `raw` + `info` on /api/chase, gzip, the route timer, and
// the 5,000-aircraft view budget. The real server on port 0 with an in-memory source; no network beyond 127.0.0.1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { gunzipSync } from 'node:zlib'
import type { ChaseResponse, ViewResponse } from '../shared/api.ts'
import { destination } from '../shared/geo.ts'
import type { ReadsbAircraft } from '../shared/types.ts'
import { readServerConfig } from './config.ts'
import { createServer } from './main.ts'
import { ROUTESET_URL } from './routes.ts'
import type { FetchResult, Source } from './sources/types.ts'

const FILE = new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url).pathname
const CENTER = { lat: 32.0114, lon: 34.8867 } // LLBG
const T0 = 2_000_000_000_000

/** An in-memory upstream on an injected clock: every answer is `aircraft` as it is now, received at clock.t. */
function fakeSource(clock: { t: number }, kind: 'readsb' | 'adsblol') {
  const state = { aircraft: [] as ReadsbAircraft[], calls: 0 }
  const answer = (): Promise<FetchResult> => {
    state.calls++
    const snapshot = { nowMs: clock.t, aircraft: state.aircraft }
    return Promise.resolve({ url: `fake:${kind}`, status: 200, tSendMs: clock.t, tRecvMs: clock.t, bytes: 1000, body: '', retryAfterS: null, snapshot })
  }
  const full = kind === 'readsb'
  const source: Source = {
    caps: { kind, fullSnapshot: full, maxRps: 5, coverage: null, attribution: 'test' },
    circle: () => (full ? Promise.reject(new Error('unsupported')) : answer()),
    hexes: () => (full ? Promise.reject(new Error('unsupported')) : answer()),
    all: () => (full ? answer() : Promise.reject(new Error('unsupported'))),
  }
  return { source, state }
}

/** An airborne aircraft `nm` from the centre on bearing `brg`, with the detail fields a real adsb.lol object carries. */
function plane(hex: string, flight: string, brg: number, nm: number, extra: Partial<ReadsbAircraft> = {}): ReadsbAircraft {
  const p = destination(CENTER.lat, CENTER.lon, brg, nm)
  return {
    hex, type: 'adsb_icao', flight: `${flight}  `, r: '4X-EKA', t: 'B738', alt_baro: 24_000, alt_geom: 24_650, gs: 420.3, track: 271.4,
    baro_rate: -832, squawk: '4521', emergency: 'none', category: 'A3', nav_qnh: 1013.2, nav_altitude_mcp: 20_000, nav_heading: 270,
    lat: p.lat, lon: p.lon, nic: 8, rc: 186, seen_pos: 0.4, version: 2, nic_baro: 1, nac_p: 10, nac_v: 2, sil: 3, sil_type: 'perhour',
    gva: 2, sda: 2, alert: 0, spi: 0, mlat: [], tisb: [], messages: 21_345, seen: 0.2, rssi: -18.2, wd: 285, ws: 42, oat: -21, tat: 3,
    ...extra,
  } as ReadsbAircraft
}

async function start(env: Record<string, string>, kind: 'readsb' | 'adsblol', deps: { routesFetch?: typeof fetch } = {}) {
  const clock = { t: T0 }
  const fake = fakeSource(clock, kind)
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, ...env }), staticDir: join(mkdtempSync(join(tmpdir(), 'fh-browse-')), 'dist') }
  const app = createServer(cfg, { source: fake.source, nowMs: () => clock.t, ...deps })
  const base = await app.listen(0)
  return { clock, fake, app, base }
}

async function waitFor(what: string, ok: () => boolean, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

/** Moves the clock one poll on and waits until the poller has fetched it. */
async function nextPoll(s: Awaited<ReturnType<typeof start>>, aircraft: ReadsbAircraft[], stepMs = 1000): Promise<void> {
  s.fake.state.aircraft = aircraft
  const n = s.fake.state.calls
  s.clock.t += stepMs
  await waitFor('the next poll', () => s.fake.state.calls > n)
  await sleep(5) // let the ingest finish (it follows the fetch's promise)
}

const viewUrl = (base: string, since: number, nm = 50): string => `${base}/api/view?lat=${CENTER.lat}&lon=${CENTER.lon}&nm=${nm}&since=${since}`
const getJson = async <T>(url: string): Promise<T> => (await fetch(url)).json() as Promise<T>
const infoHexes = (v: ViewResponse): string[] => (v.info ?? []).map((i) => i.hex).sort()
const newest = (v: ViewResponse, since: number): number => v.samples.reduce((m, s) => Math.max(m, s.rxMs), since)

test('view: info for every aircraft on the first poll; later only for aircraft new to the circle, silent ≥ 60 s, or changed', async (t) => {
  const s = await start({}, 'readsb')
  t.after(() => s.app.close())
  const a = (nm: number, x = {}) => plane('aaa001', 'ELY1', 0, nm, x)
  const b = (nm: number, x = {}) => plane('aaa002', 'ELY2', 90, nm, x)
  const c = (nm: number, x = {}) => plane('aaa003', 'ELY3', 180, nm, x) // starts outside the 50 nm view
  const d = (nm: number, x = {}) => plane('aaa004', 'ELY4', 270, nm, x)

  s.fake.state.aircraft = [a(10), b(10), c(60), d(10)]
  await waitFor('the first poll', () => s.fake.state.calls > 0)
  await sleep(5)
  const v1 = await getJson<ViewResponse>(viewUrl(s.base, 0))
  assert.deepEqual(v1.samples.map((x) => x.hex).sort(), ['aaa001', 'aaa002', 'aaa004'])
  assert.deepEqual(infoHexes(v1), ['aaa001', 'aaa002', 'aaa004'])
  assert.deepEqual(v1.info?.find((i) => i.hex === 'aaa001'), {
    hex: 'aaa001', callsign: 'ELY1', reg: '4X-EKA', typeCode: 'B738', category: 'A3', squawk: '4521', emergency: null, military: false, route: null,
  })
  let since = newest(v1, 0)

  // a moves; b squawks 7700; c flies into the view; d is not in this answer.
  await nextPoll(s, [a(11), b(11, { squawk: '7700' }), c(40)])
  const v2 = await getJson<ViewResponse>(viewUrl(s.base, since))
  assert.deepEqual(v2.samples.map((x) => x.hex).sort(), ['aaa001', 'aaa002', 'aaa003'])
  assert.deepEqual(infoHexes(v2), ['aaa002', 'aaa003'])
  assert.equal(v2.info?.find((i) => i.hex === 'aaa002')?.squawk, '7700')
  since = newest(v2, since)

  // Nothing changes: no info.
  await nextPoll(s, [a(12), b(12, { squawk: '7700' }), c(39)])
  const v3 = await getJson<ViewResponse>(viewUrl(s.base, since))
  assert.equal(v3.samples.length, 3)
  assert.deepEqual(v3.info, [])
  since = newest(v3, since)

  // A route arrives between two samples of a (in the same millisecond as a's last answer): it goes out with a's next sample.
  s.app.info.setRoute('ELY1', 'LLBG-EGLL')
  await nextPoll(s, [a(13), b(13, { squawk: '7700' }), c(38)])
  const v4 = await getJson<ViewResponse>(viewUrl(s.base, since))
  assert.deepEqual(v4.info?.map((i) => [i.hex, i.route]), [['aaa001', 'LLBG-EGLL']])
  since = newest(v4, since)

  // Polls 35 s apart are no reason to resend; d comes back after 74 s of silence: the client may have dropped it.
  await nextPoll(s, [a(14), b(14, { squawk: '7700' }), c(37)], 35_000)
  const v5 = await getJson<ViewResponse>(viewUrl(s.base, since))
  assert.deepEqual(v5.info, [])
  since = newest(v5, since)
  await nextPoll(s, [a(15), b(15, { squawk: '7700' }), c(36), d(11)], 35_000)
  const v6 = await getJson<ViewResponse>(viewUrl(s.base, since))
  assert.deepEqual(v6.samples.map((x) => x.hex).sort(), ['aaa001', 'aaa002', 'aaa003', 'aaa004'])
  assert.deepEqual(infoHexes(v6), ['aaa004'])
})

test('chase: raw is the newest full object with seen / seen_pos counted to serverNowMs; info rides along', async (t) => {
  const s = await start({}, 'readsb')
  t.after(() => s.app.close())
  s.fake.state.aircraft = [plane('aaa001', 'ELY1', 0, 10)]
  await waitFor('the first poll', () => s.fake.state.calls > 0)
  await sleep(5)
  s.clock.t += 500 // half a poll period later: no new answer yet
  const c = await getJson<ChaseResponse>(`${s.base}/api/chase?hex=AAA001&since=0`)
  assert.equal(c.serverNowMs, T0 + 500)
  assert.equal(c.samples.length, 1)
  assert.equal(c.info?.callsign, 'ELY1')
  const raw = c.raw!
  assert.equal(raw.hex, 'aaa001')
  assert.equal(raw.nav_altitude_mcp, 20_000)
  assert.equal(raw.ws, 42)
  assert.equal(raw.seen, 0.7)
  assert.equal(raw.seen_pos, 0.9)

  const none = await getJson<ChaseResponse>(`${s.base}/api/chase?hex=abcdef&since=0`)
  assert.equal(none.raw, null)
  assert.equal(none.info, null)
  assert.deepEqual(none.samples, [])
})

/** GET with explicit headers and the body left compressed (fetch would inflate it). */
function rawGet(url: string, headers: Record<string, string>): Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    request(url, { headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
    })
      .on('error', reject)
      .end()
  })
}

test('gzip: JSON over 1 KB is gzipped when Accept-Encoding allows it; small or unaccepted bodies are not', async (t) => {
  const s = await start({}, 'readsb')
  t.after(() => s.app.close())
  s.fake.state.aircraft = Array.from({ length: 30 }, (_, i) => plane(`aab${String(i).padStart(3, '0')}`, `ELY${i + 1}`, i * 12, 20))
  await waitFor('the first poll', () => s.fake.state.calls > 0)
  await sleep(5)
  const url = viewUrl(s.base, 0)

  const gz = await rawGet(url, { 'accept-encoding': 'gzip, deflate, br' })
  assert.equal(gz.headers['content-encoding'], 'gzip')
  assert.equal(gz.headers['content-type'], 'application/json')
  assert.equal(gz.headers.vary, 'accept-encoding')
  assert.equal(Number(gz.headers['content-length']), gz.body.length)
  const view = JSON.parse(gunzipSync(gz.body).toString('utf8')) as ViewResponse
  assert.equal(view.samples.length, 30)
  assert.equal(view.info?.length, 30)

  const plain = await rawGet(url, {})
  assert.equal(plain.headers['content-encoding'], undefined)
  assert.equal(Number(plain.headers['content-length']), plain.body.length)
  assert.ok(plain.body.length > 4 * gz.body.length, `${plain.body.length} B plain vs ${gz.body.length} B gzip`)
  assert.equal((JSON.parse(plain.body.toString('utf8')) as ViewResponse).samples.length, 30)

  for (const refuse of ['identity', 'gzip;q=0', 'br']) {
    assert.equal((await rawGet(url, { 'accept-encoding': refuse })).headers['content-encoding'], undefined, refuse)
  }
  assert.equal((await rawGet(url, { 'accept-encoding': 'GZIP;q=0.5' })).headers['content-encoding'], 'gzip')

  const small = await rawGet(`${s.base}/api/nope`, { 'accept-encoding': 'gzip' })
  assert.equal(small.headers['content-encoding'], undefined)
  assert.match(small.body.toString('utf8'), /no such endpoint/)
})

/** A fake routeset endpoint: records every request and answers each callsign with a fixed route. */
function fakeRoutes() {
  const calls: { url: string; planes: { callsign: string }[] }[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { planes } = JSON.parse(String(init?.body)) as { planes: { callsign: string }[] }
    calls.push({ url: String(input), planes })
    const body = planes.map((p) => ({ callsign: p.callsign, airport_codes: 'LLBG-EGLL', _airport_codes_iata: 'TLV-LHR', _airports: [], plausible: true }))
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { calls, fn }
}

test('routes: fetched only with ADSB_SOURCE=adsblol and ROUTES=1, through the poller budget, and served in info', async (t) => {
  const routes = fakeRoutes()
  const env = { ADSB_SOURCE: 'adsblol', CONTACT: 'me@example.invalid', ROUTES: '1', MAX_RPS: '0.02' }
  const s = await start(env, 'adsblol', { routesFetch: routes.fn })
  t.after(() => s.app.close())
  s.fake.state.aircraft = [plane('aaa001', 'ELY1', 0, 10), plane('aaa002', 'N123AB', 90, 10)]
  const v0 = await getJson<ViewResponse>(viewUrl(s.base, 0)) // touches the view's two cells
  assert.deepEqual(v0.samples, [])
  await waitFor('the route answer', () => s.app.info.get('aaa001')?.route != null)
  assert.equal(routes.calls[0].url, ROUTESET_URL)
  assert.deepEqual(routes.calls[0].planes.map((p) => p.callsign), ['ELY1'])
  const v1 = await getJson<ViewResponse>(viewUrl(s.base, 0))
  assert.equal(v1.info?.find((i) => i.hex === 'aaa001')?.route, 'LLBG-EGLL')
  assert.equal(v1.info?.find((i) => i.hex === 'aaa002')?.route, null)
  // The static clock gives only the bucket's two burst tokens: the first cell took one and the route request the other.
  assert.equal(s.fake.state.calls, 1)
  assert.equal(s.app.poller.report().budget.counts.ok, 2, 'the route request used a poller token')

  // A race for one token: 60 s later (1.2 tokens at 0.02 req/s) a new callsign needs a route and both cells are due.
  // The route timer fires first, so the route request wins; the cells wait for the next token.
  s.app.info.update(plane('aaa003', 'ELY3', 180, 10), s.clock.t)
  s.clock.t += 60_000
  s.app.poller.touchView(CENTER.lat, CENTER.lon, 50)
  await waitFor('the second route answer', () => s.app.info.get('aaa003')?.route != null)
  await sleep(300)
  assert.equal(routes.calls.length, 2)
  assert.deepEqual(routes.calls[1].planes.map((p) => p.callsign), ['ELY3'])
  assert.equal(s.fake.state.calls, 1, 'no cell got the token')

  for (const [label, e, kind] of [
    ['ROUTES unset', { ADSB_SOURCE: 'adsblol', CONTACT: 'me@example.invalid' }, 'adsblol'],
    ['ROUTES=0', { ADSB_SOURCE: 'adsblol', CONTACT: 'me@example.invalid', ROUTES: '0' }, 'adsblol'],
    ['readsb', { ADSB_SOURCE: 'readsb', READSB_COVERAGE: '32,34.9,200', ROUTES: '1' }, 'readsb'],
    ['replay', { ROUTES: '1' }, 'readsb'],
  ] as const) {
    const never = fakeRoutes()
    const o = await start(e, kind, { routesFetch: never.fn })
    o.fake.state.aircraft = [plane('aaa001', 'ELY1', 0, 10)]
    await getJson<ViewResponse>(viewUrl(o.base, 0))
    await waitFor('a poll', () => o.fake.state.calls > 0)
    await sleep(300)
    await o.app.close()
    assert.equal(never.calls.length, 0, label)
  }
})

test('budget: /api/view of a 250 nm circle with 5,000 aircraft answers in ≤ 50 ms (server side, gzip)', async (t) => {
  const s = await start({}, 'readsb')
  t.after(() => s.app.close())
  const fleet = (step: number): ReadsbAircraft[] =>
    Array.from({ length: 5000 }, (_, i) => plane(`b${i.toString(16).padStart(5, '0')}`, `ELY${i}`, (i * 137.5) % 360, 5 + ((i * 7.3 + step) % 240)))
  s.fake.state.aircraft = fleet(0)
  await waitFor('the first poll', () => s.fake.state.calls > 0, 20_000)
  for (let step = 1; step <= 10; step++) await nextPoll(s, fleet(step)) // 11 samples per aircraft in the store
  const since = s.clock.t - 1000 // a client one poll behind: every aircraft has one new sample

  /** Request → last byte, as the server sends it (gzip); the client's gunzip and JSON parse are not timed. */
  const timed = async (url: string): Promise<{ ms: number; body: ViewResponse; bytes: number }> => {
    const t0 = performance.now()
    const r = await rawGet(url, { 'accept-encoding': 'gzip' })
    const ms = performance.now() - t0
    assert.equal(r.headers['content-encoding'], 'gzip')
    return { ms, body: JSON.parse(gunzipSync(r.body).toString('utf8')) as ViewResponse, bytes: r.body.length }
  }
  const median = (xs: number[]): number => xs.sort((x, y) => x - y)[xs.length >> 1]
  const first: number[] = []
  const next: number[] = []
  let bytes = [0, 0]
  for (let i = 0; i < 5; i++) {
    const a = await timed(viewUrl(s.base, 0, 250))
    assert.equal(a.body.samples.length, 5000)
    assert.equal(a.body.info?.length, 5000)
    first.push(a.ms)
    const b = await timed(viewUrl(s.base, since, 250))
    assert.equal(b.body.samples.length, 5000)
    assert.deepEqual(b.body.info, [])
    next.push(b.ms)
    bytes = [a.bytes, b.bytes]
  }
  t.diagnostic(`5,000 aircraft, 250 nm: since=0 median ${median(first).toFixed(1)} ms (${bytes[0]} B gzip); since=last median ${median(next).toFixed(1)} ms (${bytes[1]} B gzip)`)
  assert.ok(median(first) <= 50, `since=0 median ${median(first).toFixed(1)} ms`)
  assert.ok(median(next) <= 50, `since>0 median ${median(next).toFixed(1)} ms`)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/main.browse.test.ts`
Expected: FAIL — `ℹ tests 5`, `ℹ pass 0`, `ℹ fail 5` (no `info` on the view, no `raw` on the chase, no `content-encoding: gzip`, `s.app.info` is undefined).

- [ ] **Step 3: Write the implementation** (the whole file)

File: `server/main.ts`
```ts
// server/main.ts
// The FlightHopper server: one Source → Poller → SampleStore + InfoStore, served as plain HTTP polling, plus the built client.
//   npm run server                      (settings: .env.local, see .env.example)
//   GET /api/view?lat&lon&nm&since      samples in a circle received after `since` (server-clock rxMs), + the info the client lacks
//   GET /api/chase?hex&since            one aircraft's samples received after `since`, + its newest full object and info
//   GET /api/status                     the poller's StatusReport
//   GET /*                              dist/ (index.html for client routes)
// JSON over 1 KB is gzipped when the client accepts it. ADSB_SOURCE=adsblol with ROUTES=1 also looks up flight routes.
import { readFile, stat } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { ChaseResponse, ViewResponse } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import type { AircraftInfo } from '../shared/info.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { TokenBucket } from './budget.ts'
import { readServerConfig, type ServerConfig } from './config.ts'
import { InfoStore } from './infoStore.ts'
import { POLLER_DEFAULTS, Poller } from './poller.ts'
import { Recorder } from './recorder.ts'
import { RouteFetcher } from './routes.ts'
import { makeSource, userAgent } from './sources/index.ts'
import type { Source } from './sources/types.ts'
import { SampleStore } from './store.ts'

// ponytail: loopback only. Cloudflare Tunnel and the Vite dev proxy both connect locally, but other machines on the
// LAN cannot. Add a HOST variable when one needs to.
const HOST = '127.0.0.1'
// ponytail: an area source (adsb.lol) polls the cells of at most a 250 nm view; a wider view still gets whatever the
// store holds. Full-snapshot sources have no cells, so the cap costs them nothing.
const MAX_POLLED_NM = 250
const HEX = /^~?[0-9a-f]{6}$/
const GZIP_MIN_BYTES = 1024
// Fastest level: a 5,000-aircraft view (2.7 MB of JSON) → ~430 KB in ~10 ms; level 6 saves 20 % more bytes for 2.4× the time.
const GZIP_LEVEL = 1
// An aircraft silent this long may have been dropped by the client (its Fleet prunes old entries): send its info again.
const INFO_RESEND_GAP_MS = 60_000
const ROUTE_TICK_MS = 100 // RouteFetcher.tick itself keeps ≥ 60 s between requests
const gzipAsync = promisify(gzip)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

class BadRequest extends Error {}

/** A finite number from the query string; `def` when missing or empty, else 400. */
function num(q: URLSearchParams, name: string, def?: number): number {
  const raw = q.get(name)?.trim() ?? ''
  if (raw === '' && def !== undefined) return def
  const v = raw === '' ? NaN : Number(raw)
  if (!Number.isFinite(v)) throw new BadRequest(`${name} must be a number, got "${raw}"`)
  return v
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new BadRequest(message)
}

/** Whether Accept-Encoding lists gzip with a non-zero q. ponytail: `*` is not read as gzip. */
function acceptsGzip(header: string | undefined): boolean {
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.split(';').map((x) => x.trim().toLowerCase())
    if (name !== 'gzip') continue
    const q = params.find((p) => p.startsWith('q='))
    return q === undefined || Number(q.slice(2)) > 0
  }
  return false
}

/** JSON, gzipped off the event loop (zlib's thread pool) when it is over 1 KB and the client accepts gzip. */
async function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): Promise<void> {
  const text = JSON.stringify(body)
  const bytes = Buffer.byteLength(text)
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'accept-encoding' }
  if (bytes > GZIP_MIN_BYTES && acceptsGzip(req.headers['accept-encoding'])) {
    const gz = await gzipAsync(text, { level: GZIP_LEVEL })
    res.writeHead(status, { ...headers, 'content-encoding': 'gzip', 'content-length': gz.length }).end(gz)
    return
  }
  res.writeHead(status, { ...headers, 'content-length': bytes }).end(text)
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) }).end(text)
}

const isFile = (p: string): Promise<boolean> => stat(p).then((s) => s.isFile(), () => false)

/**
 * A file under root: the path itself, index.html for client routes (no extension), else 404.
 * Anything that decodes to a path outside root (%2e%2e, %2f, %5c, NUL) is a 404 before the disk is touched.
 * ponytail: no caching headers, ETags or compression. Every page load re-sends Cesium's assets; put the Cloudflare
 * cache in front, or add `cache-control: immutable` for Vite's hashed /assets/, when that matters.
 */
async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    return sendText(res, 404, 'not found\n')
  }
  const abs = resolve(root, `.${path}`)
  if (path.includes('\0') || (abs !== root && !abs.startsWith(root + sep))) return sendText(res, 404, 'not found\n')
  let file = abs
  if (!(await isFile(file))) {
    if (extname(path) !== '') return sendText(res, 404, 'not found\n')
    file = join(root, 'index.html')
    if (!(await isFile(file))) return sendText(res, 404, 'the client is not built: run npm run build\n')
  }
  const body = await readFile(file)
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': body.length }).end(body)
}

/**
 * Wires one Source (cfg, or deps.source) to a Poller, a SampleStore, an InfoStore and an HTTP server.
 * deps.nowMs is the server clock for the poller and the budget; it must be the clock the source stamps tRecvMs with
 * (Date.now for live sources, the same injected clock for a replay built with it).
 * deps.routesFetch replaces fetch for the route lookups (tests); routes run only with ADSB_SOURCE=adsblol and ROUTES=1.
 */
export function createServer(
  cfg: ServerConfig,
  deps: { source?: Source; nowMs?: () => number; routesFetch?: typeof fetch } = {},
): { listen(port: number): Promise<string>; close(): Promise<void>; poller: Poller; info: InfoStore } {
  const nowMs = deps.nowMs ?? Date.now
  const source = deps.source ?? makeSource(cfg)
  const store = new SampleStore()
  const info = new InfoStore({ nowMs })
  const bucket = new TokenBucket(Math.min(cfg.maxRps, source.caps.maxRps), nowMs)
  const recorder = cfg.recordDir !== null && source.caps.kind !== 'replay' ? new Recorder(cfg.recordDir) : null
  // The poller prunes the sample store (180 s horizon) on every 100 ms tick and the info store on every good answer,
  // so no separate prune timer is needed.
  const poller = new Poller(source, store, bucket, { ...POLLER_DEFAULTS, recorder, hideFlagged: !cfg.showPiaLadd, nowMs, info })
  const routes =
    cfg.routes && cfg.source === 'adsblol' && cfg.contact !== null
      ? new RouteFetcher({ bucket, userAgent: userAgent(cfg.contact), nowMs, fetchFn: deps.routesFetch })
      : null
  let routeTimer: ReturnType<typeof setInterval> | null = null
  const root = resolve(cfg.staticDir)

  /**
   * The AircraftInfo this client lacks for the aircraft in a view answer. since = 0: all of them. Otherwise an
   * aircraft's info goes out when it is new to the client (no stored sample at or before `since` inside the circle),
   * when it was silent for ≥ 60 s (the client may have dropped it), or when it changed after the client's last sample
   * of it. (Plain "changed after since" would lose aircraft that fly into a fixed view, and route answers that land
   * between two of an aircraft's samples.)
   */
  function viewInfo(samples: readonly Sample[], lat: number, lon: number, nm: number, since: number): AircraftInfo[] {
    const hexes = new Set<string>()
    for (const s of samples) hexes.add(s.hex)
    if (since <= 0) return info.since(hexes, 0)
    const out: AircraftInfo[] = []
    for (const hex of hexes) {
      const i = info.get(hex)
      const changedMs = info.changedMs(hex)
      if (i === null || changedMs === null) continue
      // Samples of the last gap before `since` are enough: an older previous sample means a gap ≥ 60 s anyway.
      const list = store.track(hex, since - INFO_RESEND_GAP_MS)
      let k = list.length - 1
      while (k >= 0 && list[k].rxMs > since) k--
      const prev = k >= 0 ? list[k] : null
      const lacks =
        prev === null || // new to the store, or silent for longer than the gap
        changedMs > prev.rxMs || // changed after the client's last sample of it
        list[k + 1].rxMs - prev.rxMs >= INFO_RESEND_GAP_MS || // silent: the client may have dropped it
        distanceNm(lat, lon, prev.lat, prev.lon) > nm // flew into the circle
      if (lacks) out.push(i)
    }
    return out
  }

  /** The newest full upstream object with its ages (seen, seen_pos) counted to `now` instead of to its receipt. */
  function rawAt(hex: string, now: number): ReadsbAircraft | null {
    const raw = info.raw(hex)
    const rxMs = info.rxMs(hex)
    if (raw === null || rxMs === null) return null
    const dtS = Math.max(0, now - rxMs) / 1000
    const age = (s: number | undefined): number | undefined => (s === undefined ? s : Math.round((s + dtS) * 1000) / 1000)
    return { ...raw, seen: age(raw.seen), seen_pos: age(raw.seen_pos) }
  }

  function view(q: URLSearchParams): ViewResponse {
    const lat = num(q, 'lat')
    const lon = num(q, 'lon')
    const nm = num(q, 'nm')
    const since = num(q, 'since', 0)
    check(Math.abs(lat) <= 90, 'lat must be in [-90, 90]')
    check(Math.abs(lon) <= 180, 'lon must be in [-180, 180]')
    check(nm > 0, 'nm must be > 0')
    check(since >= 0, 'since must be ≥ 0')
    poller.touchView(lat, lon, Math.min(nm, MAX_POLLED_NM))
    const samples = store.view(lat, lon, nm, since)
    return { serverNowMs: nowMs(), samples, status: poller.brief(), info: viewInfo(samples, lat, lon, nm, since) }
  }

  function chase(q: URLSearchParams): ChaseResponse {
    const hex = (q.get('hex') ?? '').trim().toLowerCase()
    const since = num(q, 'since', 0)
    check(HEX.test(hex), 'hex must be 6 hex digits (optionally prefixed with ~)')
    check(since >= 0, 'since must be ≥ 0')
    poller.touchChase(hex)
    const now = nowMs()
    return { serverNowMs: now, samples: store.track(hex, since), status: poller.brief(), raw: rawAt(hex, now), info: info.get(hex) }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/')
    if (req.method !== 'GET') {
      if (isApi) return sendJson(req, res, 405, { error: 'only GET' })
      return sendText(res, 405, 'only GET\n')
    }
    if (!isApi) return serveStatic(root, url.pathname, res)
    let status = 200
    let body: unknown
    try {
      if (url.pathname === '/api/view') body = view(url.searchParams)
      else if (url.pathname === '/api/chase') body = chase(url.searchParams)
      else if (url.pathname === '/api/status') body = poller.report()
      else [status, body] = [404, { error: `no such endpoint: ${url.pathname}` }]
    } catch (e) {
      if (!(e instanceof BadRequest)) throw e
      ;[status, body] = [400, { error: e.message }]
    }
    return sendJson(req, res, status, body)
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error('server: request failed:', e)
      if (res.headersSent) res.destroy()
      else void sendJson(req, res, 500, { error: 'internal error' }) // under 1 KB: never gzipped, cannot reject
    })
  })

  return {
    poller,
    info,
    listen(port: number): Promise<string> {
      return new Promise((done, fail) => {
        server.once('error', fail)
        server.listen(port, HOST, () => {
          server.off('error', fail)
          if (routes !== null && routeTimer === null) {
            // Armed just before the poller's 100 ms timer: Node keeps same-period timers in one list and re-arms them
            // in firing order, so this one keeps firing first. A due route request (≤ 1 a minute) then gets the next
            // token instead of losing every race to a cell poll, which at MAX_RPS 0.08 wants every token.
            routeTimer = setInterval(() => {
              routes.tick(info).catch((e: unknown) => console.error('routes: tick failed:', e))
            }, ROUTE_TICK_MS)
            routeTimer.unref()
          }
          poller.start()
          done(`http://${HOST}:${(server.address() as AddressInfo).port}`)
        })
      })
    },
    close(): Promise<void> {
      if (routeTimer !== null) clearInterval(routeTimer)
      routeTimer = null
      poller.stop()
      if (!server.listening) return Promise.resolve()
      return new Promise((done, fail) => {
        server.close((e) => (e ? fail(e) : done()))
        server.closeAllConnections() // keep-alive clients would otherwise hold close() open
      })
    },
  }
}

if (import.meta.main) {
  try {
    const cfg = readServerConfig(process.env)
    const url = await createServer(cfg).listen(cfg.port)
    const routes = cfg.routes && cfg.source === 'adsblol' ? ', routes on' : ''
    console.log(`FlightHopper server on ${url} (source ${cfg.source}${routes})`)
  } catch (e) {
    console.error(`server: ${(e as Error).message}`)
    process.exit(1)
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/main.browse.test.ts`
Expected: PASS — `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`, and a diagnostic line such as `ℹ 5,000 aircraft, 250 nm: since=0 median 12.4 ms (199671 B gzip); since=last median 18.5 ms (166305 B gzip)`. The budget is ≤ 50 ms for both. The times are server-side (request to last byte of the gzipped body over 127.0.0.1, without the client's gunzip and JSON parse).

- [ ] **Step 5: Run the existing server end-to-end tests**

Run: `node --test server/main.test.ts`
Expected: PASS — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add server/main.ts server/main.browse.test.ts
git commit -m "feat(server): view info, chase raw + info, gzip JSON, adsb.lol route timer"
```

---

### Task 6: WP gate

- [ ] **Step 1: This package's tests and the existing tests they touch**

Run: `node --test server/config.test.ts server/infoStore.test.ts server/poller.info.test.ts server/poller.test.ts server/routes.test.ts server/main.browse.test.ts server/main.test.ts`
Expected: `ℹ tests 54`, `ℹ pass 54`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'server/'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing. On the WP-B0 tree (the 27 WPs + V4 Task 4 + B0) plus this package: `ℹ tests 480`, `ℹ pass 480`, `ℹ fail 0` (460 + 20 new: 1 in `config.test.ts`, 5 InfoStore, 3 poller feed, 6 routes, 5 end-to-end).

- [ ] **Step 4: Check it by hand (optional, no adsb.lol traffic)**

Run, on a free port: `ADSB_SOURCE=replay REPLAY_FILES=data/fixtures/golden/recording-sample.jsonl PORT=8797 RECORD_DIR= node server/main.ts`, then in another shell:
- `curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' 'http://127.0.0.1:8797/api/view?lat=37.6188&lon=-122.3758&nm=40&since=0'` → `content-encoding: gzip`, `vary: accept-encoding`.
- `curl -s --compressed 'http://127.0.0.1:8797/api/chase?hex=a067ec&since=0'` → the JSON has `raw` (the full readsb object, `seen` counted to now) and `info` (`"callsign":"SKW5549"`).

Stop the server (Ctrl-C).

- [ ] **Step 5: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.
