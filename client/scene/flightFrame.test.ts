// client/scene/flightFrame.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { ReadsbAircraft } from '../../shared/types.ts'
import type { FlightData, RenderState } from '../types.ts'
import type { BlockId, BlockSize, Placed, Rect, Square } from './flightFrame.ts'
import { MIN_PX } from './traffic.ts'

// flightFrame.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const {
  HYST_PX, altText, bankText, blocksShown, deg3, eprText, frameLayout, frameView, gText, liveFlightData, pitchText, speedText,
  vsText, windText,
} = await import('./flightFrame.ts')

type Sizes = Record<BlockId, BlockSize>
type Layout = Record<BlockId, Placed | null>
const IDS: readonly BlockId[] = ['left', 'right', 'top', 'bottom']
const SIZES: Sizes = { left: { w: 96, h: 58 }, right: { w: 88, h: 64 }, top: { w: 170, h: 28 }, bottom: { w: 196, h: 44 } }
const SAFE: Rect = { x: 0, y: 0, w: 1280, h: 800 }
const ZERO = { w: 0, h: 0 }

const sizeOf = (s: BlockSize | readonly BlockSize[], p: Placed): BlockSize => (Array.isArray(s) ? (s as readonly BlockSize[])[p.v] : (s as BlockSize))
const placed = (p: Layout, sizes: Record<BlockId, BlockSize | readonly BlockSize[]>): Array<{ id: string } & Rect> =>
  IDS.flatMap((id) => {
    const q = p[id]
    if (q === null) return []
    const { w, h } = sizeOf(sizes[id], q)
    return [{ id, x: q.x, y: q.y, w, h }]
  })
const inside = (p: Layout, sizes: Record<BlockId, BlockSize | readonly BlockSize[]>, safe: Rect, ctx = ''): void => {
  for (const { id, x, y, w, h } of placed(p, sizes)) {
    const msg = `${id} at ${x},${y} ${w}×${h} in ${JSON.stringify(safe)} ${ctx}`
    assert.ok(x >= safe.x - 1e-9 && y >= safe.y - 1e-9 && x + w <= safe.x + safe.w + 1e-9 && y + h <= safe.y + safe.h + 1e-9, msg)
  }
}
const gapBetween = (a: Rect, b: Rect): { dx: number; dy: number } => ({
  dx: Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)),
  dy: Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)),
})
/** Every pair of placed blocks, and every block and the square, apart by at least `gap` along x or along y. */
const apart = (p: Layout, sizes: Record<BlockId, BlockSize | readonly BlockSize[]>, sq: Square, gap: number, ctx = ''): void => {
  const rs = placed(p, sizes)
  const square = { id: 'square', x: sq.x - sq.side / 2, y: sq.y - sq.side / 2, w: sq.side, h: sq.side }
  for (let i = 0; i < rs.length; i++) {
    for (const b of [...rs.slice(i + 1), square]) {
      const { dx, dy } = gapBetween(rs[i], b)
      assert.ok(dx >= gap - 1e-9 || dy >= gap - 1e-9, `${rs[i].id} and ${b.id} closer than ${gap} (dx ${dx}, dy ${dy}) ${ctx}`)
    }
  }
}
const at = (p: Layout, id: BlockId): { x: number; y: number } => ({ x: p[id]!.x, y: p[id]!.y })

// ---- frameLayout ----------------------------------------------------------------------------------------------------

test('frameLayout: a mid-size square: each block hugs its side at the gap, centred on it', () => {
  const sq: Square = { x: 640, y: 400, side: 120 }
  const p = frameLayout(sq, SIZES, SAFE)
  assert.deepEqual(at(p, 'left'), { x: 640 - 60 - 10 - 96, y: 400 - 29 })
  assert.deepEqual(at(p, 'right'), { x: 640 + 60 + 10, y: 400 - 32 })
  assert.deepEqual(at(p, 'top'), { x: 640 - 85, y: 400 - 60 - 10 - 28 })
  assert.deepEqual(at(p, 'bottom'), { x: 640 - 98, y: 400 + 60 + 10 })
  for (const id of IDS) assert.deepEqual([p[id]!.side, p[id]!.v], [id, 0], id)
})

