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
