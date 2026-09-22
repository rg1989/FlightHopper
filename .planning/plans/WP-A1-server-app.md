# WP-A1 — Server App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the server parts into the running server. It reads its settings from the environment, picks the upstream with one switch (`ADSB_SOURCE`), wires Source → Poller → SampleStore, and serves `/api/view`, `/api/chase`, `/api/status` and the built client over `node:http`. An end-to-end **flip test** proves that a client sees the same API from `replay` and from `readsb`, so the receiver switch is one setting.

**Architecture:** Three short files. `server/config.ts` reads and checks the environment into a `ServerConfig`; an invalid value throws an `Error` that names the variable. `server/sources/index.ts` is the switch: `makeSource(cfg)` calls `makeAdsblol`, `makeReadsb` or `makeReplay`. `server/main.ts` has `createServer(cfg, deps?)`. It builds one `TokenBucket(min(MAX_RPS, caps.maxRps))`, one `SampleStore`, a `Recorder` when `RECORD_DIR` is set (never for replay) and one `Poller` with `POLLER_DEFAULTS`. Its request handler has three GET endpoints: each touches the poller, reads the store and answers JSON. Every other GET path is served from `dist/`: `index.html` for client routes without a file extension, 404 for missing assets and for any path that decodes to a place outside `dist/`. `listen(port)` binds 127.0.0.1 and starts the poller; `close()` stops both. The CLI (`if (import.meta.main)`) is `readServerConfig(process.env)` → `listen(cfg.port)`, and a config error exits 1 with its message. The tests run the real server on port 0. Replay runs on an injected clock, and the same assertions then run against `ADSB_SOURCE=readsb` pointed at `tools/fake-readsb.ts`, which serves the same recording.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:http`, `node:fs` `globSync`, `node:test`. No new dependencies. Consumes WP-00, WP-S1 (`makeAdsblol`, `makeReadsb`), WP-S2 (`makeReplay`, `Recorder`, `startFakeReadsb`), WP-S3 (`TokenBucket`), WP-S4 (`SampleStore`) and WP-I1 (`Poller`, `POLLER_DEFAULTS`).

**Wave:** 3 (needs I1, S1 and S2 merged; S3 and S4 come in with I1). **Estimated:** 1.5 h. **Validated:** on 2026-09-22 in the shared sandbox (Node v25.2.1, TypeScript 7.0.2), which holds WP-00 and the merged-state code of S1–S4 and I1. Each test file was written first and failed with `ERR_MODULE_NOT_FOUND`. With the implementation, `node --test server/config.test.ts server/sources/index.test.ts server/main.test.ts` gave 23/23 pass (config 11, sources/index 5, main 7) in ≈ 4 s; the flip test waits ≈ 3 s of real time for the fake receiver. `tsc --noEmit` reported nothing for these files. A snapshot copy of the whole sandbox gave 447/447 tests with `tsc` silent. Ten deliberate mutations each made at least one test fail: no traversal guard, `Date.now` for `serverNowMs`, privacy inverted, chase or view ignoring `since`, recording replay, SPA fallback for missing assets, a broken readsb switch, no `MAX_RPS` clamp, and a bucket that ignores `MAX_RPS`. By hand: `node server/main.ts` on the golden recording answered `/api/view` (31 aircraft within 3 nm of KSFO), `/api/chase`, `/api/status` and a 400 to `curl`. Against a real `vite build` it served `index.html`, the app bundle, Cesium's Workers, Widgets and Assets, the Draco `.wasm` and the `.glb` model with the right content types. Every code block in this plan was then extracted and compared byte for byte with the tested files.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. The ones that matter most for this package:
- **Upstream politeness:** adsb.lol runs at ≤ 1 req/s (`MAX_RPS` is clamped), with `User-Agent: FlightHopper/0.1 (+${CONTACT})`; `CONTACT` is required for `adsblol`. All budget behaviour (429, 403, backoff) lives in `TokenBucket` and `Poller`; this package only sizes the bucket.
- **Time:** `serverNowMs` and every `Sample.rxMs`/`tMs` are server clock. `deps.nowMs` must be the clock the source stamps `tRecvMs` with: `Date.now` for live sources (`timedFetch` uses it), or the same injected clock for a replay built with it.
- **Privacy:** PIA/LADD aircraft are dropped unless `SHOW_PIA_LADD=1` (`hideFlagged: !cfg.showPiaLadd`).
- **Tests never touch the network:** replay and the fake receiver run on 127.0.0.1. The one adsb.lol test mocks `fetch` and first proves the mock is installed. The CLI test for `adsblol` exits on the missing `CONTACT` before a source exists.
- Erasable TypeScript only, `.ts` import extensions, `if (import.meta.main)` for the CLI.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `server/config.ts` | `ServerConfig`, `readServerConfig(env)` |
| `server/config.test.ts` | defaults, `REPLAY_FILES` globs, per-source requirements, invalid values |
| `server/sources/index.ts` | `makeSource(cfg)` (the `ADSB_SOURCE` switch), `userAgent(contact)` |
| `server/sources/index.test.ts` | each source kind; adsb.lol User-Agent through a mocked `fetch` |
| `server/main.ts` | `createServer(cfg, deps?)`: wiring, API routes, static `dist/`, CLI |
| `server/main.test.ts` | end-to-end: replay on an injected clock, **flip test** (readsb → fake receiver), privacy, static files and traversal, CLI |

**Settings** (`readServerConfig`; `.env.example` from WP-00 lists them):

| Variable | Default | Rule |
|---|---|---|
| `ADSB_SOURCE` | `replay` | `adsblol` \| `readsb` \| `replay` |
| `CONTACT` | none | required for `adsblol`; goes into `User-Agent: FlightHopper/0.1 (+CONTACT)` |
| `MAX_RPS` | `1` | number > 0; clamped to ≤ 1 for `adsblol`. The bucket runs at `min(MAX_RPS, caps.maxRps)` |
| `READSB_URL` | `http://127.0.0.1:8042` | http(s) URL; checked only for `readsb` |
| `READSB_COVERAGE` | none | `"lat,lon,nm"`, required for `readsb` (the `Source.caps.coverage` circle) |
| `REPLAY_FILES` | `data/fixtures/*.jsonl` | comma-separated paths and globs, expanded with `globSync` (each pattern sorted, duplicates dropped); no match is an error. Only for `replay` |
| `REPLAY_SPEED` | `1` | number > 0 |
| `RECORD_DIR` | none | unset or empty = no recording. A `replay` source is never recorded |
| `PORT` | `8787` | integer 0..65535 (0 = any free port) |
| `SHOW_PIA_LADD` | `0` | `0` or `1` |