test('frameLayout: the gap is a parameter', () => {
  const p = frameLayout({ x: 640, y: 400, side: 120 }, SIZES, SAFE, 4)
  assert.equal(p.left!.x + SIZES.left.w, 640 - 60 - 4)
  assert.equal(p.right!.x, 640 + 60 + 4)
  assert.equal(p.top!.y + SIZES.top.h, 400 - 60 - 4)
  assert.equal(p.bottom!.y, 400 + 60 + 4)
})

test('frameLayout: each block lines its anchor up with the square (a tape readout level with the aircraft, the attitude under it)', () => {
  const sizes: Sizes = {
    left: { w: 96, h: 200, ay: 120 }, right: { w: 88, h: 200, ay: 90 }, top: { w: 170, h: 28, ax: 120 }, bottom: { w: 196, h: 44, ax: 60 },
  }
  const p = frameLayout({ x: 640, y: 400, side: 260 }, sizes, SAFE)
  assert.equal(p.left!.y + 120, 400)
  assert.equal(p.right!.y + 90, 400)
  assert.equal(p.top!.x + 120, 640)
  assert.equal(p.bottom!.x + 60, 640)
})

test('frameLayout: a tiny square: the sides stay on it, the top and bottom go out past them', () => {
  const sq: Square = { x: 640, y: 400, side: MIN_PX }
  const p = frameLayout(sq, SIZES, SAFE)
  assert.deepEqual(at(p, 'left'), { x: 640 - 12 - 10 - 96, y: 400 - 29 })
  assert.deepEqual(at(p, 'right'), { x: 640 + 12 + 10, y: 400 - 32 })
  // The top block is wider than the square: it would sit on the side blocks, so it rises above the taller one.
  assert.deepEqual(at(p, 'top'), { x: 640 - 85, y: 400 - 32 - 10 - 28 })
  assert.deepEqual(at(p, 'bottom'), { x: 640 - 98, y: 400 + 32 + 10 })
  apart(p, SIZES, sq, 10)
})

test('frameLayout: near an edge a block slides along its side, and one with no room there goes to another side, never over the square', () => {
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
    inside(p, SIZES, safe, name)
    apart(p, SIZES, sq, 10, name)
    for (const id of IDS) assert.notEqual(p[id], null, `${name}: ${id} has room somewhere`)
  }
  const l = frameLayout(cases[0][1], SIZES, safe)
  assert.equal(l.left!.side, 'right', 'no room left of the square: the altitude goes right, beyond the speed')
  assert.ok(l.left!.x >= l.right!.x + SIZES.right.w + 10)
  const t = frameLayout(cases[2][1], SIZES, safe)
  assert.equal(t.top!.side, 'bottom', 'no room above: the heading goes under the attitude')
  assert.ok(t.top!.y >= t.bottom!.y + SIZES.bottom.h + 10)
  const s = frameLayout({ x: 608, y: 300, side: 80 }, SIZES, { ...safe, y: 290 }) // the sides slide down into the safe area
  assert.equal(s.left!.side, 'left')
  assert.ok(s.left!.y >= 290)
})

test('frameLayout: the flight card open on a small window: the altitude no longer covers the aircraft, it stacks beyond the speed', () => {
  // 800 × 600, the card top-left (the safe area starts right of it), the aircraft in the middle of the canvas.
  const safe: Rect = { x: 340, y: 8, w: 388, h: 584 }
  const sizes: Sizes = { left: { w: 104, h: 196 }, right: { w: 104, h: 196 }, top: { w: 290, h: 56 }, bottom: { w: 260, h: 112 } }
  const sq: Square = { x: 400, y: 300, side: 128 }
  const p = frameLayout(sq, sizes, safe)
  inside(p, sizes, safe)
  apart(p, sizes, sq, 10)
  assert.equal(p.left!.side, 'right')
  assert.equal(p.right!.side, 'right')
  assert.equal(p.left!.y, p.right!.y, 'side by side, both level with the aircraft')
  assert.equal(p.top!.side, 'top')
  assert.equal(p.bottom!.side, 'bottom')
})

