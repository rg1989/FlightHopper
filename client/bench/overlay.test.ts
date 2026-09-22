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
