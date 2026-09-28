// client/track/attitude.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trueAirspeedKt } from './airspeed.ts'
import { AttitudeFilter, UPSET_RATES, aeroPitchRoll, densityRatio, turnRateDegS, vRefKt, type FlightState } from './attitude.ts'

const KT = 1852 / 3600
const FPM = 0.3048 / 60
const G = 9.80665
const DEG = 180 / Math.PI

const base: FlightState = { gsMs: 140 * KT, vsMs: 0, turnRateDegS: 0, alongMs2: 0, easKt: 140, altM: 600, onGround: false, category: 'A3' }
const pr = (p: Partial<FlightState>): { pitchDeg: number; rollDeg: number } => aeroPitchRoll({ ...base, ...p })

const within = (x: number, lo: number, hi: number, msg = ''): void => assert.ok(x >= lo && x <= hi, `${msg} ${x} not in [${lo}, ${hi}]`)
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)

// ---------- the physics: pitch = flight-path angle + angle of attack from the lift equation ----------

test('final approach, 3° glide at the reference speed: nose up about 3° (real airliners +2.5…+3.5°)', () => {
  const gs = 135 * KT
  const p = pr({ gsMs: gs, vsMs: -Math.tan(3 / DEG) * gs, easKt: 140 })
  within(p.pitchDeg, 2, 4, 'approach')
  near(p.rollDeg, 0, 1e-9)
})

test('initial climb after take-off at V2 + 20: about 15° nose up', () => {
  within(pr({ gsMs: 165 * KT, vsMs: 2400 * FPM, easKt: 160, altM: 300 }).pitchDeg, 12, 17, 'climb')
})

test('cruise at FL360: about 2° nose up; idle descent at 290 kt: nose 1–5° down', () => {
  within(pr({ gsMs: 460 * KT, vsMs: 0, easKt: 250, altM: 11_000 }).pitchDeg, 1, 3.5, 'cruise')
  within(pr({ gsMs: 330 * KT, vsMs: -2500 * FPM, easKt: 290, altM: 4500 }).pitchDeg, -5, -1, 'descent')
})

test('no thresholds: pitch is continuous in vertical speed (the old AoA table jumped 4° at +295 fpm)', () => {
  for (const eas of [140, 160, 200, 250]) {
    let prev = pr({ easKt: eas, gsMs: eas * KT, vsMs: -5 }).pitchDeg
    for (let vs = -5; vs <= 8; vs += 0.05) {
      const p = pr({ easKt: eas, gsMs: eas * KT, vsMs: vs }).pitchDeg
      assert.ok(Math.abs(p - prev) < 0.15, `jump ${p - prev} at vs ${vs} m/s, ${eas} kt`)
      prev = p
    }
  }
})

test('no thresholds: pitch is continuous in airspeed, through the flap schedule', () => {
  let prev = pr({ easKt: 120 }).pitchDeg
  for (let eas = 120; eas <= 320; eas += 0.5) {
    const p = pr({ easKt: eas }).pitchDeg
    assert.ok(Math.abs(p - prev) < 0.25, `jump ${p - prev} at ${eas} kt`)
    prev = p
  }
})

test('slower means more nose up (more lift coefficient), in level flight', () => {
  assert.ok(pr({ easKt: 180 }).pitchDeg > pr({ easKt: 250 }).pitchDeg)
  assert.ok(pr({ easKt: 150 }).pitchDeg > pr({ easKt: 180 }).pitchDeg - 1.5) // flaps come out and take some of it back
})

test('coordinated turn: bank = atan(V·ω/g), right turn = right wing down', () => {
  const r = pr({ turnRateDegS: 3 }).rollDeg
  near(r, Math.atan((140 * KT * (3 / DEG)) / G) * DEG, 1e-9)
  near(pr({ turnRateDegS: -3 }).rollDeg, -r, 1e-9)
})

test('load factor: the nose rises in a 25° turn (the wing must lift 1/cos 25° = 1.10 g)', () => {
  const w = (Math.tan(25 / DEG) * G) / (140 * KT) * DEG // turn rate for 25° of bank
  assert.ok(pr({ turnRateDegS: w }).pitchDeg > pr({}).pitchDeg + 0.4)
})

test('light aircraft use their own reference speed: a 110 kt cruise is not a stall attitude', () => {
  within(pr({ category: 'A1', easKt: 110, gsMs: 110 * KT }).pitchDeg, 0, 4, 'C172 cruise')
})

test('rotorcraft: nose down with speed, level in a hover; no wing model', () => {
  near(pr({ category: 'A7', gsMs: 0, easKt: null }).pitchDeg, 0, 1e-9)
  within(pr({ category: 'A7', gsMs: 120 * KT, easKt: null }).pitchDeg, -6, -4, 'fast forward flight')
})

