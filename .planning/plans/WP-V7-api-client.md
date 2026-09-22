# WP-V7 — API Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the browser one small object that polls the FlightHopper server for a view circle and for the chased aircraft. It asks only for samples it has not seen yet, and it knows the server's clock, which the render clock runs against.

**Architecture:** One file, `client/api.ts`, with one class, `ApiClient`. A2 creates one instance with `cfg.apiBase`, calls `view()` and `chase()` at 1 Hz, and feeds `RenderClock.tick()` from `serverNowMs()`.
- **Requests:** exactly `${base}/view?lat=${lat}&lon=${lon}&nm=${nm}&since=${since}` and `${base}/chase?hex=${hex}&since=${since}`. lat, lon and nm keep the caller's exact values. Each request carries `AbortSignal.timeout(10 s)` so that a hung request cannot stall the poll loop.
- **since:** one value is tracked per key. A view key is `lat.toFixed(2)`, `lon.toFixed(2)` and nm. A chase key is the hex. `since` is the maximum `Sample.rxMs` (server clock) seen so far in replies for that key. It starts at 0, so the server answers with the latest sample per hex. An empty or older reply never lowers it, and overlapping requests only raise it. When the camera moves to a new key, polling starts again from 0. At most 100 keys are remembered, and the least recently used is dropped first (a `ponytail:` ceiling).
- **Server clock:** every 2xx reply calls `MinOffset(60_000).update(localRecvMs, body.serverNowMs)`. `localRecvMs` is `nowMs()` when the headers arrive. `serverNowMs() = nowMs() − offset.get()`. Because the offset is the windowed minimum of receive minus serverNowMs, a slow reply never drags the clock, and the result stays behind the true server time by the smallest one-way latency seen. That error is on the safe side for starvation. `ready` stays false until the first 2xx reply, and `serverNowMs()` throws `Error('ApiClient: no response yet')` until then, so A2 checks `ready` first.
- **Errors:** a non-2xx reply rejects with ``Error(`HTTP ${status}`)`` and changes neither the clock nor `since`. Network errors and timeouts reject with fetch's own error.
- **Default fetch:** the default is `(input, init) => fetch(input, init)`, not the bare `fetch`. The class calls `this.#fetch(…)`, and a browser throws `TypeError: Illegal invocation` when its `fetch` runs with `this` set to another object. A test pins this. A mutation check (setting the default to `globalThis.fetch`) makes that test fail with exactly that error.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only). There are no runtime dependencies beyond WP-00's `MinOffset`. The tests use the global `Response` and `t.mock.method`, with no network.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 45 min. **Validated:** on 2026-09-22 (Node v25.2.1, TypeScript 7.0.2), every file below was run in the shared Wave 1 sandbox:
- `node --test client/api.test.ts` passed 9/9.
- `npx tsc --noEmit` reported no errors in `client/api*`.
- Step 2 quotes its real RED output.
- The default-fetch test was mutation-checked as described above.
- The code blocks of this plan were then extracted into a clean WP-00 tree. There they passed the same 9/9, `tsc --noEmit` was clean for the whole tree, and `npm test` reported 49/49.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- Tests never touch the network. They inject a fake `fetch` that returns `ViewResponse` or `ChaseResponse` JSON, and a fake `nowMs`.
- Time: `since` and `rxMs` are server-clock ms, and `serverNowMs()` returns server-clock ms. `nowMs` is the local clock (`Date.now` by default).
- Erasable TypeScript only (`#private` fields and methods are plain JavaScript). Relative imports have a `.ts` extension. This package creates or edits only the two files below.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/api.ts` | `class ApiClient`: view and chase requests, `since` per key, server clock via `MinOffset` |
| `client/api.test.ts` | exact query strings, `since` per view key and hex, key cap, readiness, clock offset window, HTTP errors, unbound default fetch |

---

### Task 1: ApiClient

**Files:**
- Create: `client/api.ts`, `client/api.test.ts`
- Test: `client/api.test.ts`

**Interfaces:**
- Consumes: `ViewResponse` and `ChaseResponse` (`shared/api.ts`, WP-00). `MinOffset` (`shared/clock.ts`, WP-00: `update(localRecvMs, remoteNowMs)`, `ready`, `get()`). `Sample.rxMs` (`shared/types.ts`, WP-00).
- Produces: `class ApiClient { constructor(base: string, fetchFn?: typeof fetch, nowMs?: () => number); view(lat: number, lon: number, radiusNm: number): Promise<ViewResponse>; chase(hex: string): Promise<ChaseResponse>; serverNowMs(): number; get ready(): boolean }`

- [ ] **Step 1: Write the failing test**

```ts
// client/api.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StatusBrief } from '../shared/api.ts'
import type { Sample } from '../shared/types.ts'
import { ApiClient } from './api.ts'

