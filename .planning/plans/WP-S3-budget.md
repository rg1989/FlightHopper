# WP-S3 — Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every upstream source inside its polite request budget, and prove it. This package delivers a self-adjusting token bucket that the Poller (WP-I1) asks before each upstream request, and the Gate G1 tool that watches a running server's `/api/status` and scores the budget.

**Architecture:** `server/budget.ts` is one class with an injected clock. It is a burst-2 token bucket whose rate follows what the upstream answers: 429 halves the rate (floor `maxRps/8`) and pauses for `Retry-After`; 401/403 blocks forever; 5xx or a network error (status 0) pauses with exponential backoff and jitter. The rate recovers ×1.1 per quiet minute. All state is brought up to date lazily from the clock on each call. There are no timers, so the tests drive a fake clock. `tools/gate-g1.ts` is a pure `evaluateG1(reports, seconds)` plus a thin CLI. The CLI polls `GET {base}/api/status` every 10 s for `--minutes` and writes `.planning/reports/G1-<YYYY-MM-DD>.json`.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, global `fetch`, `node:util` `parseArgs`, `node:http` (test fake only). No new dependencies.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 1.5–2 h. **Validated:** on 2026-09-22, every file below was run in the shared Wave 1 sandbox (Node v25.2.1, TypeScript 7). The tests were written first and failed with `ERR_MODULE_NOT_FOUND`. Then `node --test server/budget.test.ts tools/gate-g1.test.ts` gave 27/27 pass (17 budget, 10 gate-g1, including 2 CLI smoke runs against a local fake status server), and `tsc --noEmit` reported no errors in these files. The code blocks in this plan were then extracted into a clean copy of WP-00 + this package, and `npm run check` there gave `tsc` silent and 67/67 tests passing (40 WP-00 + 27). **Assembler follow-up (2026-09-22):** under CPU load (several `npm test` runs at once, as in parallel worktrees) the two CLI tests failed in 11 of 12 runs, because a first `/api/status` answer later than the 180 ms test window ended the CLI with one report and `evaluateG1` threw. The CLI now polls up to 3 more times after the window until it has 2 reports, and a third CLI test pins this (it fails on the old loop). Now 28 tests here; 16 concurrent runs of `tools/gate-g1.test.ts` all pass; WP-00 has 41 tests.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. The ones that matter most for this package:
- **Upstream politeness:** ≤ 1 req/s total. 429 halves the rate and honours `Retry-After`. 401/403 stops the source with no retry loop. 5xx/timeout backs off exponentially with jitter. This package is where those rules become code.
- **Tests never touch the network.** The budget tests use a fake clock. The CLI smoke test runs against a local `node:http` fake `/api/status` on port 0. G1 itself only ever reads our own server, never adsb.lol.
- Erasable TypeScript only, `.ts` import extensions, `if (import.meta.main)` for the CLI.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `server/budget.ts` | `TokenBucket`: adaptive upstream request budget |
| `server/budget.test.ts` | fake-clock tests: burst, steady rate, 429, recovery, block, backoff, degraded |
| `tools/gate-g1.ts` | `evaluateG1` + the G1 CLI |
| `tools/gate-g1.test.ts` | evaluator tests with synthetic `StatusReport`s + CLI smoke test |

---

### Task 1: TokenBucket

**Files:**
- Create: `server/budget.ts`, `server/budget.test.ts`
- Test: `server/budget.test.ts`

**Interfaces:**
- Consumes: `BudgetState`, `Degraded` from `shared/api.ts` (WP-00 Task 2).
- Produces (locked, PLAN.md §4 S3): `class TokenBucket { constructor(maxRps: number, nowMs?: () => number, random?: () => number); tryTake(): boolean; onResult(status: number, retryAfterS: number | null): void; state(): BudgetState; get degraded(): Degraded }`. The third constructor argument is the jitter source (default `Math.random`). It is an optional addition so the tests can be deterministic. The locked two-argument form is unchanged.

