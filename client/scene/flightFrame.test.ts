// client/scene/flightFrame.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { ReadsbAircraft } from '../../shared/types.ts'
import type { FlightData, RenderState } from '../types.ts'
import type { BlockId, BlockView, Rect, Square } from './flightFrame.ts'
import { MIN_PX } from './traffic.ts'

// flightFrame.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { fieldText, formatBlocks, frameLayout, isEmpty, liveFlightData, rowText } = await import('./flightFrame.ts')

type Sizes = Record<BlockId, { w: number; h: number }>
type Placed = Record<BlockId, { x: number; y: number }>
const IDS: readonly BlockId[] = ['left', 'right', 'top', 'bottom']
const SIZES: Sizes = { left: { w: 96, h: 58 }, right: { w: 88, h: 64 }, top: { w: 170, h: 28 }, bottom: { w: 196, h: 44 } }
const SAFE: Rect = { x: 0, y: 0, w: 1280, h: 800 }
const ZERO = { w: 0, h: 0 }

const shown = (sizes: Sizes): BlockId[] => IDS.filter((id) => sizes[id].w > 0 && sizes[id].h > 0)
const inside = (p: Placed, sizes: Sizes, safe: Rect): void => {
  for (const id of shown(sizes)) {
    const { x, y } = p[id]
    const { w, h } = sizes[id]
    const msg = `${id} at ${x},${y} ${w}×${h} in ${JSON.stringify(safe)}`
    assert.ok(x >= safe.x - 1e-9 && y >= safe.y - 1e-9 && x + w <= safe.x + safe.w + 1e-9 && y + h <= safe.y + safe.h + 1e-9, msg)
  }
}
/** Every pair of shown blocks is apart by at least `gap` along x or along y (so never overlapping). */
const apart = (p: Placed, sizes: Sizes, gap: number, ctx = ''): void => {
  const ids = shown(sizes)
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]
      const b = ids[j]
      const dx = Math.max(p[b].x - (p[a].x + sizes[a].w), p[a].x - (p[b].x + sizes[b].w))
      const dy = Math.max(p[b].y - (p[a].y + sizes[a].h), p[a].y - (p[b].y + sizes[b].h))
      assert.ok(dx >= gap - 1e-9 || dy >= gap - 1e-9, `${a} and ${b} closer than ${gap} (dx ${dx}, dy ${dy}) ${ctx}`)
    }
  }
}

test('frameLayout: a mid-size square: each block hugs its side at the gap, centred on it', () => {
  const sq: Square = { x: 640, y: 400, side: 120 }
  const p = frameLayout(sq, SIZES, SAFE)
  assert.deepEqual(p.left, { x: 640 - 60 - 10 - 96, y: 400 - 29 })
  assert.deepEqual(p.right, { x: 640 + 60 + 10, y: 400 - 32 })
  assert.deepEqual(p.top, { x: 640 - 85, y: 400 - 60 - 10 - 28 })
  assert.deepEqual(p.bottom, { x: 640 - 98, y: 400 + 60 + 10 })
})

test('frameLayout: the gap is a parameter', () => {
  const p = frameLayout({ x: 640, y: 400, side: 120 }, SIZES, SAFE, 4)
  assert.equal(p.left.x + SIZES.left.w, 640 - 60 - 4)
  assert.equal(p.right.x, 640 + 60 + 4)
  assert.equal(p.top.y + SIZES.top.h, 400 - 60 - 4)
  assert.equal(p.bottom.y, 400 + 60 + 4)
})

test('frameLayout: a tiny square: the sides stay on it, the top and bottom go out past them', () => {
  const p = frameLayout({ x: 640, y: 400, side: MIN_PX }, SIZES, SAFE)
  assert.deepEqual(p.left, { x: 640 - 12 - 10 - 96, y: 400 - 29 })
  assert.deepEqual(p.right, { x: 640 + 12 + 10, y: 400 - 32 })
  // The top block is wider than the square: it would sit on the side blocks, so it rises above the taller one.
  assert.deepEqual(p.top, { x: 640 - 85, y: 400 - 32 - 10 - 28 })
  assert.deepEqual(p.bottom, { x: 640 - 98, y: 400 + 32 + 10 })
  apart(p, SIZES, 10)
})