const status: StatusBrief = { source: 'replay', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }

const sample = (hex: string, rxMs: number): Sample => ({
  hex, tMs: rxMs - 500, rxMs, lat: 37.6, lon: -122.4, onGround: false, altBaroFt: 3000, altGeomFt: 3100, gsKt: 150,
  trackDeg: 280, trueHeadingDeg: null, rollDeg: null, baroRateFpm: -700, geomRateFpm: null, navQnhHpa: null,
  version: 2, nic: 8, quality: 'adsb2', nM: -32.3, callsign: null, typeCode: null, reg: null,
})

interface Reply {
  status?: number
  serverNowMs?: number
  samples?: Sample[]
  latencyMs?: number
}

/** A fake server behind a fake fetch: records each request and answers with the next queued reply (default 200, no samples). */
function fake(startMs = 1_000_000) {
  const clock = { t: startMs }
  const urls: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const replies: Reply[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input))
    inits.push(init)
    const r = replies.shift() ?? {}
    clock.t += r.latencyMs ?? 0
    const body = { serverNowMs: r.serverNowMs ?? clock.t, samples: r.samples ?? [], status }
    return new Response(JSON.stringify(body), { status: r.status ?? 200 })
  }) as typeof fetch
  const api = new ApiClient('http://host/api', fetchFn, () => clock.t)
  return { api, clock, urls, inits, replies }
}

test('view: exact query string, since starts at 0, parsed body returned, request has a timeout signal', async () => {
  const f = fake()
  f.replies.push({ serverNowMs: 999_900, samples: [sample('abc123', 999_000)] })
  const r = await f.api.view(37.6188, -122.3758, 40)
  assert.deepEqual(f.urls, ['http://host/api/view?lat=37.6188&lon=-122.3758&nm=40&since=0'])
  assert.equal(r.serverNowMs, 999_900)
  assert.deepEqual(r.samples, [sample('abc123', 999_000)])
  assert.deepEqual(r.status, status)
  assert.ok(f.inits[0]?.signal instanceof AbortSignal)
})

test('view: since = max rxMs seen so far for that key; empty or older replies never lower it', async () => {
  const f = fake()
  f.replies.push({ samples: [sample('a', 1000), sample('b', 3000), sample('c', 2000)] }, {}, { samples: [sample('a', 2500)] })
  for (let i = 0; i < 4; i++) await f.api.view(10, 20, 30)
  assert.deepEqual(f.urls.map((u) => new URL(u).searchParams.get('since')), ['0', '3000', '3000', '3000'])
})

test('view key: lat/lon rounded to 2 decimals plus nm; the query keeps the exact values', async () => {
  const f = fake()
  f.replies.push({ samples: [sample('a', 5000)] })
  await f.api.view(37.6188, -122.3758, 40)
  await f.api.view(37.6212, -122.3771, 40) // same key 37.62,-122.38,40
  await f.api.view(37.6212, -122.3771, 60) // other nm
  await f.api.view(37.6312, -122.3771, 40) // other lat
  assert.deepEqual(f.urls, [
    'http://host/api/view?lat=37.6188&lon=-122.3758&nm=40&since=0',
    'http://host/api/view?lat=37.6212&lon=-122.3771&nm=40&since=5000',
    'http://host/api/view?lat=37.6212&lon=-122.3771&nm=60&since=0',
    'http://host/api/view?lat=37.6312&lon=-122.3771&nm=40&since=0',
  ])
})