Values are trimmed, and unset means the same as empty. `staticDir` is always `dist` (relative to the working directory, like the other paths; `npm run server` runs from the repository root).

**Routes** (`createServer`):

| Request | Checks (else 400 `{ "error": … }`) | Does | Answers |
|---|---|---|---|
| `GET /api/view?lat&lon&nm&since` | lat ∈ [−90, 90], lon ∈ [−180, 180], nm > 0, since ≥ 0 (default 0) | `poller.touchView(lat, lon, min(nm, 250))`, then `store.view(lat, lon, nm, since)` | `ViewResponse` |
| `GET /api/chase?hex&since` | hex `~?` + 6 hex digits, any case (lower-cased); since ≥ 0 (default 0) | `poller.touchChase(hex)`, then `store.track(hex, since)` | `ChaseResponse` |
| `GET /api/status` | none | `poller.report()` | `StatusReport` |
| any other `/api/…` | none | none | 404 JSON |
| any other GET | none | the file under `dist/`; a missing path without an extension gets `dist/index.html`; a missing asset, or a path that decodes outside `dist/` (`%2e%2e`, `%2f`, `%5c`, NUL, bad escapes), gets 404 | the file, typed from a 16-entry extension map (else `application/octet-stream`) |
| not GET | none | none | 405 |

JSON answers carry `content-type: application/json` and `cache-control: no-store`; `serverNowMs` is `nowMs()` when the answer is built, and `status` is `poller.brief()`.

**Decisions a reviewer should know about:**
- **No separate prune timer.** `Poller.tick()` already calls `store.prune(now)` on every 100 ms tick, so a 10 s timer would be a second copy of the same call.
- **Loopback only** (`127.0.0.1`). Cloudflare Tunnel and the Vite dev proxy (`/api` → `http://127.0.0.1:8787`, WP-00 `vite.config.ts`) both connect locally. Other LAN machines cannot. That is marked `ponytail:` in the code; the upgrade is a `HOST` variable.
- **Replay does not loop** (`makeReplay({ files, speed })`, as specified). About 60 s after the recording ends, views are empty; restart the server to replay again. `makeReplay` already has a `loop` option if that becomes annoying.
- **View radius is capped at 250 nm for polling only**: an area source (adsb.lol) never registers the cells of a continent-sized view, but the store still answers the full radius.

---

### Task 1: Server settings

**Files:**
- Create: `server/config.ts`, `server/config.test.ts`
- Test: `server/config.test.ts`

**Interfaces:**
- Consumes: `SourceKind` from `shared/types.ts` (WP-00); `globSync` from `node:fs`.
- Produces: `interface ServerConfig { source: SourceKind; contact: string | null; maxRps: number; readsbUrl: string; readsbCoverage: { lat: number; lon: number; radiusNm: number } | null; replayFiles: string[]; replaySpeed: number; recordDir: string | null; port: number; showPiaLadd: boolean; staticDir: string }` and `readServerConfig(env: Record<string, string | undefined>): ServerConfig` (PLAN.md §4 A1). It throws `Error` with the variable's name, the rule and the bad value, for example `CONTACT is required for ADSB_SOURCE=adsblol: …`, `READSB_COVERAGE must be "lat,lon,nm" …`, `REPLAY_FILES matched no files: data/fixtures/*.jsonl`.

- [ ] **Step 1: Write the failing test**

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
  ]
  for (const [env, re] of cases) assert.throws(() => readServerConfig({ REPLAY_FILES: FILE, ...env }), re, JSON.stringify(env))
})