test('frameLayout: a smaller variant at home comes before the full one elsewhere', () => {
  const safe: Rect = { x: 0, y: 0, w: 700, h: 700 }
  const sq: Square = { x: 250, y: 350, side: 200 } // 140 px left of it: the full altitude block (144) does not fit, the compact (100) does
  const sizes = { left: [{ w: 144, h: 200 }, { w: 100, h: 150 }], right: [{ w: 96, h: 180 }], top: [{ w: 200, h: 50 }], bottom: [{ w: 240, h: 100 }] }
  const p = frameLayout(sq, sizes, safe)
  assert.deepEqual([p.left!.side, p.left!.v], ['left', 1])
  assert.deepEqual([p.right!.side, p.right!.v], ['right', 0])
  const roomy = frameLayout({ ...sq, x: 350 }, sizes, safe)
  assert.deepEqual([roomy.left!.side, roomy.left!.v], ['left', 0], 'room again: the full one')
  inside(p, sizes, safe)
  apart(p, sizes, sq, 10)
})

test('frameLayout: hysteresis: a block that moved away comes home only with HYST_PX to spare (no flicker at the edge)', () => {
  const safe: Rect = { x: 0, y: 0, w: 1280, h: 800 }
  const sizes: Sizes = { left: { w: 104, h: 196 }, right: { w: 104, h: 196 }, top: { w: 290, h: 56 }, bottom: { w: 260, h: 112 } }
  const home = 10 + 104 + 60 // the left block fits left of a 120 px square centred at x ≥ this
  const away = frameLayout({ x: home - 1, y: 400, side: 120 }, sizes, safe)
  assert.equal(away.left!.side, 'right', 'beside the speed, level with the aircraft')
  assert.equal(away.left!.y, away.right!.y)
  // Just enough room again: still away, as it was…
  const stay = frameLayout({ x: home + 2, y: 400, side: 120 }, sizes, safe, 10, away)
  assert.equal(stay.left!.side, 'right')
  // …home once there is HYST_PX more; and with no previous frame it goes home as soon as it fits.
  assert.equal(frameLayout({ x: home + HYST_PX, y: 400, side: 120 }, sizes, safe, 10, stay).left!.side, 'left')
  assert.equal(frameLayout({ x: home + 2, y: 400, side: 120 }, sizes, safe).left!.side, 'left')
})

test('frameLayout: a square larger than the safe area leaves no room outside it: the blocks are hidden, not drawn over the aircraft', () => {
  const safe: Rect = { x: 10, y: 20, w: 1200, h: 700 }
  const p = frameLayout({ x: 610, y: 370, side: 1400 }, SIZES, safe)
  for (const id of IDS) assert.equal(p[id], null, id)
  // Larger in one dimension only (a phone held upright): the top and bottom still hug the square; the sides find room
  // above and below them.
  const phone: Rect = { x: 0, y: 0, w: 375, h: 700 }
  const sq: Square = { x: 187, y: 350, side: 420 }
  const q = frameLayout(sq, SIZES, phone)
  assert.equal(q.top!.y + SIZES.top.h, 350 - 210 - 10)
  assert.equal(q.bottom!.y, 350 + 210 + 10)
  inside(q, SIZES, phone)
  apart(q, SIZES, sq, 10)
})

test('frameLayout: a hidden block (0 × 0) takes no room and is null', () => {
  const sq: Square = { x: 640, y: 30, side: MIN_PX }
  const p = frameLayout(sq, { ...SIZES, top: ZERO }, SAFE)
  assert.equal(p.top, null)
  assert.equal(p.left!.y, 30 - 29)
  assert.equal(p.right!.y, 0) // 30 − 32, slid into the safe area
  assert.equal(frameLayout(sq, { ...SIZES, top: [] }, SAFE).top, null, 'no variants: hidden too')
})