test('chase: exact query string, since per hex, independent of views', async () => {
  const f = fake()
  f.replies.push({ samples: [sample('abc123', 7000)] }, { samples: [sample('def456', 9000)] }, { samples: [sample('x', 8000)] })
  await f.api.chase('abc123')
  await f.api.chase('def456')
  await f.api.view(1, 2, 3)
  await f.api.chase('abc123')
  await f.api.chase('~a330e6')
  assert.deepEqual(f.urls, [
    'http://host/api/chase?hex=abc123&since=0',
    'http://host/api/chase?hex=def456&since=0',
    'http://host/api/view?lat=1&lon=2&nm=3&since=0',
    'http://host/api/chase?hex=abc123&since=7000',
    'http://host/api/chase?hex=~a330e6&since=0',
  ])
})

test('since memory is capped at 100 keys, least recently used first', async () => {
  const f = fake()
  f.replies.push({ samples: [sample('a', 4000)] }, { samples: [sample('b', 6000)] })
  await f.api.chase('first')
  await f.api.chase('kept')
  for (let i = 0; i < 98; i++) await f.api.view(i, 0, 10) // 100 keys: nothing evicted yet
  await f.api.chase('first') // touch: now the most recently used
  await f.api.view(0, 1, 10) // key 101 evicts the oldest: 'kept'
  await f.api.chase('first')
  await f.api.chase('kept')
  assert.deepEqual(f.urls.slice(-2), ['http://host/api/chase?hex=first&since=4000', 'http://host/api/chase?hex=kept&since=0'])
})

test('not ready, and serverNowMs throws, until the first response', async () => {
  const f = fake()
  assert.equal(f.api.ready, false)
  assert.throws(() => f.api.serverNowMs(), /no response yet/)
  await f.api.chase('abc123')
  assert.equal(f.api.ready, true)
})

test('serverNowMs = nowMs − min(local receive − serverNowMs) over the last 60 s', async () => {
  const f = fake(1_000_000)
  f.replies.push({ serverNowMs: 999_750 }) // offset 250
  await f.api.view(1, 2, 3)
  assert.equal(f.api.serverNowMs(), 999_750)
  f.clock.t += 5000
  assert.equal(f.api.serverNowMs(), 1_004_750) // runs on the local clock between responses
  f.replies.push({ serverNowMs: 1_004_850, latencyMs: 400 }) // received at 1_005_400 → 550: a slow reply, not a clock change
  await f.api.chase('abc123')
  assert.equal(f.api.serverNowMs(), f.clock.t - 250)
  f.clock.t += 61_000
  f.replies.push({ serverNowMs: f.clock.t - 300 }) // both older entries have left the window
  await f.api.view(1, 2, 3)
  assert.equal(f.api.serverNowMs(), f.clock.t - 300)
})

test('non-2xx rejects with Error("HTTP <status>") and changes neither the clock nor since', async () => {
  const f = fake()
  f.replies.push({ status: 503, samples: [sample('a', 9000)] })
  await assert.rejects(f.api.view(1, 2, 3), { name: 'Error', message: 'HTTP 503' })
  assert.equal(f.api.ready, false)
  f.replies.push({ status: 404 })
  await assert.rejects(f.api.chase('abc123'), { message: 'HTTP 404' })
  await f.api.view(1, 2, 3)
  assert.equal(new URL(f.urls.at(-1)!).searchParams.get('since'), '0')
})