test('without airspeed the ground speed stands in, corrected for air density', () => {
  // FL360: σ ≈ 0.30, so 460 kt over the ground ≈ 250 kt equivalent — the same pitch as with the airspeed given.
  near(pr({ gsMs: 460 * KT, easKt: null, altM: 11_000 }).pitchDeg, pr({ gsMs: 460 * KT, easKt: 252, altM: 11_000 }).pitchDeg, 0.3)
})

test('rolling out: braking harder than any airborne drag means wheels on the runway — nose down, wings level', () => {
  const rolling = pr({ vsMs: 0.2, alongMs2: -2.2, easKt: 110, turnRateDegS: 1 })
  within(rolling.pitchDeg, -0.01, 0.01, 'rollout pitch')
  within(rolling.rollDeg, -0.01, 0.01, 'rollout bank')
  near(pr({ alongMs2: -0.5 }).pitchDeg, pr({}).pitchDeg, 1e-9, 'airborne deceleration changes nothing')
  // …and it blends in smoothly, not at a threshold
  let prev = pr({ alongMs2: 0 }).pitchDeg
  for (let a = 0; a >= -3; a -= 0.02) {
    const p = pr({ alongMs2: a }).pitchDeg
    assert.ok(Math.abs(p - prev) < 0.25, `jump at ${a}`)
    prev = p
  }
})

test('rolling out below the approach speed: even moderate braking (1.2 m/s²) means the wheels are down', () => {
  within(pr({ vsMs: -0.7, alongMs2: -1.2, easKt: null, gsMs: 118 * KT, altM: 80 }).pitchDeg, -0.01, 0.01, 'slow rollout')
  // …but the same deceleration on the glide (descending) or fast (a speedbrake level-off at 190 kt) is flight
  assert.ok(pr({ vsMs: -3.6, alongMs2: -1.2, easKt: null, gsMs: 135 * KT, altM: 300 }).pitchDeg > 2, 'on the glide')
  assert.ok(pr({ vsMs: 0, alongMs2: -0.9, easKt: 190, gsMs: 190 * KT }).pitchDeg > 3, 'level-off at 190 kt')
})

test('on the ground: pitch 0 and wings level whatever the rest says', () => {
  assert.deepEqual(pr({ onGround: true, vsMs: 5, turnRateDegS: 3 }), { pitchDeg: 0, rollDeg: 0 })
})

test('limits are the airframe\'s: the nose as steep as the path, α to the stall, bank to a 2.5-g turn', () => {
  // A 35° dive at 300 kt (Air Astana 1388 dived like this): the nose ~34° down with it, not held at a clamp's −15°.
  const tas = trueAirspeedKt(300, 1800 / 0.3048) * KT
  const dive = pr({ easKt: 300, altM: 1800, vsMs: -Math.sin(35 / DEG) * tas, gsMs: Math.cos(35 / DEG) * tas })
  within(dive.pitchDeg, -35, -33, 'dive')
  // Bad data (climbing 60 m/s at 60 kt): α stops at the stall, the path at ~78°: a steep nose, never past vertical.
  const p = pr({ vsMs: 60, gsMs: 60 * KT, easKt: 60 })
  within(p.pitchDeg, 60, 89, 'impossible zoom')
  near(pr({ turnRateDegS: 20 }).rollDeg, 67, 1e-9, 'bank')
})

test('the path through the air: a 40-kt headwind on a 3° glide raises the nose ~1°, as pilots see it', () => {
  const still = pr({ gsMs: 140 * KT, vsMs: -Math.tan(3 / DEG) * 140 * KT, easKt: 140, altM: 300 })
  const headwind = pr({ gsMs: 100 * KT, vsMs: -Math.tan(3 / DEG) * 100 * KT, easKt: 140, altM: 300 })
  within(headwind.pitchDeg - still.pitchDeg, 0.6, 1.2, 'nose higher into the wind')
})

test('densityRatio: ISA sea level 1, 0.30 at 11 km, 0.19 at 14 km', () => {
  near(densityRatio(0), 1, 1e-9)
  near(densityRatio(11_000), 0.297, 0.003)
  near(densityRatio(14_000), 0.186, 0.004)
})

test('vRefKt: by emitter category; null where no wing model applies', () => {
  assert.equal(vRefKt('A1'), 65)
  assert.equal(vRefKt('A3'), 140)
  assert.equal(vRefKt('A5'), 150)
  assert.equal(vRefKt(null), 140)
  assert.equal(vRefKt('A7'), null)
  assert.equal(vRefKt('B2'), null)
})

// ---------- the filter: inertia and rate limits ----------