| Event | Effect |
|---|---|
| construction | `rps = maxRps`, 2 tokens (burst 2), refill `rps` tokens/s, never more than 2 |
| `tryTake()` | `false` when blocked, paused (`now < pausedUntilMs`) or < 1 token; otherwise takes one token → `true` |
| `onResult(429, ra)` | `counts.r429++`; `rps = max(maxRps/8, rps/2)`; pause until `now + (ra ?? 5) s`; restarts the recovery clock |
| 60 s without a 429 | `rps = min(maxRps, rps·1.1)`, once per full 60 s since the last 429 |
| `onResult(401 \| 403)` | `counts.r4xx++`; blocked forever: `tryTake()` is `false` from then on |
| `onResult(5xx \| 0)` | `counts.r5xx++` / `counts.err++`; k = consecutive 5xx/0 (first = 1); pause `min(60 s, 2^k s + random()·1 s)` |
| other 4xx / < 400 | `counts.r4xx++` / `counts.ok++`; resets the 5xx/0 streak |
| any pause | nothing before `pausedUntilMs`; exactly one probe token at `pausedUntilMs`, then the steady rate; a later, shorter pause never shortens it |
| `degraded` | `'blocked'` > `'rate-limited'` (last 429 < 60 s ago) > `'upstream-down'` (≥ 3 consecutive 5xx/0) > `null` |

WP-I1 uses it as: `if (bucket.tryTake()) { const r = await source.circle(…); bucket.onResult(r.status, r.retryAfterS) }`, with `bucket.state()` → `StatusReport.budget` and `bucket.degraded` → `StatusBrief.degraded`.

- [ ] **Step 1: Write the failing test**

```ts
// server/budget.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TokenBucket } from './budget.ts'

/** A bucket on a fake clock: tests move time by assigning c.t (ms). */
function setup(maxRps: number, random?: () => number): { b: TokenBucket; c: { t: number } } {
  const c = { t: 0 }
  return { b: new TokenBucket(maxRps, () => c.t, random), c }
}

const near = (a: number, b: number, msg = ''): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b} ${msg}`)

test('burst 2, then one token per 1/rps', () => {
  const { b, c } = setup(1)
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), false)
  c.t = 999
  assert.equal(b.tryTake(), false)
  c.t = 1000
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), false)
})

test('steady rate: a caller asking every 10 ms gets maxRps on average, plus at most the burst', () => {
  for (const maxRps of [1, 0.5, 5]) {
    const { b, c } = setup(maxRps)
    let n = 0
    for (c.t = 0; c.t <= 600_000; c.t += 10) if (b.tryTake()) n++
    assert.ok(n >= 600 * maxRps && n <= 600 * maxRps + 2, `maxRps ${maxRps}: ${n} takes in 600 s`)
  }
})

test('idle time never banks more than the burst', () => {
  const { b, c } = setup(1)
  c.t = 3_600_000
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), false)
  assert.equal(b.state().tokens, 0)
})

test('429 halves the rate down to a floor of maxRps/8', () => {
  const { b } = setup(1)
  const rates: number[] = []
  for (let i = 0; i < 4; i++) {
    b.onResult(429, null)
    rates.push(b.state().rps)
  }
  assert.deepEqual(rates, [0.5, 0.25, 0.125, 0.125])
})

test('429 pauses for Retry-After, then allows one probe and continues at the halved rate', () => {
  const { b, c } = setup(1)
  c.t = 10_000
  b.onResult(429, 30)
  assert.equal(b.state().pausedUntilMs, 40_000)
  c.t = 39_999
  assert.equal(b.tryTake(), false)
  c.t = 40_000
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), false)
  c.t = 41_999
  assert.equal(b.tryTake(), false)
  c.t = 42_000
  assert.equal(b.tryTake(), true)
})

test('429 without Retry-After pauses 5 s', () => {
  const { b, c } = setup(1)
  b.onResult(429, null)
  assert.equal(b.state().pausedUntilMs, 5000)
  c.t = 4999
  assert.equal(b.tryTake(), false)
  c.t = 5000
  assert.equal(b.tryTake(), true)
})

test('recovery: ×1.1 per 60 s without a 429, capped at maxRps; a new 429 restarts the clock', () => {
  const { b, c } = setup(1)
  b.onResult(429, null)
  near(b.state().rps, 0.5)
  c.t = 59_999
  near(b.state().rps, 0.5)
  c.t = 60_000
  near(b.state().rps, 0.55)
  c.t = 120_000
  near(b.state().rps, 0.605)
  b.onResult(429, null)
  near(b.state().rps, 0.3025)
  c.t = 179_999
  near(b.state().rps, 0.3025)
  c.t = 180_000
  near(b.state().rps, 0.33275)
  c.t = 3_600_000
  assert.equal(b.state().rps, 1)
})