test('default fetch is the global one, called unbound (a browser throws "Illegal invocation" otherwise)', async (t) => {
  const seenThis: unknown[] = []
  t.mock.method(globalThis, 'fetch', async function (this: unknown) {
    seenThis.push(this)
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
    return new Response(JSON.stringify({ serverNowMs: 1, samples: [], status }))
  })
  const r = await new ApiClient('/api').view(1, 2, 3)
  assert.equal(r.serverNowMs, 1)
  assert.equal(seenThis.length, 1)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/api.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/api.ts' imported from …/client/api.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/api.ts
// Browser client for the FlightHopper server: GET /view and /chase with a per-key `since`, plus the server clock.
import type { ChaseResponse, ViewResponse } from '../shared/api.ts'
import { MinOffset } from '../shared/clock.ts'

const OFFSET_WINDOW_MS = 60_000
const TIMEOUT_MS = 10_000 // a hung request must not stall the 1 Hz poll loop
// ponytail: plain insertion-order eviction; a camera panning for hours creates many view keys. Upgrade to real LRU if
// a key ever gets evicted while still polled (it would only cost one full `since=0` reply).
const MAX_KEYS = 100

export class ApiClient {
  #base: string
  #fetch: typeof fetch
  #nowMs: () => number
  #offset = new MinOffset(OFFSET_WINDOW_MS)
  #since = new Map<string, number>()

  /** Wrap the global fetch: a browser throws "Illegal invocation" when fetch is called as a method of another object. */
  constructor(base: string, fetchFn: typeof fetch = (input, init) => fetch(input, init), nowMs: () => number = Date.now) {
    this.#base = base
    this.#fetch = fetchFn
    this.#nowMs = nowMs
  }

  /** Samples in the circle received by the server after the last reply for this view (key: lat/lon to 2 decimals + nm). */
  view(lat: number, lon: number, radiusNm: number): Promise<ViewResponse> {
    const key = `view:${lat.toFixed(2)},${lon.toFixed(2)},${radiusNm}`
    return this.#get(key, (since) => `${this.#base}/view?lat=${lat}&lon=${lon}&nm=${radiusNm}&since=${since}`)
  }

  /** The chased aircraft's samples received by the server after the last reply for this hex. */
  chase(hex: string): Promise<ChaseResponse> {
    return this.#get(`chase:${hex}`, (since) => `${this.#base}/chase?hex=${hex}&since=${since}`)
  }

  /** Server clock now, from the local clock and the smallest (receive − serverNowMs) of the last 60 s. Throws before `ready`. */
  serverNowMs(): number {
    if (!this.#offset.ready) throw new Error('ApiClient: no response yet')
    return this.#nowMs() - this.#offset.get()
  }

  get ready(): boolean {
    return this.#offset.ready
  }

  async #get<T extends ViewResponse | ChaseResponse>(key: string, url: (since: number) => string): Promise<T> {
    const res = await this.#fetch(url(this.#since.get(key) ?? 0), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const recvMs = this.#nowMs() // headers are in: the closest local time to when the server stamped serverNowMs
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // ponytail: trusts the JSON shape; this is our own server built from the same shared/api.ts contract.
    const body = (await res.json()) as T
    this.#offset.update(recvMs, body.serverNowMs)
    let since = this.#since.get(key) ?? 0 // re-read after the await: overlapping requests only ever raise it
    for (const s of body.samples) if (s.rxMs > since) since = s.rxMs
    this.#since.delete(key) // re-insert so the oldest-used key is evicted first
    this.#since.set(key, since)
    if (this.#since.size > MAX_KEYS) this.#since.delete(this.#since.keys().next().value!)
    return body
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/api.test.ts`
Expected: PASS — `ℹ tests 9`, `ℹ pass 9`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/api.ts client/api.test.ts
git commit -m "feat(client): API client with per-key since and server clock offset"
```

---

### Task 2: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/api.test.ts`
Expected: `ℹ tests 9`, `ℹ pass 9`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/api'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` prints nothing. On a worktree branched from `wave-0`, the counts are `ℹ tests 50`, `ℹ pass 50`, `ℹ fail 0` (41 from WP-00 plus 9 here).

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.
