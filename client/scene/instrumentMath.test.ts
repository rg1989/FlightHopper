// client/scene/instrumentMath.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADI_PITCH_LIMIT, BANK_ALERT_DEG, Glide, TREND_S, Trend, VSI_MARKS, arcDeg, bankAlert, drum, drumLabels, drumShift, follow, glide,
  hdgLabel, marks, pitchShift, rel180, stripCentre, tapeShift, trendShown, vsiFrac,
} from './instrumentMath.ts'

const near = (a: number, b: number, eps = 1e-9, msg = ''): void => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b} ${msg}`)

// ---- tapes ----------------------------------------------------------------------------------------------------------

test('marks: every minor step between lo and hi, the multiples of major flagged', () => {
  assert.deepEqual(marks(1_280, 1_720, 100, 500), [
    { v: 1_300, major: false }, { v: 1_400, major: false }, { v: 1_500, major: true }, { v: 1_600, major: false }, { v: 1_700, major: false },
  ])
  // Ends included; below zero too (the Dead Sea); no −0.
  assert.deepEqual(marks(-500, 0, 250, 500), [{ v: -500, major: true }, { v: -250, major: false }, { v: 0, major: true }])
  assert.ok(Object.is(marks(-10, 10, 10, 20)[1].v, 0), 'zero is +0')
})

test('marks: whole-number steps stay exact over a long strip (no float drift)', () => {
  const m = marks(33_000, 37_000, 100, 500)
  assert.equal(m.length, 41)
  for (const { v, major } of m) {
    assert.ok(Number.isInteger(v), String(v))
    assert.equal(major, v % 500 === 0)
  }
})

test('tapeShift: value above the strip centre moves the strip by px per unit, rounded to whole device pixels', () => {
  assert.equal(tapeShift(1_850, 1_800, 0.16, 1), 8)
  assert.equal(tapeShift(1_803, 1_800, 0.16, 1), 0) // 0.48 px: stays put on a 1× screen…
  assert.equal(tapeShift(1_803, 1_800, 0.16, 2), 0.5) // …and moves half a CSS px on a 2× one
  assert.equal(tapeShift(1_750, 1_800, 0.16, 2), -8)
  assert.ok(Object.is(tapeShift(1_799.99, 1_800, 0.16, 1), 0), 'no −0 in a transform')
})

test('stripCentre: a strip is rebuilt around the value (on a major mark) only when the window would run off it', () => {
  // A strip built ±1,000 around 2,000 with a ±500 window: good for values 1,500…2,500.
  assert.equal(stripCentre(2_400, 2_000, 1_000, 500, 500), 2_000)
  assert.equal(stripCentre(1_500, 2_000, 1_000, 500, 500), 2_000)
  assert.equal(stripCentre(2_501, 2_000, 1_000, 500, 500), 2_500)
  assert.equal(stripCentre(1_260, 2_000, 1_000, 500, 500), 1_500)
  assert.equal(stripCentre(7_777, null, 1_000, 500, 500), 8_000, 'no strip yet')
})

test('hdgLabel: the compass every 30°: cardinal letters, the others in tens; nothing between', () => {
  const at = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map(hdgLabel)
  assert.deepEqual(at, ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'])
  assert.equal(hdgLabel(360), 'N')
  assert.equal(hdgLabel(-30), '33', 'an unwrapped strip below north')
  assert.equal(hdgLabel(390), '3', 'and past it')
  assert.equal(hdgLabel(45), '')
  assert.equal(hdgLabel(10), '')
})

test('drum: whole units in figures, the rest a position on the drum in steps (an odometer); the magnitude, with its sign', () => {
  const is = (d: ReturnType<typeof drum>, lead: number, pos: number, neg: boolean, msg: string): void => {
    assert.equal(d.lead, lead, msg)
    near(d.pos, pos, 1e-9, msg)
    assert.equal(d.neg, neg, msg)
  }
  // Speed: tens in figures, the units rolling.
  is(drum(140.4, 10, 1), 14, 0.4, false, '140.4 kt')
  is(drum(149.5, 10, 1), 14, 9.5, false, '149.5 kt: the 9 rolls out, the 0 of 150 comes in')
  is(drum(150, 10, 1), 15, 0, false, '150 kt')
  is(drum(7, 10, 1), 0, 7, false, 'under 10 kt: no figures, only the drum')
  // Altitude: hundreds in figures, the last two digits on a drum of 20 ft steps.
  is(drum(12_345, 100, 20), 123, 2.25, false, '12,345 ft')
  is(drum(-1_234, 100, 20), 12, 1.7, true, '−1,234 ft (the Dead Sea): the magnitude, and a minus')
  is(drum(-11, 100, 20), 0, 0.55, true, '−11 ft (Schiphol)')
  is(drum(-4, 100, 20), 0, 0.2, false, 'within half a step of zero: no minus')
  is(drum(-0, 100, 20), 0, 0, false, '−0')
})

test('drumLabels: the drum\'s cells top to bottom, one past each end (the neighbours show above and below)', () => {
  assert.deepEqual(drumLabels(10, 1, 1), ['1', '0', '9', '8', '7', '6', '5', '4', '3', '2', '1', '0', '9'])
  assert.deepEqual(drumLabels(100, 20, 2), ['20', '00', '80', '60', '40', '20', '00', '80'])
})

test('drumShift: the drum moves down as the value rises, the position\'s cell centred in the window', () => {
  const labels = drumLabels(10, 1, 1)
  const centred = (pos: number): string => labels[Math.round(-drumShift(pos, 10))]
  assert.equal(drumShift(0, 10), -11)
  assert.equal(centred(0), '0')
  assert.equal(centred(7), '7')
  assert.equal(centred(9.99), '0', 'rolling over: the next ten\'s 0 has come in from above')
  assert.ok(drumShift(3.2, 10) > drumShift(3.1, 10), 'rising: down')
  assert.equal(drumLabels(100, 20, 2)[Math.round(-drumShift(2.25, 5))], '40', '12,345 ft reads 12,3|40')
})

test('Trend: the speed\'s change per second, smoothed: a steady acceleration reads as itself', () => {
  assert.equal(TREND_S, 10, 'the arrow points at the speed 10 s ahead')
  const tr = new Trend()
  let v = 150
  let out: number | null = tr.step(v, 1 / 60)
  assert.equal(out, null, 'one value is no trend')
  for (let i = 0; i < 300; i++) out = tr.step((v += 2 / 60), 1 / 60) // 2 kt/s for 5 s
  near(out!, 2, 0.02)
})

test('Trend: a jump (a seek) or time going back restarts it; a pause holds it, and a value moved while paused is no acceleration', () => {
  const tr = new Trend()
  let v = 150
  for (let i = 0; i < 300; i++) tr.step((v += 1 / 60), 1 / 60)
  assert.equal(tr.step(v + 30, 1 / 60), null, '+30 kt in a frame is a seek')
  const after = tr.step(v + 30 + 1 / 60, 1 / 60)
  assert.ok(after !== null && Math.abs(after) < 0.1, `it starts again from nothing: ${after}`)

  const held = new Trend()
  v = 200
  let last: number | null = null
  for (let i = 0; i < 300; i++) last = held.step((v -= 1.5 / 60), 1 / 60)
  assert.equal(held.step(v, 0), last, 'paused: held')
  assert.equal(held.step((v += 8), 0), last, 'dragged while paused: still held')
  near(held.step((v -= 1.5 / 60), 1 / 60)!, -1.5, 0.05, 'playing again: no spike from the drag')
  assert.equal(held.step(v, -3), null, 'time went back')
  assert.equal(held.step(null, 1 / 60), null, 'unknown')
})

test('trendShown: the arrow appears at 2 kt over 10 s and goes below 1 kt, so it does not flicker at the threshold', () => {
  assert.equal(trendShown(false, 1.9), false)
  assert.equal(trendShown(false, 2), true)
  assert.equal(trendShown(false, -2.5), true)
  assert.equal(trendShown(true, 1.2), true)
  assert.equal(trendShown(true, 0.9), false)
  assert.equal(trendShown(true, -0.9), false)
})

// ---- vertical speed -------------------------------------------------------------------------------------------------

test('vsiFrac: the non-linear scale: half the travel for the first 1,000 fpm, three quarters at 2,000, the end at 6,000', () => {
  near(vsiFrac(0), 0)
  near(vsiFrac(500), 0.25)
  near(vsiFrac(1_000), 0.5)
  near(vsiFrac(2_000), 0.75)
  near(vsiFrac(4_000), 0.875)
  near(vsiFrac(6_000), 1)
  near(vsiFrac(9_000), 1, 1e-9, 'pinned past the scale')
  near(vsiFrac(-750), -0.375)
  near(vsiFrac(-2_400), -0.775)
  assert.ok(Object.is(vsiFrac(-0), 0))
  assert.deepEqual([...VSI_MARKS], [500, 1_000, 2_000, 4_000, 6_000])
})

test('vsiFrac: strictly increasing across the whole range', () => {
  let last = -Infinity
  for (let v = -6_000; v <= 6_000; v += 25) {
    const f = vsiFrac(v)
    assert.ok(f > last, `${v}: ${f} after ${last}`)
    last = f
  }
})

// ---- angles ---------------------------------------------------------------------------------------------------------

test('rel180: an angle in (−180, 180]', () => {
  assert.equal(rel180(190), -170)
  assert.equal(rel180(-190), 170)
  assert.equal(rel180(180), 180)
  assert.equal(rel180(-180), 180)
  assert.equal(rel180(720 + 30), 30)
})

test('follow: the target turned to lie within 180° of the previous value, so a dial never spins the long way', () => {
  assert.equal(follow(350, 10), 370, 'north, clockwise')
  assert.equal(follow(10, 350), -10, 'north, anticlockwise')
  assert.equal(follow(-170, 170), -190, 'roll past −180')
  assert.equal(follow(725, 3), 723, 'two turns on')
  assert.equal(follow(0, 180), 180)
})

// ---- smoothing ------------------------------------------------------------------------------------------------------

test('glide: an exponential approach, e⁻¹ of the way left after one time constant', () => {
  near(glide(0, 100, 0.1, 0.1), 100 * (1 - Math.exp(-1)))
  assert.equal(glide(40, 100, 0, 0.1), 40, 'no time, no change')
  assert.equal(glide(40, 100, 0.1, 0), 100, 'no time constant: at the target')
})

test('Glide: snaps to its first value, to a jump past its snap distance, and starts again after a gap', () => {
  const g = new Glide(0.2, 1_000)
  assert.equal(g.step(null, 0.016), null)
  assert.equal(g.step(1_800, 0.016), 1_800, 'first value: no glide up from zero')
  const v = g.step(1_900, 0.016)!
  assert.ok(v > 1_800 && v < 1_810, `a small step glides: ${v}`)
  assert.equal(g.step(5_000, 0.016), 5_000, 'a seek snaps')
  assert.equal(g.step(null, 0.016), null, 'unknown: nothing, never a zero')
  assert.equal(g.value, null)
  assert.equal(g.step(250, 0.016), 250, 'known again: snaps, no glide from a stale value')
})

test('Glide: an angle glides the short way across north and across ±180', () => {
  const h = new Glide(0.2, 90, true)
  h.step(358, 0.016)
  const a = h.step(2, 0.1)!
  assert.ok(a > 358 && a < 362, `358 → 2 goes up through 360: ${a}`)
  const r = new Glide(0.2, 90, true)
  r.step(-178, 0.016)
  const b = r.step(178, 0.1)!
  assert.ok(b < -178 && b > -182, `−178 → 178 goes down through −180: ${b}`)
  // Turning on at 60°/s for 20 full turns (the target handed over in 0–360), it keeps following, turn-counted.
  let t = 2
  for (let i = 0; i < 2_400; i++) {
    t = (t + 3) % 360
    h.step(t, 0.05)
  }
  near(rel180(h.value! - t), 0, 20)
  assert.ok(h.value! > 7_000, 'unwrapped, not folded back to 0–360')
})

test('Glide: a target of NaN or ±Infinity counts as unknown', () => {
  const g = new Glide(0.2, 100)
  g.step(120, 0.016)
  assert.equal(g.step(Number.NaN, 0.016), null)
  assert.equal(g.step(Infinity, 0.016), null)
})

// ---- attitude and gauges --------------------------------------------------------------------------------------------

test('pitchShift: the horizon moves with pitch up to ±ADI_PITCH_LIMIT, then stops at the edge', () => {
  assert.equal(pitchShift(10), 10)
  assert.equal(pitchShift(-3.5), -3.5)
  assert.equal(pitchShift(40), ADI_PITCH_LIMIT)
  assert.equal(pitchShift(-90), -ADI_PITCH_LIMIT)
})

test('bankAlert: past 35° of bank either way (the pointer turns amber)', () => {
  assert.equal(BANK_ALERT_DEG, 35)
  assert.equal(bankAlert(35), false)
  assert.equal(bankAlert(37), true)
  assert.equal(bankAlert(-36), true)
  assert.equal(bankAlert(360 + 10), false, 'an unwrapped roll')
  assert.equal(bankAlert(-400), true)
})

test('arcDeg: a value along a gauge arc, pinned at its ends', () => {
  assert.equal(arcDeg(1, 0, 2.5, -90, 90), -18)
  assert.equal(arcDeg(0, 0, 2.5, -90, 90), -90)
  assert.equal(arcDeg(3.1, 0, 2.5, -90, 90), 90)
  assert.equal(arcDeg(-1, 0, 2.5, -90, 90), -90)
  assert.equal(arcDeg(1.5, 1, 2, -120, 90), -15)
})