test('accepts process.env as it is', () => {
  const cfg = readServerConfig({ ...process.env, ADSB_SOURCE: 'replay', REPLAY_FILES: FILE, PORT: '0', MAX_RPS: '', REPLAY_SPEED: '', SHOW_PIA_LADD: '' })
  assert.equal(cfg.source, 'replay')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/config.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/config.ts' imported from …/server/config.test.ts`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

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

  const show = str(env, 'SHOW_PIA_LADD')
  if (show !== '' && show !== '0' && show !== '1') throw new Error(`SHOW_PIA_LADD must be 0 or 1, got "${show}"`)

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
    showPiaLadd: show === '1',
    staticDir: 'dist',
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/config.test.ts`
Expected: PASS — `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/config.ts server/config.test.ts
git commit -m "feat(server): read and check server settings from the environment" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Source switch

**Files:**
- Create: `server/sources/index.ts`, `server/sources/index.test.ts`
- Test: `server/sources/index.test.ts`

**Interfaces:**
- Consumes: `ServerConfig`, `readServerConfig` (Task 1); `makeAdsblol(opts: { userAgent: string; baseUrl?: string; timeoutMs?: number }): Source` and `makeReadsb(opts: { baseUrl: string; coverage: { lat; lon; radiusNm }; timeoutMs?: number }): Source` (WP-S1); `makeReplay(opts: { files: string[]; speed?: number; loop?: boolean; nowMs?: () => number }): Source` (WP-S2); `Source` (`server/sources/types.ts`, WP-00).
- Produces: `makeSource(cfg: ServerConfig): Source` (PLAN.md §4 A1): `'adsblol'` → `makeAdsblol({ userAgent: userAgent(cfg.contact) })`, `'readsb'` → `makeReadsb({ baseUrl: cfg.readsbUrl, coverage: cfg.readsbCoverage })`, `'replay'` → `makeReplay({ files: cfg.replayFiles, speed: cfg.replaySpeed })`. A hand-built config without `contact` (adsblol) or `readsbCoverage` (readsb) throws. Extra export: `userAgent(contact: string): string` = `FlightHopper/0.1 (+${contact})`, the same string `tools/record-cells.ts` and `tools/record-arrivals.ts` send.

- [ ] **Step 1: Write the failing test**

```ts
// server/sources/index.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readServerConfig } from '../config.ts'
import { makeSource, userAgent } from './index.ts'

const FILE = fileURLToPath(new URL('../../data/fixtures/golden/recording-sample.jsonl', import.meta.url))

test('replay: the recording as a full-snapshot source', async () => {
  const src = makeSource(readServerConfig({ REPLAY_FILES: FILE, REPLAY_SPEED: '2' }))
  assert.equal(src.caps.kind, 'replay')
  assert.equal(src.caps.fullSnapshot, true)
  const r = await src.all()
  assert.equal(r.status, 200)
  assert.ok(r.snapshot!.aircraft.length > 30)
})

test('readsb: receiver URL and coverage come from the config (nothing is fetched here)', () => {
  const src = makeSource(readServerConfig({ ADSB_SOURCE: 'readsb', READSB_URL: 'http://127.0.0.1:1', READSB_COVERAGE: '32.01,34.88,200' }))
  assert.equal(src.caps.kind, 'readsb')
  assert.equal(src.caps.fullSnapshot, true)
  assert.deepEqual(src.caps.coverage, { lat: 32.01, lon: 34.88, radiusNm: 200 })
})

test('adsblol: area source at ≤ 1 req/s whose User-Agent carries CONTACT (fetch is mocked: nothing leaves the machine)', async (t) => {
  const src = makeSource(readServerConfig({ ADSB_SOURCE: 'adsblol', CONTACT: 'me@example.invalid' }))
  assert.equal(src.caps.kind, 'adsblol')
  assert.equal(src.caps.fullSnapshot, false)
  assert.equal(src.caps.maxRps, 1)
  const seen: { url: string; ua: string | null }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), ua: new Headers(init?.headers).get('user-agent') })
    return new Response(JSON.stringify({ ac: [], now: 1_790_081_710_501 }), { status: 200 })
  })
  // Prove the mock is in place before the source is called: if it were not, this probe goes nowhere (port 1).
  await fetch('http://127.0.0.1:1/probe')
  assert.equal(seen.length, 1, 'fetch mock not installed; refusing to call the adsb.lol source')
  seen.length = 0
  const r = await src.circle(37.6188, -122.3758, 40)
  assert.equal(r.status, 200)
  assert.deepEqual(r.snapshot, { nowMs: 1_790_081_710_501, aircraft: [] })
  assert.deepEqual(seen, [{ url: 'https://api.adsb.lol/v2/point/37.6188/-122.3758/40', ua: 'FlightHopper/0.1 (+me@example.invalid)' }])
})

test('userAgent: FlightHopper/0.1 (+contact)', () => {
  assert.equal(userAgent('https://example.invalid/me'), 'FlightHopper/0.1 (+https://example.invalid/me)')
})

test('a hand-built config that lacks what its source needs throws', () => {
  const cfg = readServerConfig({ REPLAY_FILES: FILE })
  assert.throws(() => makeSource({ ...cfg, source: 'adsblol', contact: null }), /adsblol needs a contact/)
  assert.throws(() => makeSource({ ...cfg, source: 'readsb', readsbCoverage: null }), /readsb needs a coverage circle/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/sources/index.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/sources/index.ts' imported from …/server/sources/index.test.ts`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// server/sources/index.ts
// The receiver switch: ADSB_SOURCE picks one upstream. Everything after this point is source-agnostic.
import type { ServerConfig } from '../config.ts'
import { makeAdsblol } from './adsblol.ts'
import { makeReadsb } from './readsb.ts'
import { makeReplay } from './replay.ts'
import type { Source } from './types.ts'

/** The User-Agent adsb.lol asks for: who we are and how to reach the operator. */
export function userAgent(contact: string): string {
  return `FlightHopper/0.1 (+${contact})`
}

export function makeSource(cfg: ServerConfig): Source {
  switch (cfg.source) {
    case 'adsblol':
      if (cfg.contact === null) throw new Error('makeSource: adsblol needs a contact for its User-Agent (CONTACT)')
      return makeAdsblol({ userAgent: userAgent(cfg.contact) })
    case 'readsb':
      if (cfg.readsbCoverage === null) throw new Error('makeSource: readsb needs a coverage circle (READSB_COVERAGE)')
      return makeReadsb({ baseUrl: cfg.readsbUrl, coverage: cfg.readsbCoverage })
    case 'replay':
      return makeReplay({ files: cfg.replayFiles, speed: cfg.replaySpeed })
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/sources/index.test.ts`
Expected: PASS — `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`. The adsb.lol test mocks the global `fetch` with `t.mock.method` and checks the mock with a probe to `127.0.0.1:1` before it calls the source. If the mock were missing, the probe fails the test before anything is sent to adsb.lol.

- [ ] **Step 5: Commit**

```bash
git add server/sources/index.ts server/sources/index.test.ts
git commit -m "feat(server): ADSB_SOURCE switch between adsb.lol, readsb and replay" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: HTTP server, static client and the flip test

**Files:**
- Create: `server/main.ts`, `server/main.test.ts`
- Test: `server/main.test.ts`

**Interfaces:**
- Consumes:
  - `readServerConfig`, `ServerConfig` (Task 1); `makeSource` (Task 2).
  - `Poller`, `POLLER_DEFAULTS` from `server/poller.ts` (WP-I1): `new Poller(source, store, bucket, { ...POLLER_DEFAULTS, recorder, hideFlagged, nowMs })`, `touchView(lat, lon, radiusNm)`, `touchChase(hex)`, `start()`, `stop()`, `brief()`, `report()`.
  - `TokenBucket` from `server/budget.ts` (WP-S3): `new TokenBucket(maxRps, nowMs)`.
  - `SampleStore` from `server/store.ts` (WP-S4): `view(lat, lon, radiusNm, sinceRxMs)`, `track(hex, sinceRxMs)`.
  - `Recorder` from `server/recorder.ts` (WP-S2): `new Recorder(dir)`.
  - Tests only: `makeReplay` (WP-S2, with an injected `nowMs`), `startFakeReadsb({ files, port: 0 })` from `tools/fake-readsb.ts` (WP-S2), `readRecording` (`server/recording.ts`, WP-00), `distanceNm` (`shared/geo.ts`, WP-00).
  - `ViewResponse`, `ChaseResponse`, `StatusReport` from `shared/api.ts` (WP-00); `Source` from `server/sources/types.ts` (WP-00).
- Produces (PLAN.md §4 A1): `createServer(cfg: ServerConfig, deps?: { source?: Source; nowMs?: () => number }): { listen(port: number): Promise<string>; close(): Promise<void>; poller: Poller }`. `listen` resolves `http://127.0.0.1:<port>` and starts the poller; `close` stops the poller and the server (keep-alive connections included) and resolves even when the server never listened. The routes are in the table above. CLI: `node server/main.ts` (`npm run server`) prints `FlightHopper server on http://127.0.0.1:8787 (source replay)`; a config or listen error prints `server: <message>` and exits 1. Consumed by WP-A2 (the client polls these routes through WP-V7's `ApiClient`), by `tools/gate-g1.ts` (WP-S3 reads `/api/status`) and by Gates G1 and G3.

**What the end-to-end tests check** (`assertApi` runs unchanged for both sources; that is the flip test):

| Step | Assertion |
|---|---|
| first view, `since=0` | 200, `application/json`, `status.source` is the source kind, one sample per hex, all within the 10 nm circle, LADD `000002` absent, `serverNowMs − 60 s < tMs ≤ serverNowMs`, `rxMs ≤ serverNowMs` |
| `advance()`, view with `since` = newest `rxMs` | every sample has `rxMs > since`; a hex seen before now has a later `tMs`; the chased `a067ec` moved |
| chase `A067EC`, `since=0` | ≥ 2 samples, all `a067ec`, `tMs` strictly increasing; again with `since` = last `rxMs` → `[]` |
| `/api/status` | exactly the `StatusReport` keys; `cells: []` (full snapshot); `chasedHexes: ['a067ec']`; `budget.maxRps` 1; not blocked; ≥ 2 requests; bytes/hour > 0; `cellPeriodP95S` a number |
| bad parameters | 11 URLs → 400 JSON with `error` |

The replay run uses an injected clock at `T0 = 2e12` ms, which is far from the recording's clock (1.79e12), and `advance()` adds 2.5 s. It then checks `serverNowMs === T0 + 2500`, that the chase's `rxMs` values are exactly `[T0, T0 + 2500]`, that `RECORD_DIR` stays uncreated, and that `/` is a 404 naming `npm run build` when there is no `dist/`. The readsb run builds its source through `makeSource(cfg)` on the real clock (what `npm run server` does). Its `advance()` does nothing, because the fake receiver reaches the recording's second poll 2.5 s after it starts. It then checks that `RECORD_DIR` holds `readsb` lines fetched from the fake's URL.

- [ ] **Step 1: Write the failing test**

```ts
// server/main.test.ts
// End-to-end: the real server on port 0 against a recording. No network beyond 127.0.0.1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { ChaseResponse, StatusReport, ViewResponse } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import type { SourceKind } from '../shared/types.ts'
import { startFakeReadsb } from '../tools/fake-readsb.ts'
import { readServerConfig } from './config.ts'
import { createServer } from './main.ts'
import { readRecording } from './recording.ts'
import { makeReplay } from './sources/replay.ts'

const FILE = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))
const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
const KSFO = { lat: 37.6188, lon: -122.3758 }
const CHASED = 'a067ec' // airborne ADS-B v2 near KSFO; moves between the recording's two real polls (2.5 s apart)
const HIDDEN = '000002' // dbFlags 8 (LADD)
const T0 = 2_000_000_000_000 // injected server clock, far from the recording's (1.79e12): proves the rebase

const tmp = (): string => mkdtempSync(join(tmpdir(), 'fh-main-'))

async function get<T>(url: string): Promise<{ status: number; type: string | null; body: T }> {
  const res = await fetch(url)
  return { status: res.status, type: res.headers.get('content-type'), body: (await res.json()) as T }
}

async function getText(url: string, method = 'GET'): Promise<{ status: number; type: string | null; body: string }> {
  const res = await fetch(url, { method })
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() }
}

/** GET with the path sent byte for byte (fetch would resolve '..' before sending). */
function rawGet(base: string, path: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    request({ hostname, port, path }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
      .on('error', reject)
      .end()
  })
}

async function waitFor<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 8000): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

const viewUrl = (base: string, since: number, nm = 10): string => `${base}/api/view?lat=${KSFO.lat}&lon=${KSFO.lon}&nm=${nm}&since=${since}`

/**
 * What a client sees, identical for every source. Run once per source, this is the flip test.
 * advance() lets the upstream move past the recording's second real poll.
 */
async function assertApi(base: string, kind: SourceKind, advance: () => void): Promise<void> {
  // 1. First view (since=0): the latest sample per aircraft inside the circle, stamped in server clock.
  const v1 = await waitFor('first samples', () => get<ViewResponse>(viewUrl(base, 0)), (r) => r.body.samples.length > 0)
  assert.equal(v1.status, 200)
  assert.equal(v1.type, 'application/json')
  assert.equal(v1.body.status.source, kind)
  assert.equal(v1.body.status.degraded, null)
  const first = v1.body.samples
  assert.equal(new Set(first.map((s) => s.hex)).size, first.length, 'since=0 gives one sample per aircraft')
  assert.ok(first.some((s) => s.hex === CHASED))
  assert.ok(!first.some((s) => s.hex === HIDDEN), 'LADD aircraft are hidden by default')
  for (const s of first) {
    assert.ok(distanceNm(KSFO.lat, KSFO.lon, s.lat, s.lon) <= 10, s.hex)
    assert.ok(s.tMs <= v1.body.serverNowMs && s.tMs > v1.body.serverNowMs - 60_000, `${s.hex} tMs ${s.tMs} vs server ${v1.body.serverNowMs}`)
    assert.ok(s.rxMs <= v1.body.serverNowMs)
  }

  // 2. Poll again with since = the newest rxMs seen: only samples that arrived later, each newer than before.
  const since = Math.max(...first.map((s) => s.rxMs))
  advance()
  const v2 = await waitFor('newer samples', () => get<ViewResponse>(viewUrl(base, since)), (r) => r.body.samples.length > 0)
  const before = new Map(first.map((s) => [s.hex, s]))
  for (const s of v2.body.samples) {
    assert.ok(s.rxMs > since, `${s.hex} rxMs ${s.rxMs} ≤ since ${since}`)
    const old = before.get(s.hex)
    if (old) assert.ok(s.tMs > old.tMs, `${s.hex} is newer than its first sample`)
  }
  assert.ok(v2.body.samples.some((s) => s.hex === CHASED))

  // 3. Chase: the stored track of one aircraft, oldest first; hex case does not matter.
  const c1 = await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED.toUpperCase()}&since=0`)
  assert.equal(c1.status, 200)
  assert.equal(c1.type, 'application/json')
  assert.equal(c1.body.status.source, kind)
  const track = c1.body.samples
  assert.ok(track.length >= 2, `track has ${track.length} samples`)
  assert.ok(track.every((s) => s.hex === CHASED))
  for (let i = 1; i < track.length; i++) assert.ok(track[i].tMs > track[i - 1].tMs)
  const c2 = await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED}&since=${track.at(-1)!.rxMs}`)
  assert.deepEqual(c2.body.samples, [], 'the recording has no later position')

  // 4. Status: the poller's report.
  const st = await get<StatusReport>(`${base}/api/status`)
  assert.equal(st.status, 200)
  assert.equal(st.type, 'application/json')
  const keys = ['budget', 'bytesPerHourEstimate', 'cellPeriodP95S', 'cells', 'chasePeriodP95S', 'chasedHexes', 'degraded', 'requestsTotal', 'source']
  assert.deepEqual(Object.keys(st.body).sort(), keys)
  assert.equal(st.body.source, kind)
  assert.equal(st.body.degraded, null)
  assert.deepEqual(st.body.cells, [], 'full-snapshot sources poll no cells')
  assert.deepEqual(st.body.chasedHexes, [CHASED])
  assert.equal(st.body.budget.maxRps, 1)
  assert.equal(st.body.budget.blocked, false)
  assert.ok(st.body.requestsTotal >= 2)
  assert.ok(st.body.bytesPerHourEstimate > 0)
  assert.equal(typeof st.body.cellPeriodP95S, 'number')

  // 5. Bad parameters: 400 with a JSON error.
  const bad = [
    '/api/view?lon=0&nm=10',
    '/api/view?lat=&lon=0&nm=10',
    '/api/view?lat=91&lon=0&nm=10',
    '/api/view?lat=0&lon=-181&nm=10',
    '/api/view?lat=0&lon=0&nm=0',
    '/api/view?lat=0&lon=0&nm=ten',
    '/api/view?lat=0&lon=0&nm=10&since=-1',
    '/api/chase',
    '/api/chase?hex=a067e',
    '/api/chase?hex=xyz123',
    '/api/chase?hex=a067ec&since=soon',
  ]
  for (const path of bad) {
    const r = await get<{ error: string }>(base + path)
    assert.equal(r.status, 400, path)
    assert.equal(r.type, 'application/json', path)
    assert.equal(typeof r.body.error, 'string', path)
  }
}

test('replay on an injected server clock: view, since, chase, status, 400s; replay is never recorded', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const dir = tmp()
  const recordDir = join(dir, 'rec')
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, RECORD_DIR: recordDir }), staticDir: join(dir, 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/)

  await assertApi(base, 'replay', () => {
    clock.t += 2500
  })

  // Every sample was received at one of the two injected instants, and serverNowMs is the injected clock.
  const v = await get<ViewResponse>(viewUrl(base, 0))
  assert.equal(v.body.serverNowMs, T0 + 2500)
  const chase = await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED}&since=0`)
  assert.deepEqual([...new Set(chase.body.samples.map((s) => s.rxMs))], [T0, T0 + 2500])
  assert.equal(existsSync(recordDir), false, 'RECORD_DIR is ignored for replay')
  // No dist/ here: the client is simply missing.
  const home = await getText(`${base}/`)
  assert.equal(home.status, 404)
  assert.match(home.body, /npm run build/)
})