test('degraded is rate-limited while the last 429 is < 60 s old', () => {
  const { b, c } = setup(1)
  assert.equal(b.degraded, null)
  c.t = 1000
  b.onResult(429, 1)
  assert.equal(b.degraded, 'rate-limited')
  c.t = 60_999
  assert.equal(b.degraded, 'rate-limited')
  c.t = 61_000
  assert.equal(b.degraded, null)
})

test('401 and 403 block forever', () => {
  for (const status of [401, 403]) {
    const { b, c } = setup(1)
    b.onResult(status, null)
    assert.equal(b.degraded, 'blocked')
    assert.equal(b.tryTake(), false)
    c.t = 86_400_000
    b.onResult(200, null)
    assert.equal(b.tryTake(), false)
    assert.equal(b.state().blocked, true)
    assert.equal(b.degraded, 'blocked')
  }
})

test('5xx and network errors back off 2^k s + jitter, capped at 60 s', () => {
  const { b, c } = setup(1, () => 0.5)
  const pauses: number[] = []
  for (let i = 0; i < 7; i++) {
    b.onResult(i % 2 === 1 ? 0 : 503, null)
    pauses.push(b.state().pausedUntilMs - c.t)
    c.t = b.state().pausedUntilMs
    assert.equal(b.tryTake(), true, `probe allowed when pause ${i} ends`)
  }
  assert.deepEqual(pauses, [2500, 4500, 8500, 16_500, 32_500, 60_000, 60_000])
})

test('default jitter is within [0, 1) s', () => {
  for (let i = 0; i < 50; i++) {
    const { b } = setup(1)
    b.onResult(502, null)
    const p = b.state().pausedUntilMs
    assert.ok(p >= 2000 && p < 3000, `pause ${p}`)
  }
})

test('3 consecutive 5xx/0 → upstream-down; any other answer resets the streak and the backoff', () => {
  const { b, c } = setup(1, () => 0)
  b.onResult(500, null)
  b.onResult(0, null)
  assert.equal(b.degraded, null)
  b.onResult(504, null)
  assert.equal(b.degraded, 'upstream-down')
  c.t = 100_000
  b.onResult(200, null)
  assert.equal(b.degraded, null)
  b.onResult(503, null)
  assert.equal(b.state().pausedUntilMs, 102_000)
})

test('blocked outranks rate-limited, which outranks upstream-down', () => {
  const { b } = setup(1, () => 0)
  b.onResult(500, null)
  b.onResult(500, null)
  b.onResult(500, null)
  assert.equal(b.degraded, 'upstream-down')
  b.onResult(429, null)
  b.onResult(500, null)
  b.onResult(500, null)
  b.onResult(500, null)
  assert.equal(b.degraded, 'rate-limited')
  b.onResult(403, null)
  assert.equal(b.degraded, 'blocked')
})

test('a pause is never shortened by a later, shorter one', () => {
  const { b } = setup(1, () => 0)
  b.onResult(429, 30)
  b.onResult(503, null)
  assert.equal(b.state().pausedUntilMs, 30_000)
})

test('counts every outcome', () => {
  const { b } = setup(1, () => 0)
  for (const s of [200, 204, 429, 404, 403, 500, 503, 0]) b.onResult(s, null)
  assert.deepEqual(b.state().counts, { ok: 2, r429: 1, r4xx: 2, r5xx: 2, err: 1 })
})

test('state() reports rate, ceiling, accrued tokens and pause', () => {
  const { b, c } = setup(0.5)
  b.tryTake()
  c.t = 1000
  assert.deepEqual(b.state(), {
    rps: 0.5,
    maxRps: 0.5,
    tokens: 1.5,
    blocked: false,
    pausedUntilMs: 0,
    counts: { ok: 0, r429: 0, r4xx: 0, r5xx: 0, err: 0 },
  })
})

