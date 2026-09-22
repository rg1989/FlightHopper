// client/track/vertical.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AltitudeLadder } from './vertical.ts'
import type { Sample } from '../../shared/types.ts'

const FT = 0.3048
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
