// client/scene/icons.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HALO_PX, ICON_ID, ICON_KINDS, ICON_PX, haloCanvas, iconCanvas, iconFor } from './icons.ts'
import type { IconKind } from './icons.ts'

// Node has no DOM: a canvas whose 2-D context records every call and property write.
type Call = [string, ...unknown[]]
interface FakeCanvas { width: number; height: number; calls: Call[]; getContext(kind: string): unknown }
const made: FakeCanvas[] = []
Object.assign(globalThis, {
  document: {
    createElement(tag: string): FakeCanvas {
      assert.equal(tag, 'canvas')
      const calls: Call[] = []
      const ctx = new Proxy({} as Record<string | symbol, unknown>, {
        get: (t, k) => (k in t ? t[k] : (...a: unknown[]) => void calls.push([String(k), ...a])),
        set: (t, k, v) => ((t[k] = v), calls.push(['set:' + String(k), v]), true),
      })
      const c: FakeCanvas = { width: 300, height: 150, calls, getContext: (kind) => (kind === '2d' ? ctx : null) }
      made.push(c)
      return c
    },
  },
})

test('iconFor: the ADS-B emitter category decides first', () => {
  const cases: [string, IconKind][] = [
    ['A1', 'light'], ['A2', 'jet'], ['A3', 'jet'], ['A4', 'jet'], ['A5', 'heavy'], ['A6', 'jet'], ['A7', 'heli'],
    ['B1', 'light'], ['B2', 'unknown'], ['B3', 'unknown'], ['B4', 'light'], ['B6', 'light'], ['B7', 'unknown'],
    ['C1', 'ground'], ['C2', 'ground'], ['C3', 'ground'], ['C4', 'ground'], ['C5', 'ground'],
  ]
  for (const [cat, kind] of cases) assert.equal(iconFor(cat, null), kind, cat)
  assert.equal(iconFor('A5', 'C172'), 'heavy', 'a broadcast category beats a fixed-wing type code')
  assert.equal(iconFor('A1', 'B77W'), 'light')
})

test('iconFor: without a useful category the ICAO type designator decides', () => {
  const cases: [string, IconKind][] = [
    ['B77W', 'heavy'], ['A388', 'heavy'], ['B789', 'heavy'], ['A359', 'heavy'], ['B744', 'heavy'], ['A332', 'heavy'], ['MD11', 'heavy'],
    ['B738', 'jet'], ['A320', 'jet'], ['A21N', 'jet'], ['E190', 'jet'], ['CRJ9', 'jet'], ['B752', 'jet'], ['C56X', 'jet'], ['ZZZZ', 'jet'],
    ['C172', 'light'], ['P28A', 'light'], ['SR22', 'light'], ['DA40', 'light'], ['AT76', 'light'], ['DH8D', 'light'], ['PC12', 'light'], ['BE20', 'light'],
    ['EC35', 'heli'], ['R44', 'heli'], ['A139', 'heli'], ['S76', 'heli'], ['AS50', 'heli'], ['H60', 'heli'],
  ]
  for (const [type, kind] of cases) {
    assert.equal(iconFor(null, type), kind, `${type} (no category)`)
    assert.equal(iconFor('A0', type), kind, `${type} (A0 = no information)`)
  }
  assert.equal(iconFor('B0', 'B738'), 'jet')
  assert.equal(iconFor('C0', 'B738'), 'jet')
  assert.equal(iconFor('D2', 'A388'), 'heavy', 'reserved categories fall back too')
})

test('iconFor: a helicopter type code wins even over a fixed-wing category (common transponder misconfiguration)', () => {
  assert.equal(iconFor('A1', 'R44'), 'heli')
  assert.equal(iconFor('A2', 'EC45'), 'heli')
})

test('iconFor: nothing known → unknown', () => {
  assert.equal(iconFor(null, null), 'unknown')
  assert.equal(iconFor('A0', null), 'unknown')
  assert.equal(iconFor('', ''), 'unknown')
})