test('frameLayout: a square near each edge: every block is clamped inside the safe area', () => {
  const safe: Rect = { x: 0, y: 40, w: 1216, h: 660 } // the rail on the right, a play bar at the bottom
  const cases: Array<[string, Square]> = [
    ['left', { x: 20, y: 370, side: 80 }],
    ['right', { x: 1200, y: 370, side: 80 }],
    ['top', { x: 608, y: 50, side: 80 }],
    ['bottom', { x: 608, y: 690, side: 80 }],
    ['top-left corner', { x: 5, y: 45, side: MIN_PX }],
    ['bottom-right corner', { x: 1210, y: 695, side: MIN_PX }],
  ]
  for (const [name, sq] of cases) {
    const p = frameLayout(sq, SIZES, safe)
    inside(p, SIZES, safe)
    apart(p, SIZES, 10, name)
  }
  assert.equal(frameLayout(cases[0][1], SIZES, safe).left.x, 0, 'pressed against the left edge')
  assert.equal(frameLayout(cases[1][1], SIZES, safe).right.x, 1216 - SIZES.right.w, 'pressed against the right edge')
  assert.equal(frameLayout(cases[2][1], SIZES, safe).top.y, 40, 'pressed against the top edge')
  assert.equal(frameLayout(cases[3][1], SIZES, safe).bottom.y, 700 - SIZES.bottom.h, 'pressed against the bottom edge')
})

test('frameLayout: a square larger than the safe area: the blocks pin to its edges', () => {
  const safe: Rect = { x: 10, y: 20, w: 1200, h: 700 }
  const p = frameLayout({ x: 610, y: 370, side: 1400 }, SIZES, safe)
  assert.equal(p.left.x, 10)
  assert.equal(p.right.x + SIZES.right.w, 1210)
  assert.equal(p.top.y, 20)
  assert.equal(p.bottom.y + SIZES.bottom.h, 720)
  assert.equal(p.left.y, 370 - 29, 'the sides stay centred on the square')
  assert.equal(p.top.x, 610 - 85, 'the top stays centred on the square')
  // Larger in one dimension only (a phone held upright): the sides pin, the top and bottom still hug the square.
  const phone: Rect = { x: 0, y: 0, w: 375, h: 700 }
  const q = frameLayout({ x: 187, y: 350, side: 420 }, SIZES, phone)
  assert.equal(q.left.x, 0)
  assert.equal(q.right.x + SIZES.right.w, 375)
  assert.equal(q.top.y + SIZES.top.h, 350 - 210 - 10)
  assert.equal(q.bottom.y, 350 + 210 + 10)
})

test('frameLayout: a hidden block (0 × 0) moves nothing', () => {
  // Near the top edge the top block has no room above the sides, so it pushes them down; hidden, it does not.
  const sq: Square = { x: 640, y: 30, side: MIN_PX }
  const pushed = frameLayout(sq, SIZES, SAFE)
  assert.equal(pushed.top.y, 0)
  assert.equal(pushed.left.y, 28 + 10)
  const p = frameLayout(sq, { ...SIZES, top: ZERO }, SAFE)
  assert.equal(p.left.y, 30 - 29)
  assert.equal(p.right.y, 0) // 30 − 32 clamped
})

test('frameLayout: 200 random cases: every block inside the safe area, no two closer than the gap', () => {
  let seed = 0x5eed1985
  const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const between = (a: number, b: number): number => a + (b - a) * rnd()
  const size = (w0: number, w1: number, h0: number, h1: number): { w: number; h: number } =>
    rnd() < 0.15 ? ZERO : { w: Math.round(between(w0, w1)), h: Math.round(between(h0, h1)) }
  for (let i = 0; i < 200; i++) {
    // Room for the four blocks (the phone is the smallest: 375 wide, under 812 minus bars); blocks of the sizes they take.
    const safe: Rect = { x: between(0, 200), y: between(0, 150), w: between(340, 1900), h: between(420, 1100) }
    const sizes: Sizes = {
      left: size(70, 130, 40, 80),
      right: size(70, 120, 40, 90),
      top: size(90, 220, 22, 34),
      bottom: size(120, 240, 30, 50),
    }
    const side = Math.exp(between(Math.log(MIN_PX), Math.log(3000)))
    const sq: Square = { x: between(safe.x - side / 2, safe.x + safe.w + side / 2), y: between(safe.y - side / 2, safe.y + safe.h + side / 2), side }
    const gap = rnd() < 0.5 ? 10 : Math.round(between(2, 16))
    const p = frameLayout(sq, sizes, safe, gap)
    const ctx = `case ${i}: ${JSON.stringify({ sq, sizes, safe, gap })}`
    inside(p, sizes, safe)
    apart(p, sizes, gap, ctx)
  }
})

// ---- liveFlightData -------------------------------------------------------------------------------------------------

