# WP-V8 — Bench Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The G3 bench instrument: per-frame timing, camera clearance, long tasks and heap for one chase, summarised as FPS p50/p5 and shown in a small on-screen text box (`?bench=1`). It downloads as a JSON `BenchReport`.

**Architecture:** One module, `client/bench/overlay.ts`. `summarizeFrames` is pure: p50 fps = 1000 / median frame ms, p5 fps = 1000 / p95 frame ms, and the percentile interpolates linearly between the closest ranks (the same definition as `tools/metrics.ts`, repeated in 6 lines because client code must not import `tools/`). `BenchRecorder.frame()` stores the `performance.now()` delta since the previous call, the minimum clearance, and the violations (clearance < `minClearanceM`, default 15). A `PerformanceObserver({ type: 'longtask' })` counts tasks of ≥ 50 ms from construction on, where the entry type is supported (Chromium). `heapMB` comes from the non-standard, Chromium-only `performance.memory.usedJSHeapSize` at report time. **Unknown numbers are NaN (JSON null) or null, never 0**: on Safari and Firefox, which lack the Long Tasks API, `longTasks` is NaN, so the G3 "long tasks: 0" bar cannot pass by accident. `download()` writes `report()` through a `Blob` and a temporary `<a download>`. `mountOverlay()` appends a fixed-position `<pre>` and refreshes it at 2 Hz. It summarises only the last 120 frames (≈ 2 s), so the overlay reads "now" and never sorts the whole run. The run-wide numbers come from `report()`. The viewer is used only for the canvas size shown in the overlay. Browser-only APIs are touched only inside the methods that need them and are feature-checked, so importing the module in node is safe (the test does exactly that). Extra exports beyond the contract: `overlayText(report, state, canvas?)` (the pure formatter, unit-tested) and `BenchRecorder.destroy()` (disconnect the observer, stop the timer, remove the box; for WP-A2's `stop()`).

**Tech Stack:** TypeScript 7 (type-check only), browser APIs (`performance.now`, `PerformanceObserver`, `Blob`, `URL.createObjectURL`), a type-only import of `Viewer` from `cesium` 1.145 (erased at runtime). `node:test` for the pure parts. No new dependencies.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 45 min. **Validated:** every file below was run in a sandbox copy of the Wave 0 tree on 2026-09-22 (Node v25.2.1, TypeScript 7.0.2). The test was run before the module existed and failed with `ERR_MODULE_NOT_FOUND`. After the implementation, `node --test client/bench/overlay.test.ts` → 7/7 pass, and `npx tsc --noEmit` reports no errors in `client/bench/*`. As supporting evidence, the module was also loaded through the Vite 8 dev server in Chromium 152. There, 120 animation frames gave fps p50 59.9 and p5 56.0. One injected 120 ms busy loop was counted as `longTasks 1`, `longTaskMsMax 122`. `heapMB` read ≈ 87. A 9 m clearance counted as 1 violation. The overlay text refreshed. `download()` produced `bench-probe-<ISO>.json` from a `blob:` URL whose JSON equals `report()`, and `destroy()` removed the box. The anchor click was intercepted, so no file was saved.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. The ones this package relies on:
- Erasable TypeScript only (`#private` fields, no parameter properties), `.ts` extensions on relative imports, `import type` for Cesium so node can import the module.
- Tests: `node:test` + `node:assert/strict`, next to the code, no network, no DOM (node has no `document`, no `performance.memory` and no `'longtask'` entry type, which the test uses to check the "unknown" paths).
- No harness page: WP-A2 wires the recorder into the app (`?bench=1`).

**Notes for WP-A2 (the consumer):** create `new BenchRecorder(viewer, { label })` once. Call `frame(state, clearanceM)` once per rendered frame, after `ChaseCamera.update()`, with its `clearanceM`. Call `mountOverlay(document.body)` when `?bench=1` is set. Give the user a way to call `download()` (a key or a button). Call `destroy()` in `stop()`.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/bench/overlay.ts` | `BenchReport`, `summarizeFrames`, `BenchRecorder` (+ extras `overlayText`, `destroy()`) |
| `client/bench/overlay.test.ts` | FPS summary math, node-safe recorder counts, "unknown" semantics, overlay text |

---

### Task 1: Bench recorder and overlay

**Files:**
- Create: `client/bench/overlay.ts`, `client/bench/overlay.test.ts`
- Test: `client/bench/overlay.test.ts`

**Interfaces:**
- Consumes: `RenderState` from `client/types.ts` (WP-00); `Viewer` type from `cesium`
- Produces: `interface BenchReport { label: string; frames: number; fpsP50: number; fpsP5: number; frameMsP95: number; longTasks: number; longTaskMsMax: number; minClearanceM: number | null; clearanceViolations: number; heapMB: number | null }` · `summarizeFrames(frameMs: number[]): { fpsP50: number; fpsP5: number; frameMsP95: number }` · `class BenchRecorder { constructor(viewer: Viewer, opts?: { label?: string; minClearanceM?: number }); frame(state: RenderState | null, clearanceM: number | null): void; report(): BenchReport; download(filename?: string): void; mountOverlay(root: HTMLElement): void; destroy(): void }` · `overlayText(r: BenchReport, state: RenderState | null, canvas?: { width: number; height: number }): string`

- [ ] **Step 1: Write the failing test**

```ts
// client/bench/overlay.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Viewer } from 'cesium'
import { BenchRecorder, overlayText, summarizeFrames } from './overlay.ts'
import type { BenchReport } from './overlay.ts'
import type { RenderState } from '../types.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const noViewer = {} as Viewer

test('summarizeFrames: steady 60 Hz', () => {
  const s = summarizeFrames(Array.from({ length: 600 }, () => 1000 / 60))
  near(s.fpsP50, 60, 1e-9)
  near(s.fpsP5, 60, 1e-9)
  near(s.frameMsP95, 1000 / 60, 1e-9)
})

test('summarizeFrames: p50 fps = 1000 / median ms, p5 fps = 1000 / p95 ms, input untouched', () => {
  const ms = [...Array.from({ length: 10 }, () => 40), ...Array.from({ length: 90 }, () => 16)]
  const s = summarizeFrames(ms)
  near(s.fpsP50, 62.5, 1e-9)
  near(s.frameMsP95, 40, 1e-9, 'rank 0.95·99 = 94.05 sits inside the ten 40 ms frames')
  near(s.fpsP5, 25, 1e-9)
  assert.equal(ms[0], 40)
  const mixed = summarizeFrames([10, 20, 30, 40])
  near(mixed.fpsP50, 1000 / 25, 1e-9, 'median interpolates linearly: 25 ms')
  near(mixed.frameMsP95, 38.5, 1e-9)
})

test('summarizeFrames: no frames → NaN (JSON null), not a passing number', () => {
  const s = summarizeFrames([])
  assert.ok(Number.isNaN(s.fpsP50) && Number.isNaN(s.fpsP5) && Number.isNaN(s.frameMsP95))
})

test('BenchRecorder in node: counts frames and clearance; browser-only numbers are unknown', () => {
  const b = new BenchRecorder(noViewer)
  for (const c of [100, 20, 14, null, 3]) b.frame(null, c)
  const r: BenchReport = b.report()
  assert.equal(r.label, 'bench')
  assert.equal(r.frames, 5)
  assert.equal(r.minClearanceM, 3)
  assert.equal(r.clearanceViolations, 2, 'below the default 15 m: 14 and 3')
  assert.equal(r.heapMB, null, 'performance.memory is Chromium-only')
  assert.ok(Number.isNaN(r.longTasks) && Number.isNaN(r.longTaskMsMax), 'no Long Tasks API in node → unknown, not 0')
  assert.ok(r.frameMsP95 >= 0)
  assert.deepEqual(JSON.parse(JSON.stringify(r)).longTasks, null)
  b.destroy()
})

test('BenchRecorder: label and clearance threshold are options; no clearance seen → null', () => {
  const b = new BenchRecorder(noViewer, { label: 'ksfo-28l', minClearanceM: 25 })
  for (const c of [100, 20, 14, 3]) b.frame(null, c)
  assert.equal(b.report().label, 'ksfo-28l')
  assert.equal(b.report().clearanceViolations, 3)
  const none = new BenchRecorder(noViewer)
  none.frame(null, null)
  none.frame(null, null)
  assert.equal(none.report().minClearanceM, null)
  assert.equal(none.report().clearanceViolations, 0)
})

test('BenchRecorder.download needs a DOM', () => {
  assert.throws(() => new BenchRecorder(noViewer).download(), /DOM/)
})

test('overlayText: one line per fact; unknowns print n/a', () => {
  const r: BenchReport = {
    label: 'ksfo', frames: 1234, fpsP50: 59.94, fpsP5: 31.2, frameMsP95: 32.06, longTasks: NaN, longTaskMsMax: NaN,
    minClearanceM: null, clearanceViolations: 0, heapMB: null,
  }
  const state = { hex: '71bd79', mode: 'interp', altBaroFt: 3000, onGround: false } as RenderState
  assert.equal(
    overlayText(r, state, { width: 1920, height: 1080 }),
    [
      'bench ksfo · 1234 frames · 1920×1080 px',
      'fps p50 59.9 · p5 31.2 · frame p95 32.1 ms',
      'long tasks n/a · max n/a ms',
      'clearance min n/a m · violations 0',
      'heap n/a MB',
      '71bd79 interp 3000 ft',
    ].join('\n'),
  )
  const full = overlayText({ ...r, longTasks: 2, longTaskMsMax: 87.4, minClearanceM: 212.46, clearanceViolations: 1, heapMB: 301.7 }, null)
  assert.match(full, /^bench ksfo · 1234 frames$/m)
  assert.match(full, /long tasks 2 · max 87 ms/)
  assert.match(full, /clearance min 212 m · violations 1/)
  assert.match(full, /heap 302 MB/)
  assert.match(full, /no aircraft$/)
  assert.match(overlayText(r, { ...state, onGround: true, altBaroFt: null }), /71bd79 interp ground$/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/bench/overlay.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/bench/overlay.ts'`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation**

```ts
// client/bench/overlay.ts
/**
 * G3 bench: frame timing, camera clearance, long tasks and heap for one chase, shown as a small text overlay
 * (?bench=1, wired by WP-A2) and downloadable as JSON. Browser-only APIs are touched only inside methods that
 * need them and are feature-checked, so importing this module in node is safe.
 * Unknown numbers are NaN (JSON null), never 0: a Safari run cannot pass the "long tasks: 0" bar by accident.
 */
import type { Viewer } from 'cesium'
import type { RenderState } from '../types.ts'

export interface BenchReport {
  label: string
  frames: number
  fpsP50: number
  fpsP5: number
  frameMsP95: number
  longTasks: number                             // NaN where the Long Tasks API is missing (Safari, Firefox)
  longTaskMsMax: number                         // 0 with no long task; NaN where unsupported
  minClearanceM: number | null                  // null until a clearance was reported
  clearanceViolations: number                   // frames with clearance < minClearanceM
  heapMB: number | null                         // performance.memory.usedJSHeapSize (Chromium only) at report time
}

/**
 * Percentile by linear interpolation between closest ranks (rank = p/100 · (n − 1)); empty → NaN.
 * Same definition as tools/metrics.ts `percentile`, repeated because client code must not import tools/.
 */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = xs.toSorted((a, b) => a - b)
  const r = (p / 100) * (s.length - 1)
  const lo = Math.floor(r)
  return s[lo] + (r - lo) * (s[Math.ceil(r)] - s[lo])
}

/** Frame times (ms) → p50 fps = 1000 / median ms, p5 fps = 1000 / p95 ms (the slow tail), and p95 ms. Empty → NaN. */
export function summarizeFrames(frameMs: number[]): { fpsP50: number; fpsP5: number; frameMsP95: number } {
  const p95 = percentile(frameMs, 95)
  return { fpsP50: 1000 / percentile(frameMs, 50), fpsP5: 1000 / p95, frameMsP95: p95 }
}

const num = (x: number | null, digits: number): string => (x === null || Number.isNaN(x) ? 'n/a' : x.toFixed(digits))

/** The overlay's text: one line per fact, unknown values as n/a. */
export function overlayText(r: BenchReport, state: RenderState | null, canvas?: { width: number; height: number }): string {
  const alt = state?.onGround ? 'ground' : `${num(state?.altBaroFt ?? null, 0)} ft`
  return [
    `bench ${r.label} · ${r.frames} frames${canvas ? ` · ${canvas.width}×${canvas.height} px` : ''}`,
    `fps p50 ${num(r.fpsP50, 1)} · p5 ${num(r.fpsP5, 1)} · frame p95 ${num(r.frameMsP95, 1)} ms`,
    `long tasks ${num(r.longTasks, 0)} · max ${num(r.longTaskMsMax, 0)} ms`,
    `clearance min ${num(r.minClearanceM, 0)} m · violations ${r.clearanceViolations}`,
    `heap ${num(r.heapMB, 0)} MB`,
    state ? `${state.hex} ${state.mode} ${alt}` : 'no aircraft',
  ].join('\n')
}

/** Frames the overlay summarises: about 2 s at 60 Hz, so its fps reads "now", not the whole run. */
const RECENT_FRAMES = 120

export class BenchRecorder {
  #viewer: Viewer
  #label: string
  #minClearanceM: number
  // ponytail: every frame time is kept (≈ 1.7 MB per hour at 60 Hz) and report() sorts them all. Fine for bench
  // runs of minutes to hours; for day-long soaks switch to a fixed 0.1 ms histogram.
  #frameMs: number[] = []
  #frames = 0
  #lastMs: number | null = null
  #minClearance: number | null = null
  #violations = 0
  #longTasks = 0
  #longTaskMsMax = 0
  #observer: PerformanceObserver | null = null
  #state: RenderState | null = null
  #overlay: HTMLElement | null = null
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(viewer: Viewer, opts?: { label?: string; minClearanceM?: number }) {
    this.#viewer = viewer
    this.#label = opts?.label ?? 'bench'
    this.#minClearanceM = opts?.minClearanceM ?? 15
    // Long tasks (≥ 50 ms on the main thread) from now on; Chromium only. Unsupported → the report says NaN.
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      this.#observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.#longTasks++
          this.#longTaskMsMax = Math.max(this.#longTaskMsMax, e.duration)
        }
      })
      this.#observer.observe({ type: 'longtask' })
    }
  }

  /** Call once per rendered frame with the chased state and ChaseCamera.update()'s clearance (null = unknown). */
  frame(state: RenderState | null, clearanceM: number | null): void {
    const now = performance.now()
    if (this.#lastMs !== null) this.#frameMs.push(now - this.#lastMs)
    this.#lastMs = now
    this.#frames++
    this.#state = state
    if (clearanceM === null) return
    if (this.#minClearance === null || clearanceM < this.#minClearance) this.#minClearance = clearanceM
    if (clearanceM < this.#minClearanceM) this.#violations++
  }

  report(): BenchReport {
    return this.#build(this.#frameMs)
  }

  /** Save report() as JSON through a Blob and a temporary <a download>. Throws outside a DOM. */
  download(filename?: string): void {
    if (typeof document === 'undefined') throw new Error('BenchRecorder.download() needs a DOM')
    const name = filename ?? `bench-${this.#label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.report(), null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  /** A small fixed-position text box, refreshed at 2 Hz, summarising the last ~2 s of frames. Mount once. */
  mountOverlay(root: HTMLElement): void {
    const el = document.createElement('pre')
    el.style.cssText =
      'position:fixed;top:8px;left:8px;z-index:10;margin:0;padding:6px 8px;border-radius:4px;pointer-events:none;' +
      'font:12px/1.35 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.6)'
    root.append(el)
    const tick = (): void => {
      const c = this.#viewer.canvas
      el.textContent = overlayText(this.#build(this.#frameMs.slice(-RECENT_FRAMES)), this.#state, { width: c.width, height: c.height })
    }
    tick()
    this.#overlay = el
    this.#timer = setInterval(tick, 500)
  }

  /** Stop observing long tasks and remove the overlay. report() still works afterwards. */
  destroy(): void {
    this.#observer?.disconnect()
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#overlay?.remove()
    this.#timer = null
    this.#overlay = null
  }

  #build(frameMs: number[]): BenchReport {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    return {
      label: this.#label,
      frames: this.#frames,
      ...summarizeFrames(frameMs),
      longTasks: this.#observer ? this.#longTasks : NaN,
      longTaskMsMax: this.#observer ? this.#longTaskMsMax : NaN,
      minClearanceM: this.#minClearance,
      clearanceViolations: this.#violations,
      heapMB: memory ? memory.usedJSHeapSize / 2 ** 20 : null,
    }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/bench/overlay.test.ts`
Expected: PASS — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/bench/overlay.ts client/bench/overlay.test.ts
git commit -m "feat(bench): frame/clearance/long-task recorder with 2 Hz overlay and JSON download" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: WP gate

- [ ] **Step 1: Run every test this package owns**

Run: `node --test client/bench/overlay.test.ts`
Expected: `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/bench'`
Expected: no output (grep exits 1). On a branch where every merged package is complete, `npm run check` must also pass.

- [ ] **Step 3: Confirm everything is committed and record the gate**

```bash
git status --short -- client/bench
git commit --allow-empty -m "chore(bench): WP-V8 gate passed (7 tests, tsc clean)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `git status` prints nothing before the commit. The branch `wp/V8` is ready to merge.