test('frameLayout: a phone (390 × 844) with the compact blocks: all four around an airliner at the default range', () => {
  const safe: Rect = { x: 8, y: 8, w: 374, h: 560 }
  const sizes: Sizes = { left: { w: 76, h: 150, ay: 80 }, right: { w: 76, h: 150, ay: 80 }, top: { w: 220, h: 46 }, bottom: { w: 200, h: 84 } }
  const sq: Square = { x: 195, y: 288, side: 180 }
  const p = frameLayout(sq, sizes, safe)
  for (const id of IDS) assert.equal(p[id]!.side, id, id)
  inside(p, sizes, safe)
  apart(p, sizes, sq, 10)
})

test('frameLayout: 300 random cases: every block inside the safe area, clear of the square and of each other by the gap', () => {
  let seed = 0x5eed1985
  const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const between = (a: number, b: number): number => a + (b - a) * rnd()
  const size = (w0: number, w1: number, h0: number, h1: number): BlockSize =>
    rnd() < 0.15 ? ZERO : { w: Math.round(between(w0, w1)), h: Math.round(between(h0, h1)) }
  let prev: Layout | undefined
  for (let i = 0; i < 300; i++) {
    const safe: Rect = { x: between(0, 200), y: between(0, 150), w: between(340, 1900), h: between(420, 1100) }
    const sizes = {
      left: rnd() < 0.5 ? [size(90, 140, 150, 230), size(70, 90, 110, 150)] : [size(70, 130, 40, 230)],
      right: [size(70, 140, 150, 260)],
      top: [size(120, 320, 40, 64)],
      bottom: rnd() < 0.5 ? [size(200, 300, 90, 130), size(150, 200, 70, 90)] : [size(120, 300, 30, 130)],
    }
    const side = Math.exp(between(Math.log(MIN_PX), Math.log(3000)))
    const sq: Square = { x: between(safe.x - side / 2, safe.x + safe.w + side / 2), y: between(safe.y - side / 2, safe.y + safe.h + side / 2), side }
    const gap = rnd() < 0.5 ? 10 : Math.round(between(2, 16))
    const p = frameLayout(sq, sizes, safe, gap, rnd() < 0.3 ? prev : undefined)
    const ctx = `case ${i}: ${JSON.stringify({ sq, sizes, safe, gap })}`
    inside(p, sizes, safe, ctx)
    apart(p, sizes, sq, gap, ctx)
    prev = p
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

test('liveFlightData: the render state and the ADS-B reply map onto the frame; the attitude is the drawn one, an estimate', () => {
  assert.deepEqual(plain(liveFlightData(S, RAW, 7400)), {
    altFt: 7975, aglFt: 7400, vsFpm: -951, iasKt: 268, gsKt: 337.1, hdgDeg: 105.24, trackDeg: 101.81, pitchDeg: -1.5,
    rollDeg: 0.5, g: null, windFromDeg: 281, windKt: 22, gear: null, flaps: null, epr: null, derived: ['aglFt', 'pitchDeg', 'rollDeg'],
  })
})

test('liveFlightData: no reply: the reply fields are null; the drawn attitude still shows (the 3-D model and the instrument agree)', () => {
  assert.deepEqual(plain(liveFlightData(S, null, null)), {
    altFt: 7975, aglFt: null, vsFpm: -951, iasKt: null, gsKt: 337.1, hdgDeg: null, trackDeg: 101.81, pitchDeg: -1.5,
    rollDeg: 0.5, g: null, windFromDeg: null, windKt: null, gear: null, flaps: null, epr: null, derived: ['pitchDeg', 'rollDeg'],
  })
  const bare = liveFlightData(S, { hex: '4691c4', alt_baro: 7975 }, null)
  assert.equal(bare.rollDeg, 0.5, 'the drawn roll, never the broadcast one: the model shows the drawn one')
  assert.equal(bare.iasKt, null)
  assert.equal(bare.windKt, null)
})

test('liveFlightData: the track\'s smoothed altitude and airspeed, not the sample\'s (25 ft steps, behind the drawn aircraft)', () => {
  const d = liveFlightData({ ...S, altMslFt: 7890.4, iasKt: 266.2 }, RAW, 7400)
  assert.equal(d.altFt, 7890.4, 'the height the aircraft is drawn at, so ALT − AGL is the ground under it')
  assert.equal(d.iasKt, 266.2)
  assert.equal(liveFlightData({ ...S, altMslFt: null, iasKt: null }, RAW, null).altFt, 7975, 'none (on the ground): the sample\'s')
})

test('liveFlightData: the drawn gear, an estimate (the crew timing, not a broadcast)', () => {
  const d = liveFlightData(S, RAW, 700, 'down')
  assert.equal(d.gear, 'down')
  assert.deepEqual([...d.derived].sort(), ['aglFt', 'gear', 'pitchDeg', 'rollDeg'])
  assert.equal(liveFlightData(S, RAW, null, 'up').gear, 'up')
  assert.equal(liveFlightData(S, RAW, null).gear, null, 'unknown: none')
})

test('liveFlightData: the heading is the drawn nose (track + the averaged crab) while the aircraft reports one; else none (TRK)', () => {
  assert.equal(liveFlightData(S, RAW, null).hdgDeg, S.headingDeg, 'not the raw Comm-B heading: a stale snapshot, and the model shows the drawn one')
  assert.equal(liveFlightData(S, { ...RAW, true_heading: undefined }, null).hdgDeg, null)
})

// ---- text -----------------------------------------------------------------------------------------------------------

test('text: altitude to 10 ft, thousands separated, a true minus', () => {
  assert.equal(altText(12_304), '12,300')
  assert.equal(altText(-1_302), '−1,300')
  assert.equal(altText(1_234_567), '1,234,570')
  assert.equal(altText(-3), '0')
})

test('text: vertical speed to 50 fpm with an arrow; within 50 fpm of level, 0 and no arrow', () => {
  assert.deepEqual(vsText(1_497), { arrow: '↑', text: '1,500' })
  assert.deepEqual(vsText(-951), { arrow: '↓', text: '950' })
  assert.deepEqual(vsText(-2_344), { arrow: '↓', text: '2,350' })
  assert.deepEqual(vsText(-42), { arrow: '', text: '0' })
  assert.deepEqual(vsText(49.9), { arrow: '', text: '0' })
  assert.deepEqual(vsText(60), { arrow: '↑', text: '50' })
})

test('text: speed, heading (north as 360), bank with its side, pitch with its sign', () => {
  assert.equal(speedText(140.4), '140')
  assert.equal(speedText(1_004.6), '1,005')
  assert.equal(deg3(5.4), '005°')
  assert.equal(deg3(359.7), '360°')
  assert.equal(deg3(-90), '270°')
  assert.equal(bankText(38.3), '38° R')
  assert.equal(bankText(-12.4), '12° L')
  assert.equal(bankText(0.3), '0°')
  assert.equal(bankText(-0.4), '0°')
  assert.equal(pitchText(9.2), '+9°')
  assert.equal(pitchText(-3.4), '−3°')
  assert.equal(pitchText(-0.2), '0°')
})

test('text: wind from/speed or Calm; load factor and EPR', () => {
  assert.equal(windText(220, 16.2), '220°/16')
  assert.equal(windText(359.7, 8), '360°/8')
  assert.equal(windText(220, 0.4), 'Calm')
  assert.equal(gText(1.84), '1.8')
  assert.equal(gText(-0.34), '−0.3')
  assert.equal(gText(-0.04), '0.0')
  assert.equal(eprText(1.284), '1.28')
})

// ---- frameView ------------------------------------------------------------------------------------------------------

const NONE: FlightData = {
  altFt: null, aglFt: null, vsFpm: null, iasKt: null, gsKt: null, hdgDeg: null, trackDeg: null, pitchDeg: null,
  rollDeg: null, g: null, windFromDeg: null, windKt: null, gear: null, flaps: null, epr: null, derived: new Set(),
}
const FULL: FlightData = {
  altFt: 12_304, aglFt: 11_846, vsFpm: 1_497, iasKt: 280.4, gsKt: 309.6, hdgDeg: 250.2, trackDeg: 254, pitchDeg: 9.2,
  rollDeg: 38.3, g: 1.84, windFromDeg: 220, windKt: 16.2, gear: 'down', flaps: 10, epr: [1.5, 1.45, NaN, 2.4],
  derived: new Set(),
}

test('frameView: every instrument of a full record', () => {
  const v = frameView(FULL)
  assert.deepEqual(v.alt, { value: 12_304, est: false })
  assert.deepEqual(v.agl, { value: 11_846, est: false })
  assert.deepEqual(v.vs, { value: 1_497, est: false })
  assert.deepEqual(v.speed, { value: 280.4, est: false, kind: 'IAS' })
  assert.deepEqual(v.gs, { value: 309.6, est: false }, 'the ground speed beside the airspeed tape')
  assert.deepEqual(v.hdg, { value: 250.2, est: false, kind: 'HDG' })
  assert.deepEqual(v.track, { value: 254, est: false }, 'the track diamond: 4° right of the nose')
  const { rel, ...wind } = v.wind!
  assert.deepEqual(wind, { fromDeg: 220, kt: 16.2, est: false })
  assert.ok(Math.abs(rel!.deg - -30.2) < 1e-9 && rel!.est === false, 'the wind from 30° left of the nose')
  assert.deepEqual(v.roll, { value: 38.3, est: false })
  assert.deepEqual(v.pitch, { value: 9.2, est: false })
  assert.deepEqual(v.adi, { est: false })
  assert.deepEqual(v.g, { value: 1.84, est: false })
  assert.deepEqual(v.epr, { values: [1.5, 1.45, null, 2.4], est: false })
  assert.deepEqual(v.gear, { est: false })
  assert.deepEqual(v.flaps, { value: 10, est: false })
  assert.deepEqual(blocksShown(v), { left: true, right: true, top: true, bottom: true })
})

test('frameView: height above ground only below 15,000 ft (high up it reads as noise)', () => {
  assert.equal(frameView({ ...FULL, altFt: 27_100, aglFt: 27_660 }).agl, null)
  assert.deepEqual(frameView({ ...FULL, aglFt: 14_990 }).agl, { value: 14_990, est: false })
  assert.deepEqual(frameView({ ...FULL, aglFt: -40 }).agl, { value: 0, est: false }, 'never below the ground')
})

test('frameView: no airspeed: the tape shows the ground speed, labelled GS, and never reads 0 for the missing airspeed', () => {
  for (const iasKt of [null, NaN, 0, -3]) {
    const v = frameView({ ...FULL, iasKt })
    assert.deepEqual(v.speed, { value: 309.6, est: false, kind: 'GS' }, String(iasKt))
    assert.equal(v.gs, null, 'not twice')
  }
  const none = frameView({ ...FULL, iasKt: null, gsKt: null })
  assert.equal(none.speed, null, 'nothing known: no tape at all')
  assert.equal(frameView({ ...FULL, iasKt: 140, gsKt: null }).gs, null)
  const est = frameView({ ...FULL, iasKt: null, derived: new Set<keyof FlightData>(['gsKt']) })
  assert.equal(est.speed!.est, true, 'a ground speed from the path is an estimate')
})

test('frameView: no heading: the track names the tape and steers the wind arrow, both estimates; no diamond', () => {
  const v = frameView({ ...FULL, hdgDeg: null, trackDeg: 256 })
  assert.deepEqual(v.hdg, { value: 256, est: true, kind: 'TRK' })
  assert.equal(v.track, null)
  assert.deepEqual(v.wind!.rel, { deg: -36, est: true })
  assert.equal(frameView({ ...FULL, hdgDeg: null, trackDeg: null }).hdg, null)
  assert.equal(frameView({ ...FULL, hdgDeg: null, trackDeg: null }).wind!.rel, null, 'no nose: the wind in figures only')
})

test('frameView: the track diamond only where it differs from the heading by a degree or more', () => {
  assert.equal(frameView({ ...FULL, hdgDeg: 250.2, trackDeg: 250.9 }).track, null)
  assert.deepEqual(frameView({ ...FULL, hdgDeg: 359, trackDeg: 2 }).track, { value: 2, est: false })
})

test('frameView: the wind arrow is windFrom − heading, the short way round; a calm wind has none', () => {
  const deg = (windFromDeg: number, hdgDeg: number): number | undefined => frameView({ ...FULL, windFromDeg, hdgDeg }).wind!.rel?.deg
  assert.equal(deg(10, 350), 20)
  assert.equal(deg(350, 10), -20)
  assert.equal(deg(190, 10), 180)
  assert.equal(deg(250, 250), 0, 'a headwind points from the nose')
  assert.equal(deg(70, 250), 180, 'a tailwind from the tail')
  const calm = frameView({ ...FULL, windKt: 0.4 }).wind!
  assert.equal(calm.rel, null)
  assert.equal(windText(calm.fromDeg, calm.kt), 'Calm')
  assert.equal(frameView({ ...FULL, windKt: null }).wind, null)
})

test('frameView: the attitude indicator with either angle, dimmed when the other is unknown; none without both', () => {
  assert.deepEqual(frameView({ ...FULL, pitchDeg: null }).adi, { est: true })
  assert.equal(frameView({ ...FULL, pitchDeg: null }).pitch, null)
  assert.deepEqual(frameView({ ...FULL, rollDeg: null }).adi, { est: true })
  assert.equal(frameView({ ...FULL, rollDeg: null, pitchDeg: null }).adi, null)
})

test('frameView: estimates (derived) are flagged per instrument', () => {
  const v = frameView({ ...FULL, derived: new Set<keyof FlightData>(['aglFt', 'iasKt', 'pitchDeg', 'gear', 'windKt', 'epr']) })
  assert.equal(v.alt!.est, false)
  assert.equal(v.agl!.est, true)
  assert.equal(v.speed!.est, true)
  assert.equal(v.gs!.est, false)
  assert.equal(v.pitch!.est, true)
  assert.equal(v.roll!.est, false)
  assert.deepEqual(v.adi, { est: true }, 'the indicator dims with either of its angles')
  assert.deepEqual(v.gear, { est: true })
  assert.equal(v.flaps!.est, false)
  assert.equal(v.wind!.est, true)
  assert.equal(v.wind!.rel!.est, true)
  assert.equal(v.epr!.est, true)
})

test('frameView: live ADS-B: no thrust, no load; the drawn attitude, dimmed as an estimate', () => {
  const v = frameView(liveFlightData(S, RAW, 7400))
  assert.deepEqual(v.speed, { value: 268, est: false, kind: 'IAS' })
  assert.deepEqual(v.gs, { value: 337.1, est: false })
  assert.equal(v.epr, null)
  assert.equal(v.g, null)
  assert.deepEqual(v.roll, { value: 0.5, est: true })
  assert.deepEqual(v.pitch, { value: -1.5, est: true })
  assert.deepEqual(v.adi, { est: true })
  assert.equal(v.gear, null)
  assert.equal(v.flaps, null)
})

test('frameView: gear up and flaps up show no annunciators; a block with nothing to show is not shown', () => {
  const v = frameView({ ...NONE, altFt: 3000, gear: 'up', flaps: 0 })
  assert.equal(v.gear, null)
  assert.equal(v.flaps, null)
  assert.deepEqual(blocksShown(v), { left: true, right: false, top: false, bottom: false })
  assert.deepEqual(blocksShown(frameView(NONE)), { left: false, right: false, top: false, bottom: false })
  const thrust = blocksShown(frameView({ ...NONE, epr: [1.2, 1.3] }))
  assert.deepEqual(thrust, { left: false, right: false, top: false, bottom: true }, 'the thrust sits under the attitude')
  assert.deepEqual(blocksShown(frameView({ ...NONE, gear: 'down' })), { left: false, right: false, top: false, bottom: true })
  assert.deepEqual(blocksShown(frameView({ ...NONE, windFromDeg: 90, windKt: 12 })), { left: false, right: false, top: true, bottom: false })
  assert.equal(frameView({ ...NONE, epr: [] }).epr, null)
})