test('defaults to the wall clock', () => {
  const b = new TokenBucket(1)
  assert.equal(b.tryTake(), true)
  assert.equal(b.degraded, null)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/budget.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/budget.ts' imported from …/server/budget.test.ts`, `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// server/budget.ts
import type { BudgetState, Degraded } from '../shared/api.ts'

const BURST = 2
const RECOVERY_STEP_MS = 60_000 // ×1.1 per step without a 429
const RATE_LIMITED_MS = 60_000 // a 429 younger than this → degraded 'rate-limited'
const MAX_BACKOFF_MS = 60_000
const DEFAULT_RETRY_AFTER_S = 5

/**
 * Upstream request budget: a token bucket (burst 2) whose rate adapts to what the upstream answers.
 * Call tryTake() before each request and onResult() with its outcome.
 * 429 → rate halves (floor maxRps/8) and pauses for Retry-After; the rate recovers ×1.1 per quiet minute.
 * 401/403 → blocked forever (never retry a block). 5xx / network error (status 0) → exponential pause.
 * After any pause exactly one probe request is allowed; then the steady rate applies.
 */
export class TokenBucket {
  #maxRps: number
  #now: () => number
  #random: () => number
  #rps: number
  #tokens = BURST
  #lastMs: number // tokens are accrued up to this time
  #stepMs = 0 // start of the current recovery step (reset by every 429)
  #last429Ms = -Infinity
  #pausedUntilMs = 0
  #blocked = false
  #fails = 0 // consecutive 5xx / network errors
  #counts = { ok: 0, r429: 0, r4xx: 0, r5xx: 0, err: 0 }

  /** random is the jitter source (tests inject a constant). */
  constructor(maxRps: number, nowMs: () => number = Date.now, random: () => number = Math.random) {
    this.#maxRps = maxRps
    this.#rps = maxRps
    this.#now = nowMs
    this.#random = random
    this.#lastMs = nowMs()
  }

  tryTake(): boolean {
    const now = this.#advance()
    if (this.#blocked || now < this.#pausedUntilMs || this.#tokens < 1) return false
    this.#tokens -= 1
    return true
  }

  onResult(status: number, retryAfterS: number | null): void {
    const now = this.#advance()
    if (status === 429) {
      this.#counts.r429++
      this.#fails = 0
      this.#rps = Math.max(this.#maxRps / 8, this.#rps / 2)
      this.#last429Ms = now
      this.#stepMs = now
      this.#pause(now + (retryAfterS ?? DEFAULT_RETRY_AFTER_S) * 1000)
    } else if (status === 401 || status === 403) {
      this.#counts.r4xx++
      this.#blocked = true
    } else if (status === 0 || status >= 500) {
      if (status === 0) this.#counts.err++
      else this.#counts.r5xx++
      this.#fails++
      this.#pause(now + Math.min(MAX_BACKOFF_MS, 2 ** this.#fails * 1000 + this.#random() * 1000))
    } else {
      if (status >= 400) this.#counts.r4xx++
      else this.#counts.ok++
      this.#fails = 0
    }
  }

  state(): BudgetState {
    this.#advance()
    return {
      rps: this.#rps,
      maxRps: this.#maxRps,
      tokens: this.#tokens,
      blocked: this.#blocked,
      pausedUntilMs: this.#pausedUntilMs,
      counts: { ...this.#counts },
    }
  }

  get degraded(): Degraded {
    if (this.#blocked) return 'blocked'
    if (this.#now() - this.#last429Ms < RATE_LIMITED_MS) return 'rate-limited'
    if (this.#fails >= 3) return 'upstream-down'
    return null
  }

  /** Brings rate and tokens up to now; returns now. Recovery steps are applied at their own step boundaries. */
  #advance(): number {
    const now = this.#now()
    while (this.#rps < this.#maxRps && now - this.#stepMs >= RECOVERY_STEP_MS) {
      this.#stepMs += RECOVERY_STEP_MS
      this.#accrue(this.#stepMs)
      this.#rps = Math.min(this.#maxRps, this.#rps * 1.1)
    }
    this.#accrue(now)
    return now
  }

  #accrue(t: number): void {
    if (t <= this.#lastMs) return
    this.#tokens = Math.min(BURST, this.#tokens + ((t - this.#lastMs) * this.#rps) / 1000)
    this.#lastMs = t
  }

  /** Nothing is sent before untilMs; exactly one token is ready at untilMs. A pause is never shortened. */
  #pause(untilMs: number): void {
    if (untilMs <= this.#pausedUntilMs) return
    this.#pausedUntilMs = untilMs
    this.#tokens = 1
    this.#lastMs = untilMs
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/budget.test.ts`
Expected: PASS — `ℹ tests 17`, `ℹ pass 17`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/budget.ts server/budget.test.ts
git commit -m "feat(server): adaptive upstream token bucket (429 halving, 403 block, 5xx backoff)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Gate G1 evaluator and CLI

**Files:**
- Create: `tools/gate-g1.ts`, `tools/gate-g1.test.ts`
- Test: `tools/gate-g1.test.ts`

**Interfaces:**
- Consumes: `StatusReport` (`shared/api.ts`, WP-00 Task 2). At run time the CLI reads the `StatusReport` JSON that WP-A1 serves at `GET /api/status`. A1 is not needed to build or test this task.
- Produces: `interface G1Check { name: string; value: number; threshold: number; pass: boolean }` · `evaluateG1(reports: StatusReport[], seconds: number): { pass: boolean; checks: G1Check[] }` (throws when there are < 2 reports or `seconds ≤ 0`) · CLI `node tools/gate-g1.ts --base http://127.0.0.1:8787 --minutes 60 [--out .planning/reports]`. The CLI also takes a hidden `--interval-ms` (default 10000) for tests. It writes `<out>/G1-<YYYY-MM-DD, UTC>.json` = `{ gate: 'G1', date, base, seconds, reports, pass, checks, last }` and exits 0 on pass, 1 on fail. If the window ends with fewer than 2 reports (for example a slow first answer on a loaded machine), it polls up to 3 more times, one interval apart, to get the second one.

`reports` are in poll order; `seconds` is the wall time from the first to the last report. `maxRps` is read from the last report's `budget`.

| Check (`name`) | `value` | `threshold` |
|---|---|---|
| `upstream4xx` | `(r429 + r4xx)` of the last report minus the first | 0 |
| `cellPeriodP95S` | max `periodP95S` over all cells of all reports (nulls ignored; NaN when there is none) | `3.5 / min(1, maxRps)`: 3.5 s at 1 req/s, 7 s at `MAX_RPS=0.5` (PLAN.md §6) |
| `chasePeriodP95S` | max `chasePeriodP95S` over all reports (NaN when there is none) | 1.5 |
| `avgUpstreamRps` | `(last.requestsTotal − first.requestsTotal) / seconds` | `maxRps + 2 / seconds` (burst allowance: a saturated burst-2 bucket legitimately sends `rate·T + 2`) |
| `bytesPerHourEstimate` | the last report's value | `Infinity` (reported only) |

A check passes when `value <= threshold`, so NaN always fails. JSON has no `Infinity`/`NaN`: the written file shows them as `null`.

- [ ] **Step 1: Write the failing test**

```ts
// tools/gate-g1.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { StatusReport } from '../shared/api.ts'
import { evaluateG1 } from './gate-g1.ts'

interface Over {
  r429?: number
  r4xx?: number
  maxRps?: number
  requestsTotal?: number
  cells?: (number | null)[]
  chase?: number | null
  bytes?: number
}

/** A synthetic /api/status body. Defaults describe a healthy server. */
const report = (o: Over = {}): StatusReport => ({
  source: 'adsblol',
  degraded: null,
  cellPeriodP95S: null,
  chasePeriodP95S: o.chase === undefined ? 1.2 : o.chase,
  budget: {
    rps: 1,
    maxRps: o.maxRps ?? 1,
    tokens: 0,
    blocked: false,
    pausedUntilMs: 0,
    counts: { ok: 0, r429: o.r429 ?? 0, r4xx: o.r4xx ?? 0, r5xx: 0, err: 0 },
  },
  cells: (o.cells ?? [3.1]).map((p, i) => ({ id: `b31:${i}`, lat: 36, lon: -122.5, radiusNm: 181, lastOkMs: 0, periodP95S: p })),
  chasedHexes: ['a1b2c3'],
  bytesPerHourEstimate: o.bytes ?? 5e6,
  requestsTotal: o.requestsTotal ?? 0,
})

type Result = ReturnType<typeof evaluateG1>
const check = (r: Result, name: string): Result['checks'][number] => {
  const c = r.checks.find((x) => x.name === name)
  assert.ok(c, `no check named ${name}`)
  return c
}

test('a healthy hour passes every check', () => {
  const r = evaluateG1([report(), report({ requestsTotal: 1800 }), report({ requestsTotal: 3500 })], 3600)
  assert.equal(r.pass, true)
  assert.deepEqual(
    r.checks.map((c) => c.name),
    ['upstream4xx', 'cellPeriodP95S', 'chasePeriodP95S', 'avgUpstreamRps', 'bytesPerHourEstimate'],
  )
  assert.ok(r.checks.every((c) => c.pass))
  assert.deepEqual(check(r, 'bytesPerHourEstimate'), { name: 'bytesPerHourEstimate', value: 5e6, threshold: Infinity, pass: true })
})

test('any 429 or other 4xx during the window fails; 4xx from before the window does not', () => {
  assert.equal(evaluateG1([report({ r429: 3, r4xx: 1 }), report({ r429: 3, r4xx: 1 })], 60).pass, true)
  const r = evaluateG1([report({ r429: 3 }), report({ r429: 3, r4xx: 1 })], 60)
  assert.equal(r.pass, false)
  assert.deepEqual(check(r, 'upstream4xx'), { name: 'upstream4xx', value: 1, threshold: 0, pass: false })
  assert.equal(check(evaluateG1([report(), report({ r429: 1 })], 60), 'upstream4xx').pass, false)
})

test('cell period: the worst cell p95 of any report counts; nulls are ignored', () => {
  const r = evaluateG1([report({ cells: [3.0, null] }), report({ cells: [null, 4.0] }), report({ cells: [3.2, 3.3] })], 60)
  assert.deepEqual(check(r, 'cellPeriodP95S'), { name: 'cellPeriodP95S', value: 4, threshold: 3.5, pass: false })
  assert.equal(r.pass, false)
})

test('cell period threshold scales with MAX_RPS: 7 s at 0.5 req/s', () => {
  const r = evaluateG1([report({ maxRps: 0.5, cells: [6.9] }), report({ maxRps: 0.5, cells: [6.5] })], 60)
  assert.deepEqual(check(r, 'cellPeriodP95S'), { name: 'cellPeriodP95S', value: 6.9, threshold: 7, pass: true })
})

test('no cell or chase data at all fails (value NaN)', () => {
  const r = evaluateG1([report({ cells: [], chase: null }), report({ cells: [null], chase: null })], 60)
  assert.ok(Number.isNaN(check(r, 'cellPeriodP95S').value))
  assert.equal(check(r, 'cellPeriodP95S').pass, false)
  assert.ok(Number.isNaN(check(r, 'chasePeriodP95S').value))
  assert.equal(check(r, 'chasePeriodP95S').pass, false)
})

test('chase period p95 above 1.5 s fails', () => {
  const r = evaluateG1([report({ chase: 1.2 }), report({ chase: 1.6 }), report({ chase: 1.1 })], 60)
  assert.deepEqual(check(r, 'chasePeriodP95S'), { name: 'chasePeriodP95S', value: 1.6, threshold: 1.5, pass: false })
})

test('average upstream rate: requestsTotal delta / seconds, allowed up to maxRps plus one burst', () => {
  const at = (requestsTotal: number): Result => evaluateG1([report({ requestsTotal: 100 }), report({ requestsTotal })], 3600)
  assert.equal(check(at(100 + 3600), 'avgUpstreamRps').value, 1)
  assert.equal(check(at(100 + 3602), 'avgUpstreamRps').pass, true)
  const over = check(at(100 + 3610), 'avgUpstreamRps')
  assert.equal(over.pass, false)
  assert.equal(over.threshold, 1 + 2 / 3600)
  assert.equal(check(evaluateG1([report({ maxRps: 0.5 }), report({ maxRps: 0.5, requestsTotal: 1900 })], 3600), 'avgUpstreamRps').pass, false)
})

test('needs at least two reports over a positive span', () => {
  assert.throws(() => evaluateG1([report()], 60), /2 reports/)
  assert.throws(() => evaluateG1([report(), report()], 0), /2 reports/)
})

// ---- CLI smoke test against a local fake /api/status (never the network) ----

const run = promisify(execFile)
const script = fileURLToPath(new URL('./gate-g1.ts', import.meta.url))

async function fakeStatus(
  make: (n: number) => StatusReport,
  firstDelayMs = 0,
): Promise<{ base: string; hits: () => number; close: () => Promise<void> }> {
  let n = 0
  const srv = createServer((req, res) => {
    if (req.url !== '/api/status') {
      res.writeHead(404).end()
      return
    }
    const i = n++
    const answer = (): void => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(make(i)))
    }
    if (i === 0 && firstDelayMs > 0) setTimeout(answer, firstDelayMs)
    else answer()
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    hits: () => n,
    close: () =>
      new Promise<void>((resolve) => {
        srv.closeAllConnections()
        srv.close(() => resolve())
      }),
  }
}

const cliArgs = (base: string, out: string): string[] => [script, '--base', base, '--minutes', '0.003', '--interval-ms', '40', '--out', out]

test('CLI polls /api/status, writes G1-<date>.json and exits 0 on pass', async () => {
  const fake = await fakeStatus(() => report())
  const out = mkdtempSync(join(tmpdir(), 'g1-pass-'))
  try {
    const { stdout } = await run(process.execPath, cliArgs(fake.base, out))
    const files = readdirSync(out)
    assert.equal(files.length, 1)
    assert.match(files[0], /^G1-\d{4}-\d{2}-\d{2}\.json$/)
    const written = JSON.parse(readFileSync(join(out, files[0]), 'utf8'))
    assert.equal(written.gate, 'G1')
    assert.equal(written.pass, true)
    assert.equal(written.checks.length, 5)
    assert.ok(written.reports >= 2, `reports=${written.reports}`)
    assert.ok(written.seconds > 0)
    assert.ok(fake.hits() >= 2)
    assert.match(stdout, /G1 PASS/)
  } finally {
    await fake.close()
  }
})

test('CLI exits 1 and records the failure when a 429 happens during the run', async () => {
  const fake = await fakeStatus((n) => report({ r429: n }))
  const out = mkdtempSync(join(tmpdir(), 'g1-fail-'))
  try {
    await assert.rejects(run(process.execPath, cliArgs(fake.base, out)), (e: { code?: number; stdout?: string }) => {
      assert.equal(e.code, 1)
      assert.match(e.stdout ?? '', /G1 FAIL/)
      return true
    })
    const written = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'))
    assert.equal(written.pass, false)
    assert.equal(written.checks[0].name, 'upstream4xx')
    assert.equal(written.checks[0].pass, false)
  } finally {
    await fake.close()
  }
})

test('CLI still takes a second report when the first answer arrives after the window', async () => {
  const fake = await fakeStatus(() => report(), 400) // the window is 0.003 min = 180 ms
  const out = mkdtempSync(join(tmpdir(), 'g1-slow-'))
  try {
    const { stdout } = await run(process.execPath, cliArgs(fake.base, out))
    const written = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'))
    assert.equal(written.reports, 2)
    assert.equal(written.pass, true)
    assert.match(stdout, /G1 PASS/)
  } finally {
    await fake.close()
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/gate-g1.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tools/gate-g1.ts' imported from …/tools/gate-g1.test.ts`, `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// tools/gate-g1.ts
// Gate G1 (PLAN.md §6): proves the running server kept to the upstream budget. It polls GET {base}/api/status
// every 10 s for --minutes, then scores the first/last reports and writes .planning/reports/G1-<YYYY-MM-DD>.json.
//
//   node tools/gate-g1.ts --base http://127.0.0.1:8787 --minutes 60 [--out .planning/reports]
//
// Exit code 0 = pass, 1 = fail.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { StatusReport } from '../shared/api.ts'

export interface G1Check {
  name: string
  value: number
  threshold: number
  pass: boolean
}

const BURST = 2 // server/budget.ts TokenBucket burst: a saturated bucket may exceed rate·T by this many requests

const fourxx = (r: StatusReport): number => r.budget.counts.r429 + r.budget.counts.r4xx

/** Largest non-null value; NaN when there is none (NaN never passes a check). */
function maxOf(xs: (number | null)[]): number {
  const v = xs.filter((x): x is number => x !== null)
  return v.length > 0 ? Math.max(...v) : NaN
}

/**
 * Scores status reports taken in order over `seconds` of wall time (first → last report).
 * Checks: no 429/4xx during the window; worst cell period p95 ≤ 3.5 s (scaled to 7 s at MAX_RPS 0.5);
 * worst chase period p95 ≤ 1.5 s; average upstream rate ≤ maxRps (+ one burst); bytes/hour reported.
 */
export function evaluateG1(reports: StatusReport[], seconds: number): { pass: boolean; checks: G1Check[] } {
  if (reports.length < 2 || !(seconds > 0)) throw new Error('evaluateG1 needs at least 2 reports over a positive number of seconds')
  const first = reports[0]
  const last = reports[reports.length - 1]
  const maxRps = last.budget.maxRps
  const check = (name: string, value: number, threshold: number): G1Check => ({ name, value, threshold, pass: value <= threshold })
  const checks = [
    check('upstream4xx', fourxx(last) - fourxx(first), 0),
    check('cellPeriodP95S', maxOf(reports.flatMap((r) => r.cells.map((c) => c.periodP95S))), 3.5 / Math.min(1, maxRps)),
    check('chasePeriodP95S', maxOf(reports.map((r) => r.chasePeriodP95S)), 1.5),
    check('avgUpstreamRps', (last.requestsTotal - first.requestsTotal) / seconds, maxRps + BURST / seconds),
    check('bytesPerHourEstimate', last.bytesPerHourEstimate, Infinity),
  ]
  return { pass: checks.every((c) => c.pass), checks }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://127.0.0.1:8787' },
      minutes: { type: 'string', default: '60' },
      out: { type: 'string', default: '.planning/reports' },
      'interval-ms': { type: 'string', default: '10000' }, // hidden: tests poll faster
    },
  })
  const minutes = Number(values.minutes)
  const intervalMs = Number(values['interval-ms'])
  if (!(minutes > 0) || !(intervalMs > 0)) throw new Error('--minutes and --interval-ms must be positive numbers')
  const endMs = Date.now() + minutes * 60_000
  const reports: StatusReport[] = []
  let firstMs = 0
  let lastMs = 0
  let extraPolls = 0
  for (;;) {
    try {
      const res = await fetch(`${values.base}/api/status`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      reports.push((await res.json()) as StatusReport)
      lastMs = Date.now()
      if (reports.length === 1) firstMs = lastMs
    } catch (e) {
      console.error(`${new Date().toISOString()} status poll failed: ${(e as Error).message}`)
    }
    const leftMs = endMs - Date.now()
    // A slow first answer (cold start, loaded machine) must not end the run with one report:
    // past the end, keep polling until there are two, but give up after 3 more tries.
    if (leftMs <= 0 && (reports.length >= 2 || ++extraPolls > 3)) break
    await new Promise((r) => setTimeout(r, leftMs > 0 ? Math.min(intervalMs, leftMs) : intervalMs))
  }

  const seconds = (lastMs - firstMs) / 1000
  const result = evaluateG1(reports, seconds)
  const now = new Date()
  mkdirSync(values.out, { recursive: true })
  const path = join(values.out, `G1-${now.toISOString().slice(0, 10)}.json`)
  // JSON has no Infinity/NaN: the bytes threshold (Infinity) and a missing metric (NaN) are written as null.
  const report = { gate: 'G1', date: now.toISOString(), base: values.base, seconds, reports: reports.length, ...result, last: reports[reports.length - 1] }
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n')
  for (const c of result.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name} = ${c.value} (≤ ${c.threshold})`)
  console.log(`G1 ${result.pass ? 'PASS' : 'FAIL'} → ${path}`)
  process.exitCode = result.pass ? 0 : 1
}

if (import.meta.main) await main()
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/gate-g1.test.ts`
Expected: PASS — `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`. The three CLI tests take ≈ 0.3–0.6 s each.

- [ ] **Step 5: Check the argument guard**

Run: `node tools/gate-g1.ts --minutes abc`
Expected: exits non-zero with `Error: --minutes and --interval-ms must be positive numbers` and makes no requests.

- [ ] **Step 6: Commit**

```bash
git add tools/gate-g1.ts tools/gate-g1.test.ts
git commit -m "feat(tools): gate G1 budget evaluator and status-polling CLI" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: WP gate

- [ ] **Step 1: All tests of this package**

Run: `node --test server/budget.test.ts tools/gate-g1.test.ts`
Expected: `ℹ tests 28`, `ℹ pass 28`, `ℹ fail 0`.

- [ ] **Step 2: Type-check, filtered to this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E '^(server/budget|tools/gate-g1)'`
Expected: no output (grep exit status 1).

- [ ] **Step 3: Full check in the worktree (WP-00 + this package)**

Run: `npm run check`
Expected: `tsc` silent; `ℹ tests 69`, `ℹ pass 69`, `ℹ fail 0` (41 WP-00 + 28 here).

- [ ] **Step 4: Nothing left uncommitted**

Run: `git status --short`
Expected: no output. The branch is ready to merge (PLAN.md §5 step 4).

The real Gate G1 run (`node tools/gate-g1.ts --minutes 60` against a live `npm run server` with `ADSB_SOURCE=adsblol MAX_RPS=0.5`) is part of PLAN.md §6, after WP-A1 merges. It is not part of this package.