// An Aegean A320 descending towards Tel Aviv (as flightCard.test), with the Mode S fields the EHS reply adds.
const S: RenderState = {
  hex: '4691c4', lat: 32.371902, lon: 34.43291, hM: 2620, headingDeg: 105.24, pitchDeg: -1.5, rollDeg: 0.5, gsKt: 337.1,
  trackDeg: 101.81, altBaroFt: 7975, vsFpm: -951, mode: 'interp', altSource: 'geom', onGround: false, ageS: -0.8,
  quality: 'adsb2', callsign: 'AEE4266', typeCode: 'A320',
}
const RAW: ReadsbAircraft = {
  hex: '4691c4', flight: 'AEE4266 ', alt_baro: 7975, gs: 337.1, track: 101.81, baro_rate: -960, ias: 268, true_heading: 99.5,
  roll: -2.1, wd: 281, ws: 22,
}
const plain = (d: FlightData): object => ({ ...d, derived: [...d.derived].sort() })

test('liveFlightData: the render state and the ADS-B reply map onto the frame; pitch, g, gear, flaps and EPR are not broadcast', () => {
  assert.deepEqual(plain(liveFlightData(S, RAW, 7400)), {
    altFt: 7975, aglFt: 7400, vsFpm: -951, iasKt: 268, gsKt: 337.1, hdgDeg: 99.5, trackDeg: 101.81, pitchDeg: null,
    rollDeg: -2.1, g: null, windFromDeg: 281, windKt: 22, gear: null, flaps: null, epr: null, derived: ['aglFt'],
  })
})

test('liveFlightData: no reply: the reply fields are null, and roll is never the synthesised one', () => {
  assert.deepEqual(plain(liveFlightData(S, null, null)), {
    altFt: 7975, aglFt: null, vsFpm: -951, iasKt: null, gsKt: 337.1, hdgDeg: null, trackDeg: 101.81, pitchDeg: null,
    rollDeg: null, g: null, windFromDeg: null, windKt: null, gear: null, flaps: null, epr: null, derived: [],
  })
  const bare = liveFlightData(S, { hex: '4691c4', alt_baro: 7975 }, null)
  assert.equal(bare.rollDeg, null, 'roll only when broadcast')
  assert.equal(bare.iasKt, null)
  assert.equal(bare.windKt, null)
})

// ---- formatBlocks ---------------------------------------------------------------------------------------------------

const NONE: FlightData = {
  altFt: null, aglFt: null, vsFpm: null, iasKt: null, gsKt: null, hdgDeg: null, trackDeg: null, pitchDeg: null,
  rollDeg: null, g: null, windFromDeg: null, windKt: null, gear: null, flaps: null, epr: null, derived: new Set(),
}
const FULL: FlightData = {
  altFt: 12_304, aglFt: 11_846, vsFpm: 1_497, iasKt: 280.4, gsKt: 309.6, hdgDeg: 250.2, trackDeg: 254, pitchDeg: 9.2,
  rollDeg: 38.3, g: 1.84, windFromDeg: 220, windKt: 16.2, gear: 'down', flaps: 10, epr: [1.5, 1.45, NaN, 2.4],
  derived: new Set(),
}
const texts = (v: BlockView): string[] => v.rows.map(rowText)

test('formatBlocks: every block of a full record', () => {
  const b = formatBlocks(FULL)
  assert.deepEqual(texts(b.left), ['12,300 ft', 'AGL 11,850 ft', '↑ 1,500 fpm'])
  assert.equal(b.left.rows[0][0].big, true, 'the altitude is the large figure')
  assert.deepEqual(texts(b.right), ['IAS 280 kt', 'GS 310 kt'])
  assert.deepEqual(b.right.bars?.bars, [
    { label: '1', frac: 0.5 }, { label: '2', frac: 0.45 }, { label: '3', frac: null }, { label: '4', frac: 1 },
  ])
  assert.deepEqual(b.top.rows[0].map(fieldText), ['HDG 250°', '220°/16 kt'])
  assert.equal(b.top.wind?.deg, -30, 'the wind comes from 30° left of the nose')
  assert.deepEqual(texts(b.bottom), ['Bank 38° R · Pitch +9°', '1.8 g'])
  assert.deepEqual(b.bottom.chips.map((c) => c.text), ['GEAR DN', 'FLAPS 10'])
  const hz = b.bottom.horizon!
  assert.equal(hz.rotDeg, -38.3, 'the horizon turns against the bank')
  assert.ok(Math.abs(hz.offsetPx - 9.2 * 0.6) < 1e-9, 'and drops 0.6 px per degree of nose-up pitch')
  for (const id of IDS) assert.equal(isEmpty(b[id]), false, id)
})