test('flip: the same API from ADSB_SOURCE=readsb against a fake receiver serving the same recording', async (t) => {
  const fake = await startFakeReadsb({ files: [FILE], port: 0 })
  t.after(() => fake.close())
  const dir = tmp()
  const recordDir = join(dir, 'rec')
  const env = { ADSB_SOURCE: 'readsb', READSB_URL: fake.url, READSB_COVERAGE: '37.6188,-122.3758,200', RECORD_DIR: recordDir }
  const cfg = { ...readServerConfig(env), staticDir: join(dir, 'dist') }
  const app = createServer(cfg) // source from makeSource(cfg), real clock: what `npm run server` builds
  const base = await app.listen(0)
  t.after(() => app.close())

  await assertApi(base, 'readsb', () => {}) // real time: the fake receiver reaches the second poll 2.5 s after start

  const lines = readdirSync(recordDir).flatMap((f) => readRecording(join(recordDir, f)))
  assert.ok(lines.length >= 2, `${lines.length} recorded polls`)
  assert.ok(lines.every((l) => l.source === 'readsb' && l.url.startsWith(`${fake.url}/?`)))
})

test('SHOW_PIA_LADD=1 serves PIA/LADD aircraft too', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, SHOW_PIA_LADD: '1' }), staticDir: join(tmp(), 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  const v = await waitFor('first samples', () => get<ViewResponse>(viewUrl(base, 0)), (r) => r.body.samples.length > 0)
  assert.ok(v.body.samples.some((s) => s.hex === HIDDEN))
})

