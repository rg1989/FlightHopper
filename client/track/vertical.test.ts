// client/track/vertical.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AltitudeLadder, VerticalFilter } from './vertical.ts'
import type { Sample } from '../../shared/types.ts'

const FT = 0.3048
const KT = 1852 / 3600
const N = -32.3 // KSFO-area geoid undulation, metres

function sample(p: Partial<Sample>): Sample {
  return {
    hex: 'abc123', tMs: 0, rxMs: 0, lat: 37.6, lon: -122.4, onGround: false,
    altBaroFt: null, altGeomFt: null, gsKt: 140, trackDeg: 280, trueHeadingDeg: null, rollDeg: null,
    baroRateFpm: null, geomRateFpm: null, navQnhHpa: null, version: 2, nic: 8, quality: 'adsb2',
    nM: N, callsign: null, typeCode: null, reg: null, ...p,
  }
}

const near = (a: number, b: number, tol: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, expected ${b} ± ${tol}`)

// ---------- AltitudeLadder ----------

test('ladder: v2 alt_geom is HAE and used directly', () => {
  const r = new AltitudeLadder().height(sample({ version: 2, altGeomFt: 10000, altBaroFt: 9800, navQnhHpa: 1020 }))
  assert.deepEqual(r, { hM: 10000 * FT, source: 'geom' })
})

test('ladder: on ground → null', () => {
  assert.equal(new AltitudeLadder().height(sample({ onGround: true, altGeomFt: 100 })), null)
})

test('ladder: no baro and no geom → null', () => {
  assert.equal(new AltitudeLadder().height(sample({ version: 0 })), null)
})

test('ladder: baro-qnh at 1003.25 hPa is −270 FEET before the metre conversion', () => {
  const r = new AltitudeLadder().height(sample({ version: 0, altBaroFt: 5000, navQnhHpa: 1003.25 }))!
  assert.equal(r.source, 'baro-qnh')
  near(r.hM, (5000 - 270) * FT + N, 1e-9)
  // the old plan's unit bug added N (metres) to feet: that answer is ~64 m away and must not come back
  assert.ok(Math.abs(r.hM - ((5000 - 270 + N) * FT)) > 20)
})

test('ladder: baro-qnh needs 950 ≤ qnh ≤ 1050 and alt_baro < 18000 ft, else baro-bias', () => {
  const raw = (ft: number): number => ft * FT + N
  const cases: [number, number | null][] = [[20000, 1003.25], [5000, 940], [5000, 1060], [5000, null]]
  for (const [ft, qnh] of cases) {
    const r = new AltitudeLadder().height(sample({ version: 0, altBaroFt: ft, navQnhHpa: qnh }))!
    assert.equal(r.source, 'baro-bias', `${ft} ft, qnh ${qnh}`)
    near(r.hM, raw(ft), 1e-9, `${ft} ft, qnh ${qnh}`)
  }
  assert.equal(new AltitudeLadder().height(sample({ version: 0, altBaroFt: 5000, navQnhHpa: 950 }))!.source, 'baro-qnh')
  assert.equal(new AltitudeLadder().height(sample({ version: 0, altBaroFt: 5000, navQnhHpa: 1050 }))!.source, 'baro-qnh')
})

test('ladder: v0/v1 geom 45 m from the baro chain is accepted', () => {
  const chain = 5000 * FT + N // qnh 1013.25 → no correction
  for (const version of [0, 1, null]) {
    const r = new AltitudeLadder().height(sample({ version, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: (chain + 45) / FT }))!
    assert.equal(r.source, 'geom', `version ${version}`)
    near(r.hM, chain + 45, 1e-9)
  }
})

test('ladder: v0/v1 geom 100 m from the baro chain is rejected → baro rung', () => {
  const chain = 5000 * FT + N
  for (const version of [0, 1, null]) {
    const r = new AltitudeLadder().height(sample({ version, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: (chain + 100) / FT }))!
    assert.equal(r.source, 'baro-qnh', `version ${version}`)
    near(r.hM, chain, 1e-9)
  }
})

test('ladder: v2 geom is trusted even 100 m from baro (the datum is known)', () => {
  const chain = 5000 * FT + N
  const r = new AltitudeLadder().height(sample({ version: 2, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: (chain + 100) / FT }))!
  assert.equal(r.source, 'geom')
})

test('ladder: learned bias carries geom − baro into baro-bias when geom drops out', () => {
  const lad = new AltitudeLadder()
  const baroFt = 25000 // above 18000 ft: no baro-qnh rung
  const bias = 120 // ISA+ air: geometric height sits above pressure altitude
  for (let i = 0; i < 30; i++) {
    const r = lad.height(sample({ tMs: i * 1000, altBaroFt: baroFt, altGeomFt: (baroFt * FT + N + bias) / FT }))!
    assert.equal(r.source, 'geom')
  }
  const r = lad.height(sample({ tMs: 30_000, altBaroFt: baroFt, altGeomFt: null }))!
  assert.equal(r.source, 'baro-bias')
  near(r.hM, baroFt * FT + N + bias, 0.5)
  // ... and a fresh sample much later still carries the learned bias (the switch offset has bled off by now)
  near(lad.height(sample({ tMs: 300_000, altBaroFt: baroFt, altGeomFt: null }))!.hM, baroFt * FT + N + bias, 0.5)
})

test('ladder: a rejected v0 geom does not teach the bias', () => {
  const lad = new AltitudeLadder()
  const baroFt = 25000
  let r = null
  for (let i = 0; i < 30; i++) {
    r = lad.height(sample({ tMs: i * 1000, version: 0, altBaroFt: baroFt, altGeomFt: (baroFt * FT + N + 100) / FT }))!
    assert.equal(r.source, 'baro-bias')
  }
  near(r!.hM, baroFt * FT + N, 1e-9)
})

test('ladder: switch geom → baro-qnh keeps continuity, steps ≤ 0.5 m per second, then converges', () => {
  const lad = new AltitudeLadder()
  const baroFt = 3000
  const qnh = 1020
  const baroQnh = (baroFt + (qnh - 1013.25) * 27) * FT + N
  const geom = baroQnh + 40 // v2 geom sits 40 m above the QNH-corrected baro
  const out: { t: number; h: number; source: string }[] = []
  for (let t = 0; t <= 200; t++) {
    const r = lad.height(sample({ tMs: t * 1000, altBaroFt: baroFt, navQnhHpa: qnh, altGeomFt: t < 20 ? geom / FT : null }))!
    out.push({ t, h: r.hM, source: r.source })
  }
  assert.equal(out[19].source, 'geom')
  near(out[19].h, geom, 1e-9)
  assert.equal(out[20].source, 'baro-qnh')
  near(out[20].h, geom, 1e-9, 'no step at the switch')
  for (let i = 1; i < out.length; i++) {
    const dt = out[i].t - out[i - 1].t
    assert.ok(Math.abs(out[i].h - out[i - 1].h) <= 0.5 * dt + 1e-9, `step at t=${out[i].t}: ${out[i].h - out[i - 1].h}`)
  }
  near(out.at(-1)!.h, baroQnh, 1e-9, 'converged onto the new rung')
})

test('ladder: an implausible v0 geom jump does not leak into the output', () => {
  const lad = new AltitudeLadder()
  const chain = 5000 * FT + N
  const hs: number[] = []
  for (let t = 0; t < 20; t++) {
    const g = chain + (t < 10 ? 30 : 180) // geom jumps +150 m at t = 10 → rejected
    const r = lad.height(sample({ tMs: t * 1000, version: 0, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: g / FT }))!
    assert.equal(r.source, t < 10 ? 'geom' : 'baro-qnh')
    hs.push(r.hM)
  }
  for (let i = 1; i < hs.length; i++) assert.ok(Math.abs(hs[i] - hs[i - 1]) <= 0.5 + 1e-9, `step at ${i}: ${hs[i] - hs[i - 1]}`)
})

// ---------- VerticalFilter ----------

test('filter: null before the first sample, and before the first sample time', () => {
  const f = new VerticalFilter()
  assert.equal(f.at(0), null)
  f.add(10, 100, null)
  assert.equal(f.at(9.99), null)
  assert.deepEqual(f.at(10), { hM: 100, vsMs: 0 })
})

test('filter: extrapolates with the rate after the last state', () => {
  const f = new VerticalFilter()
  f.add(0, 100, 2)
  const s = f.at(5)!
  near(s.hM, 110, 1e-9)
  near(s.vsMs, 2, 1e-9)
})

test('filter: cubic Hermite between filtered states (smoothstep midpoint)', () => {
  const f = new VerticalFilter({ alpha: 1, beta: 0 }) // α = 1: states sit on the measurements
  f.add(0, 0, 0)
  f.add(1, 1, 0)
  const s = f.at(0.5)!
  near(s.hM, 0.5, 1e-9)
  near(s.vsMs, 1.5, 1e-9)
  near(f.at(1)!.hM, 1, 1e-9)
})

test('filter: a sample at or before the last time is ignored', () => {
  const f = new VerticalFilter()
  f.add(0, 100, 0)
  f.add(0, 500, 0)
  f.add(-1, 500, 0)
  assert.deepEqual(f.at(0), { hM: 100, vsMs: 0 })
})

// A 3° glide at 140 kt: VS ≈ −3.77 m/s. alt quantised to 25 ft, rate to 64 fpm, irregular sample times,
// 0.3 s transport latency, rendered causally 3 s behind at 60 Hz (what Track + RenderClock do).
const VS = -140 * KT * Math.tan((3 * Math.PI) / 180)
const truth = (t: number): number => 1000 + VS * t
const quantFt = (m: number, stepFt: number): number => Math.round(m / FT / stepFt) * stepFt * FT

function rng(seed: number): () => number {
  let x = seed >>> 0
  return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32
}

const RATE_Q = (Math.round(((VS / FT) * 60) / 64) * 64 * FT) / 60 // reported rate, 64 fpm steps

const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]
}

function runDescent(f: VerticalFilter, rateMs: number | null): { posP95: number; vsP95: number; maxStep: number } {
  const next = rng(42)
  const times: number[] = []
  for (let t = 0; t < 200; t += 0.5 + next()) times.push(t)
  const posErr: number[] = []
  const vsErr: number[] = []
  let k = 0
  let prevH: number | null = null
  let maxStep = 0
  for (let frame = 0; frame < 195 * 60; frame++) {
    const T = frame / 60
    while (k < times.length && times[k] + 0.3 <= T) {
      f.add(times[k], quantFt(truth(times[k]), 25), rateMs)
      k++
    }
    const tr = T - 3
    const s = f.at(tr)
    if (s === null) continue
    if (prevH !== null) maxStep = Math.max(maxStep, Math.abs(s.hM - prevH))
    prevH = s.hM
    if (tr >= 20) {
      posErr.push(Math.abs(s.hM - truth(tr)))
      vsErr.push(Math.abs(s.vsMs - VS))
    }
  }
  return { posP95: p95(posErr), vsP95: p95(vsErr), maxStep }
}

test('filter: 3° descent at 140 kt, 25 ft quantised, with reported rate → smooth and accurate', () => {
  // naive linear interpolation of the raw samples scores height p95 ≈ 3.0 m and VS p95 ≈ 6.3 m/s here
  const r = runDescent(new VerticalFilter(), RATE_Q)
  assert.ok(r.posP95 <= 2.5, `height error p95 ${r.posP95.toFixed(2)} m (25 ft steps are 7.6 m)`)
  assert.ok(r.vsP95 <= 2, `VS error p95 ${r.vsP95.toFixed(2)} m/s`)
  assert.ok(r.maxStep <= 1, `max per-frame step ${r.maxStep.toFixed(3)} m`)
})

test('filter: same descent without any reported rate still meets the G2 vertical bar', () => {
  const r = runDescent(new VerticalFilter(), null)
  assert.ok(r.posP95 <= 2.5, `height error p95 ${r.posP95.toFixed(2)} m`)
  assert.ok(r.vsP95 <= 2, `VS error p95 ${r.vsP95.toFixed(2)} m/s`)
  assert.ok(r.maxStep <= 1, `max per-frame step ${r.maxStep.toFixed(3)} m`)
})

test('filter: a reported rate 10 % steeper than the height track (baro rate vs geometric height) does not drag the height away', () => {
  const r = runDescent(new VerticalFilter(), VS * 1.1)
  assert.ok(r.posP95 <= 3, `height error p95 ${r.posP95.toFixed(2)} m`)
  assert.ok(r.vsP95 <= 2, `VS error p95 ${r.vsP95.toFixed(2)} m/s`)
})

test('ladder → filter: a geom → baro-qnh switch mid-descent renders without a VS spike or a frame step > 1 m', () => {
  const lad = new AltitudeLadder()
  const f = new VerticalFilter()
  const qnh = 1020
  const corrM = (qnh - 1013.25) * 27 * FT
  const next = rng(7)
  const times: number[] = []
  for (let t = 0; t < 120; t += 0.5 + next()) times.push(t)
  let k = 0
  let prevH: number | null = null
  let maxStep = 0
  const vsErr: number[] = []
  for (let frame = 0; frame < 115 * 60; frame++) {
    const T = frame / 60
    while (k < times.length && times[k] + 0.3 <= T) {
      const t = times[k]
      const geomM = truth(t) + 40 // geom 40 m above the baro-qnh reading of the same air
      const baroFt = (truth(t) - N - corrM) / FT
      const s = sample({
        tMs: t * 1000,
        altBaroFt: Math.round(baroFt / 25) * 25,
        navQnhHpa: qnh,
        altGeomFt: t < 60 ? Math.round(geomM / FT / 25) * 25 : null,
        geomRateFpm: Math.round(((VS / FT) * 60) / 64) * 64,
      })
      const h = lad.height(s)!
      f.add(t, h.hM, (s.geomRateFpm! * FT) / 60)
      k++
    }
    const st = f.at(T - 3)
    if (st === null) continue
    if (prevH !== null) maxStep = Math.max(maxStep, Math.abs(st.hM - prevH))
    prevH = st.hM
    if (T - 3 >= 20) vsErr.push(Math.abs(st.vsMs - VS))
  }
  // without the ladder's continuity offset the raw 40 m rung jump shows up as VS p95 ≈ 3.1 m/s, max ≈ 12 m/s
  assert.ok(maxStep <= 1, `max per-frame step ${maxStep.toFixed(3)} m`)
  assert.ok(p95(vsErr) <= 2, `VS error p95 ${p95(vsErr).toFixed(2)} m/s`)
  assert.ok(Math.max(...vsErr) <= 4, `VS error max ${Math.max(...vsErr).toFixed(2)} m/s`)
})