test('formatBlocks: signs and sides: descent arrow, left bank, nose down, below sea level', () => {
  const b = formatBlocks({ ...FULL, altFt: -1_302, vsFpm: -2_344, rollDeg: -12.4, pitchDeg: -3.4, g: 0.62 })
  assert.deepEqual(texts(b.left)[0], '−1,300 ft')
  assert.deepEqual(texts(b.left)[2], '↓ 2,340 fpm')
  assert.deepEqual(texts(b.bottom), ['Bank 12° L · Pitch −3°', '0.6 g'])
  assert.equal(b.bottom.horizon!.rotDeg, 12.4)
  assert.ok(b.bottom.horizon!.offsetPx < 0, 'nose down: the horizon rises')
})

test('formatBlocks: level: no arrow within 50 fpm, no side at wings level, no sign at zero pitch', () => {
  const b = formatBlocks({ ...FULL, vsFpm: -42, rollDeg: 0.3, pitchDeg: -0.2, altFt: 1_234_567 })
  assert.equal(texts(b.left)[0], '1,234,570 ft')
  assert.equal(texts(b.left)[2], '0 fpm')
  assert.equal(texts(b.bottom)[0], 'Bank 0° · Pitch 0°')
})

test('formatBlocks: the wind arrow is windFrom − heading, the short way round', () => {
  const deg = (windFromDeg: number, hdgDeg: number): number | undefined => formatBlocks({ ...FULL, windFromDeg, hdgDeg }).top.wind?.deg
  assert.equal(deg(10, 350), 20)
  assert.equal(deg(350, 10), -20)
  assert.equal(deg(190, 10), 180)
  assert.equal(deg(250, 250), 0, 'a headwind points from the nose')
  assert.equal(deg(70, 250), 180, 'a tailwind from the tail')
})

test('formatBlocks: heading and wind in three figures, north as 360', () => {
  const b = formatBlocks({ ...FULL, hdgDeg: 5.4, windFromDeg: 359.7, windKt: 8 })
  assert.deepEqual(b.top.rows[0].map(fieldText), ['HDG 005°', '360°/8 kt'])
})

test('formatBlocks: no heading: the track names the top block and steers the dial, dimmed as an estimate', () => {
  const b = formatBlocks({ ...FULL, hdgDeg: null, trackDeg: 256 })
  assert.deepEqual(b.top.rows[0].map(fieldText), ['TRK 256°', '220°/16 kt'])
  assert.deepEqual(b.top.wind, { deg: -36, est: true })
})

test('formatBlocks: a calm wind has no arrow', () => {
  const b = formatBlocks({ ...FULL, windKt: 0.4 })
  assert.deepEqual(b.top.rows[0].map(fieldText), ['HDG 250°', 'Calm'])
  assert.equal(b.top.wind, null)
})

test('formatBlocks: estimates (derived) are flagged per field', () => {
  const b = formatBlocks({ ...FULL, derived: new Set<keyof FlightData>(['aglFt', 'iasKt', 'pitchDeg', 'gear']) })
  const est = (v: BlockView): boolean[] => v.rows.flat().map((f) => f.est)
  assert.deepEqual(est(b.left), [false, true, false])
  assert.deepEqual(est(b.right), [true, false])
  assert.deepEqual(est(b.bottom), [false, true, false])
  assert.deepEqual(b.bottom.chips.map((c) => c.est), [true, false])
  assert.equal(b.bottom.horizon!.est, true, 'the glyph dims with either of its angles')
})

test('formatBlocks: live ADS-B: no EPR bars, bank without pitch, the horizon dimmed (its pitch is unknown)', () => {
  const b = formatBlocks(liveFlightData(S, RAW, 7400))
  assert.deepEqual(texts(b.left), ['7,980 ft', 'AGL 7,400 ft', '↓ 950 fpm'])
  assert.deepEqual(texts(b.right), ['IAS 268 kt', 'GS 337 kt'])
  assert.equal(b.right.bars, null)
  assert.deepEqual(texts(b.bottom), ['Bank 2° L'])
  assert.deepEqual(b.bottom.chips, [])
  assert.equal(b.bottom.horizon!.est, true)
  assert.equal(b.bottom.horizon!.offsetPx, 0)
})

test('formatBlocks: gear up and flaps up show no chips; a block with nothing to show is empty', () => {
  const b = formatBlocks({ ...NONE, altFt: 3000, gear: 'up', flaps: 0 })
  assert.deepEqual(b.bottom.chips, [])
  assert.equal(isEmpty(b.left), false)
  for (const id of ['right', 'top', 'bottom'] as const) assert.equal(isEmpty(b[id]), true, id)
  const none = formatBlocks(NONE)
  for (const id of IDS) assert.equal(isEmpty(none[id]), true, id)
})