test('a view wider than 250 nm is served, not rejected', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: join(tmp(), 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  const v = await waitFor('first samples', () => get<ViewResponse>(viewUrl(base, 0, 3000)), (r) => r.body.samples.length > 0)
  assert.equal(v.status, 200)
})

test('static: dist/ files with content types, index.html for client routes, 404 for missing assets and traversal', async (t) => {
  const dir = tmp()
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>FlightHopper</title>')
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(dist, 'assets', 'app.css'), 'body{}')
  writeFileSync(join(dist, 'assets', 'data.bin'), 'x')
  writeFileSync(join(dir, 'secret.txt'), 'TOP SECRET')
  const app = createServer({ ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: dist })
  const base = await app.listen(0)
  t.after(() => app.close())

  const home = await getText(`${base}/`)
  assert.equal(home.status, 200)
  assert.equal(home.type, 'text/html; charset=utf-8')
  assert.match(home.body, /FlightHopper/)
  assert.deepEqual(await getText(`${base}/assets/app.js`), { status: 200, type: 'text/javascript; charset=utf-8', body: 'console.log(1)' })
  assert.equal((await getText(`${base}/assets/app.css`)).type, 'text/css; charset=utf-8')
  assert.equal((await getText(`${base}/assets/data.bin`)).type, 'application/octet-stream')
  for (const route of ['/?hex=a067ec&bench=1', '/chase/a067ec', '/assets/']) {
    const r = await getText(base + route)
    assert.equal(r.status, 200, route)
    assert.match(r.body, /FlightHopper/, route)
  }
  assert.equal((await getText(`${base}/assets/missing.js`)).status, 404)
  const api = await getText(`${base}/api/nope`)
  assert.equal(api.status, 404)
  assert.equal(api.type, 'application/json')
  assert.equal((await getText(`${base}/api/status`, 'POST')).status, 405)

  const attacks = [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/%00',
    '/%zz',
  ]
  for (const path of attacks) {
    const r = await rawGet(base, path)
    assert.equal(r.status, 404, path)
    assert.doesNotMatch(r.body, /TOP SECRET/, path)
  }
})