test('iconCanvas: one canvas per kind, drawn once, ICON_PX square', () => {
  const before = made.length
  const canvases = ICON_KINDS.map((k) => iconCanvas(k))
  assert.equal(made.length - before, ICON_KINDS.length, 'one canvas per kind')
  assert.equal(new Set(canvases).size, ICON_KINDS.length)
  for (const k of ICON_KINDS) assert.equal(iconCanvas(k), canvases[ICON_KINDS.indexOf(k)], `${k}: same object every call`)
  assert.equal(made.length - before, ICON_KINDS.length, 'no redraws')
  for (const c of canvases) {
    assert.equal(c.width, ICON_PX)
    assert.equal(c.height, ICON_PX)
  }
  assert.ok(ICON_PX >= 32 && ICON_PX <= 40)
  assert.equal(new Set(Object.values(ICON_ID)).size, ICON_KINDS.length, 'distinct texture-atlas ids')
})

test('silhouettes: white fill and a dark outline (so the altitude tint shows), inside the canvas, nose up', () => {
  for (const k of ICON_KINDS) {
    const { calls } = iconCanvas(k) as unknown as FakeCanvas
    const sets = (name: string): unknown[] => calls.filter((c) => c[0] === 'set:' + name).map((c) => c[1])
    assert.ok(sets('fillStyle').includes('#fff'), `${k}: white fill`)
    assert.ok(sets('strokeStyle').some((s) => String(s).startsWith('rgba(0, 0, 0')), `${k}: dark outline`)
    assert.ok(calls.some((c) => c[0] === 'fill') && calls.some((c) => c[0] === 'stroke'), `${k}: filled and stroked`)
    const pts = calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo').map((c) => [c[1], c[2]] as [number, number])
    assert.ok(pts.length >= 3, `${k}: has an outline`)
    for (const [x, y] of pts) assert.ok(x >= 0 && x <= ICON_PX && y >= 0 && y <= ICON_PX, `${k}: (${x}, ${y}) inside`)
    if (k === 'heli' || k === 'ground') continue // heli: nose is the body ellipse (checked below); ground: symmetric box
    const top = pts.reduce((a, b) => (b[1] < a[1] ? b : a))
    assert.ok(Math.abs(top[0] - ICON_PX / 2) < 1e-9, `${k}: the frontmost point is on the centre line`)
    const bottom = Math.max(...pts.map((p) => p[1]))
    const halfWidth = (ys: [number, number][]): number => Math.max(...ys.map((p) => Math.abs(p[0] - ICON_PX / 2)))
    const nose = pts.filter((p) => p[1] <= top[1] + 0.12 * (bottom - top[1]))
    assert.ok(halfWidth(nose) < 0.25 * halfWidth(pts), `${k}: nose up (narrow at the top, not a tailplane)`)
  }
  const heli = (iconCanvas('heli') as unknown as FakeCanvas).calls
  assert.ok(heli.some((c) => c[0] === 'arc'), 'heli: rotor disc')
  assert.ok(heli.some((c) => c[0] === 'ellipse'), 'heli: body')
})

test('sizes differ by kind: heavy > jet > light > ground', () => {
  const span = (k: IconKind): number => {
    const ys = (iconCanvas(k) as unknown as FakeCanvas).calls.filter((c) => c[0] === 'lineTo').map((c) => c[2] as number)
    return Math.max(...ys) - Math.min(...ys)
  }
  assert.ok(span('heavy') > span('jet'))
  assert.ok(span('jet') > span('light'))
  assert.ok(span('light') > span('ground'))
})

test('haloCanvas: one ring, larger than a selected (1.4×) icon', () => {
  const a = haloCanvas()
  assert.equal(haloCanvas(), a)
  assert.equal(a.width, HALO_PX)
  assert.ok(HALO_PX > ICON_PX * 1.4)
  assert.ok((a as unknown as FakeCanvas).calls.some((c) => c[0] === 'arc'))
})