test('filter: the first step returns the target', () => {
  const f = new AttitudeFilter()
  assert.deepEqual(f.step({ headingDeg: 90, pitchDeg: 3, rollDeg: -2 }, 0.016), { headingDeg: 90, pitchDeg: 3, rollDeg: -2 })
})

test('filter: critically damped — no overshoot, settles in about a second', () => {
  const f = new AttitudeFilter()
  f.step({ headingDeg: 0, pitchDeg: 0, rollDeg: 0 }, 0)
  let max = 0
  let at1s = 0
  for (let t = 0; t < 3; t += 1 / 60) {
    const a = f.step({ headingDeg: 0, pitchDeg: 2, rollDeg: 0 }, 1 / 60)
    max = Math.max(max, a.pitchDeg)
    if (Math.abs(t - 1) < 1e-6 || (t > 1 && at1s === 0)) at1s = a.pitchDeg
  }
  assert.ok(max <= 2 + 1e-9, `overshoot ${max}`)
  assert.ok(at1s > 1.8, `after 1 s only ${at1s}`)
})

test('filter: rate limits — pitch ≤ 5°/s, bank ≤ 15°/s, heading ≤ 10°/s (normal flight; an upset\'s are given)', () => {
  const f = new AttitudeFilter()
  let a = f.step({ headingDeg: 0, pitchDeg: 0, rollDeg: 0 }, 0)
  for (let i = 0; i < 120; i++) {
    const b = f.step({ headingDeg: 90, pitchDeg: 20, rollDeg: 40 }, 1 / 60)
    assert.ok(b.pitchDeg - a.pitchDeg <= 5 / 60 + 1e-9, 'pitch rate')
    assert.ok(b.rollDeg - a.rollDeg <= 15 / 60 + 1e-9, 'roll rate')
    assert.ok(b.headingDeg - a.headingDeg <= 10 / 60 + 1e-9, 'yaw rate')
    a = b
  }
})

test('filter: an upset\'s rates (a 4.5-g pull) let the nose follow a dive entry the default would lag', () => {
  const f = new AttitudeFilter(4, UPSET_RATES)
  let a = f.step({ headingDeg: 0, pitchDeg: 10, rollDeg: 0 }, 0)
  let max = 0
  for (let i = 0; i < 240; i++) {
    const b = f.step({ headingDeg: 0, pitchDeg: -30, rollDeg: 0 }, 1 / 60)
    max = Math.max(max, (a.pitchDeg - b.pitchDeg) * 60)
    a = b
  }
  within(max, 12, 13 + 1e-6, 'pitch rate')
  within(a.pitchDeg, -30, -29, 'at the dive attitude within 4 s (the default 5°/s takes over 8)')
})

test('filter: heading 359 → 1 goes the short way through north', () => {
  const f = new AttitudeFilter()
  f.step({ headingDeg: 359, pitchDeg: 0, rollDeg: 0 }, 0)
  const a = f.step({ headingDeg: 1, pitchDeg: 0, rollDeg: 0 }, 0.1)
  assert.ok(a.headingDeg > 359 || a.headingDeg < 1, `went the long way: ${a.headingDeg}`)
})

test('filter: exact for any step size (a 1 s step equals sixty 1/60 s steps, rate limits aside)', () => {
  const f1 = new AttitudeFilter()
  const f2 = new AttitudeFilter()
  const t0 = { headingDeg: 10, pitchDeg: 0, rollDeg: 0 }
  const t1 = { headingDeg: 12, pitchDeg: 1, rollDeg: 3 }
  f1.step(t0, 0)
  f2.step(t0, 0)
  const a = f1.step(t1, 1)
  let b = a
  for (let i = 0; i < 60; i++) b = f2.step(t1, 1 / 60)
  near(a.pitchDeg, b.pitchDeg, 1e-6)
  near(a.rollDeg, b.rollDeg, 1e-6)
  near(a.headingDeg, b.headingDeg, 1e-6)
})

test('filter: dt ≤ 0 holds the attitude; returned objects are copies', () => {
  const f = new AttitudeFilter()
  const a = f.step({ headingDeg: 5, pitchDeg: 1, rollDeg: 1 }, 0)
  a.pitchDeg = 99
  const b = f.step({ headingDeg: 50, pitchDeg: 10, rollDeg: 10 }, -0.02)
  assert.deepEqual(b, { headingDeg: 5, pitchDeg: 1, rollDeg: 1 })
})

// ---------- helpers ----------

test('turnRateDegS: plain difference over dt, wrap-safe across north, 0 for dt ≤ 0', () => {
  near(turnRateDegS(10, 16, 2), 3, 1e-12)
  near(turnRateDegS(359, 1, 1), 2, 1e-12)
  near(turnRateDegS(1, 359, 1), -2, 1e-12)
  assert.equal(turnRateDegS(10, 20, 0), 0)
})