test('CLI: `node server/main.ts` reads the environment and serves', async (t) => {
  const child = spawn(process.execPath, [MAIN], {
    env: { ADSB_SOURCE: 'replay', REPLAY_FILES: FILE, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => child.kill())
  let out = ''
  child.stdout.setEncoding('utf8')
  const base = await new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (c: string) => {
      out += c
      const m = /http:\/\/127\.0\.0\.1:\d+/.exec(out)
      if (m) resolve(m[0])
    })
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)))
  })
  assert.match(out, /source replay/)
  const st = await get<StatusReport>(`${base}/api/status`)
  assert.equal(st.status, 200)
  assert.equal(st.body.source, 'replay')
})

test('CLI: a config error exits 1 with the message (adsblol without CONTACT; nothing is fetched)', async () => {
  const child = spawn(process.execPath, [MAIN], { env: { ADSB_SOURCE: 'adsblol' }, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c: string) => (err += c))
  const [code] = await once(child, 'exit')
  assert.equal(code, 1)
  assert.match(err, /^server: CONTACT is required for ADSB_SOURCE=adsblol/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/main.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/main.ts' imported from …/server/main.test.ts`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// server/main.ts
// The FlightHopper server: one Source → Poller → SampleStore, served as plain HTTP polling, plus the built client.
//   npm run server                      (settings: .env.local, see .env.example)
//   GET /api/view?lat&lon&nm&since      samples in a circle received after `since` (server-clock rxMs)
//   GET /api/chase?hex&since            one aircraft's samples received after `since`
//   GET /api/status                     the poller's StatusReport
//   GET /*                              dist/ (index.html for client routes)
import { readFile, stat } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import type { ChaseResponse, ViewResponse } from '../shared/api.ts'
import { TokenBucket } from './budget.ts'
import { readServerConfig, type ServerConfig } from './config.ts'
import { POLLER_DEFAULTS, Poller } from './poller.ts'
import { Recorder } from './recorder.ts'
import { makeSource } from './sources/index.ts'
import type { Source } from './sources/types.ts'
import { SampleStore } from './store.ts'

// ponytail: loopback only. Cloudflare Tunnel and the Vite dev proxy both connect locally, but other machines on the
// LAN cannot. Add a HOST variable when one needs to.
const HOST = '127.0.0.1'
// ponytail: an area source (adsb.lol) polls the cells of at most a 250 nm view; a wider view still gets whatever the
// store holds. Full-snapshot sources have no cells, so the cap costs them nothing.
const MAX_POLLED_NM = 250
const HEX = /^~?[0-9a-f]{6}$/

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
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
 * Wires one Source (cfg, or deps.source) to a Poller, a SampleStore and an HTTP server.
 * deps.nowMs is the server clock for the poller and the budget; it must be the clock the source stamps tRecvMs with
 * (Date.now for live sources, the same injected clock for a replay built with it).
 */
export function createServer(
  cfg: ServerConfig,
  deps: { source?: Source; nowMs?: () => number } = {},
): { listen(port: number): Promise<string>; close(): Promise<void>; poller: Poller } {
  const nowMs = deps.nowMs ?? Date.now
  const source = deps.source ?? makeSource(cfg)
  const store = new SampleStore()
  const bucket = new TokenBucket(Math.min(cfg.maxRps, source.caps.maxRps), nowMs)
  const recorder = cfg.recordDir !== null && source.caps.kind !== 'replay' ? new Recorder(cfg.recordDir) : null
  // The poller prunes the store (180 s horizon) on every 100 ms tick, so no separate prune timer is needed.
  const poller = new Poller(source, store, bucket, { ...POLLER_DEFAULTS, recorder, hideFlagged: !cfg.showPiaLadd, nowMs })
  const root = resolve(cfg.staticDir)

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
    return { serverNowMs: nowMs(), samples: store.view(lat, lon, nm, since), status: poller.brief() }
  }

  function chase(q: URLSearchParams): ChaseResponse {
    const hex = (q.get('hex') ?? '').trim().toLowerCase()
    const since = num(q, 'since', 0)
    check(HEX.test(hex), 'hex must be 6 hex digits (optionally prefixed with ~)')
    check(since >= 0, 'since must be ≥ 0')
    poller.touchChase(hex)
    return { serverNowMs: nowMs(), samples: store.track(hex, since), status: poller.brief() }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/')
    if (req.method !== 'GET') {
      if (isApi) sendJson(res, 405, { error: 'only GET' })
      else sendText(res, 405, 'only GET\n')
      return
    }
    if (!isApi) return serveStatic(root, url.pathname, res)
    try {
      if (url.pathname === '/api/view') return sendJson(res, 200, view(url.searchParams))
      if (url.pathname === '/api/chase') return sendJson(res, 200, chase(url.searchParams))
      if (url.pathname === '/api/status') return sendJson(res, 200, poller.report())
      sendJson(res, 404, { error: `no such endpoint: ${url.pathname}` })
    } catch (e) {
      if (!(e instanceof BadRequest)) throw e
      sendJson(res, 400, { error: e.message })
    }
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error('server: request failed:', e)
      if (res.headersSent) res.destroy()
      else sendJson(res, 500, { error: 'internal error' })
    })
  })

  return {
    poller,
    listen(port: number): Promise<string> {
      return new Promise((done, fail) => {
        server.once('error', fail)
        server.listen(port, HOST, () => {
          server.off('error', fail)
          poller.start()
          done(`http://${HOST}:${(server.address() as AddressInfo).port}`)
        })
      })
    },
    close(): Promise<void> {
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
    console.log(`FlightHopper server on ${url} (source ${cfg.source})`)
  } catch (e) {
    console.error(`server: ${(e as Error).message}`)
    process.exit(1)
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/main.test.ts`
Expected: PASS — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0` in ≈ 4 s. The flip test takes ≈ 3 s of real time; the others take ≈ 0.1–0.2 s each.

- [ ] **Step 5: Commit**

```bash
git add server/main.ts server/main.test.ts
git commit -m "feat(server): HTTP API, static client and replay/readsb flip test" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: All tests of this package**

Run: `node --test server/config.test.ts server/sources/index.test.ts server/main.test.ts`
Expected: `ℹ tests 23`, `ℹ pass 23`, `ℹ fail 0`.

- [ ] **Step 2: Type-check, filtered to this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E '^server/(config|main|sources/index)'`
Expected: no output (grep exits 1).

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` silent; `ℹ fail 0` (the test count is WP-00 + the merged Wave 1 and Wave 2 packages + 23).

- [ ] **Step 4: Smoke-test the server by hand (optional, local only, no upstream traffic)**

```bash
ADSB_SOURCE=replay REPLAY_FILES=data/fixtures/golden/recording-sample.jsonl PORT=18787 node server/main.ts &
sleep 1.5
curl -s 'http://127.0.0.1:18787/api/view?lat=37.6188&lon=-122.3758&nm=3&since=0' | head -c 200; echo
curl -s 'http://127.0.0.1:18787/api/status' | head -c 200; echo
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:18787/api/view?lat=100&lon=0&nm=1'
kill $!
```

Expected: `FlightHopper server on http://127.0.0.1:18787 (source replay)`, then a `ViewResponse` that starts `{"serverNowMs":…,"samples":[{"hex":…` (about 31 aircraft within 3 nm of KSFO), then a `StatusReport` that starts `{"source":"replay","degraded":null,"cellPeriodP95S":…`, then `400`.

- [ ] **Step 5: Nothing left uncommitted**

Run: `git status --short`
Expected: no output. The branch is ready to merge (PLAN.md §5 step 4).

**Notes for the orchestrator:**
- `npm run server` with no `.env.local` uses `ADSB_SOURCE=replay` and `REPLAY_FILES=data/fixtures/*.jsonl`. Until curated fixtures are promoted to `data/fixtures/` (only `golden/` exists now), it exits with `server: REPLAY_FILES matched no files: data/fixtures/*.jsonl`. That is the intended clear error. Promote a fixture, or set `REPLAY_FILES=data/fixtures/golden/recording-sample.jsonl` in `.env.local`.
- Gate G1 (`ADSB_SOURCE=adsblol MAX_RPS=0.5 npm run server` + `node tools/gate-g1.ts`) reads the `StatusReport` served at `/api/status` here. The G1 flip criterion is this package's `flip:` test.
