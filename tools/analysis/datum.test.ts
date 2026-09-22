// tools/analysis/datum.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Airport } from '../../shared/airports.ts'
import { destination } from '../../shared/geo.ts'
import { geoidN } from '../../shared/geoid.ts'
import type { Sample } from '../../shared/types.ts'
import { alongCross, approachResiduals, quantile, summarizeDatum } from './datum.ts'

const airports: Airport[] = JSON.parse(readFileSync(new URL('../../data/fixtures/golden/airports-sample.json', import.meta.url), 'utf8'))
const ksfo = airports.find((a) => a.ident === 'KSFO')!
const e28r = ksfo.runways.flatMap((r) => r.ends).find((e) => e.ident === '28R')!
const GLIDE = Math.tan((3 * Math.PI) / 180)

const BASE: Sample = {
  hex: 'a00001', tMs: 0, rxMs: 0, lat: 0, lon: 0, onGround: false, altBaroFt: null, altGeomFt: null, gsKt: 140,
  trackDeg: 298, trueHeadingDeg: null, rollDeg: null, baroRateFpm: -750, geomRateFpm: null, navQnhHpa: null,
  version: 2, nic: 8, quality: 'adsb2', nM: 0, callsign: null, typeCode: null, reg: null,
}

type PathOpts = { msl?: boolean; offsetM?: number; version?: number; tMs?: number; trackDeg?: number; onGround?: boolean; noGeom?: boolean }

/** A sample dNm before the 28R threshold (offsetM right of the centreline), exactly on the 3° path with TCH 15 m. */
function onPath(hex: string, dNm: number, o: PathOpts = {}): Sample {
  let p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg + 180, dNm)
  if (o.offsetM) p = destination(p.lat, p.lon, e28r.hdgTrueDeg + 90, o.offsetM / 1852)
  const haeM = e28r.thrHaeM + 15 + dNm * 1852 * GLIDE
  const geomM = o.msl ? haeM - geoidN(p.lat, p.lon) : haeM
  return {
    ...BASE, hex, tMs: o.tMs ?? 0, lat: p.lat, lon: p.lon, onGround: o.onGround ?? false,
    altGeomFt: o.noGeom ? null : geomM / 0.3048, version: o.version ?? 2, trackDeg: o.trackDeg ?? e28r.hdgTrueDeg,
  }
}

/** One arrival from 2.95 nm to 0.15 nm, 0.1 nm apart (≈ 2.6 s at 140 kt), starting at t0Ms. */
function arrival(hex: string, t0Ms: number, o: PathOpts = {}): Sample[] {
  const out: Sample[] = []
  for (let k = 0; k < 29; k++) out.push(onPath(hex, 2.95 - k * 0.1, { ...o, tMs: t0Ms + k * 2600 }))
  return out
}

test('alongCross: positive before the threshold, signed right of the landing direction', () => {
  const p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg + 180, 1)
  const right = destination(p.lat, p.lon, e28r.hdgTrueDeg + 90, 50 / 1852)
  const a = alongCross(right.lat, right.lon, e28r)
  assert.ok(Math.abs(a.alongNm - 1) < 1e-4, `along ${a.alongNm}`)
  assert.ok(Math.abs(a.crossM - 50) < 0.1, `cross ${a.crossM}`)
  const past = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg, 0.5)
  assert.ok(alongCross(past.lat, past.lon, e28r).alongNm < -0.49)
})

test('true HAE alt_geom on the 3° glidepath → residuals ≈ 0 and the gate passes', () => {
  const samples = [...arrival('a00001', 0), ...arrival('a00002', 600_000), ...arrival('a00003', 1_200_000)]
  const res = approachResiduals(samples, e28r)
  assert.equal(res.length, 3 * 17) // 0.35 … 1.95 nm per arrival
  assert.ok(res.every((r) => Math.abs(r.rM) < 0.01 && r.dNm >= 0.3 && r.dNm <= 2 && r.version === 2))
  const sum = summarizeDatum(res)
  assert.equal(sum.arrivals, 3)
  assert.equal(sum.n, 51)
  assert.ok(Math.abs(sum.medianM) < 0.01, `median ${sum.medianM}`)
  assert.equal(sum.pass, true)
})

test('alt_geom that is really MSL → median ≈ −N ≈ +32.3 m at KSFO and the gate fails', () => {
  const samples = [...arrival('a00001', 0, { msl: true }), ...arrival('a00002', 600_000, { msl: true }), ...arrival('a00003', 1_200_000, { msl: true })]
  const sum = summarizeDatum(approachResiduals(samples, e28r))
  assert.ok(Math.abs(sum.medianM - 32.3) < 0.15, `median ${sum.medianM}`)
  assert.equal(sum.pass, false)
})

test('only airborne samples with alt_geom, 0.3–2 nm before the threshold, ≤ 100 m off the centreline, flying the runway heading', () => {
  const keep = [onPath('b1', 1, { offsetM: 90 }), onPath('b2', 1.5, { offsetM: -90 })]
  const drop = [
    onPath('c1', 0.25),
    onPath('c2', 2.1),
    onPath('c3', 1, { offsetM: 150 }),
    onPath('c4', 1, { offsetM: -150 }),
    onPath('c5', 1, { trackDeg: 118 }), // departure off the reciprocal runway
    onPath('c6', 1, { onGround: true }),
    onPath('c7', 1, { noGeom: true }),
    { ...onPath('c8', 1), ...destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg, 0.5) }, // past the threshold
  ]
  const res = approachResiduals([...keep, ...drop], e28r)
  assert.deepEqual(res.map((r) => r.hex), ['b1', 'b2'])
  assert.ok(res.every((r) => Math.abs(r.rM) < 0.05))
})

test('v0 samples are reported with their version but kept out of the gate', () => {
  const v2 = [...arrival('a00001', 0), ...arrival('a00002', 600_000), ...arrival('a00003', 1_200_000)]
  const v0 = [...arrival('b00001', 0, { msl: true, version: 0 }), ...arrival('b00002', 0, { msl: true, version: 0 })]
  const res = approachResiduals([...v2, ...v0], e28r)
  assert.equal(res.filter((r) => r.version === 0).length, 2 * 17)
  const sum = summarizeDatum(res)
  assert.equal(sum.n, 51)
  assert.equal(sum.arrivals, 3)
  assert.ok(Math.abs(sum.medianM) < 0.01)
  assert.equal(sum.pass, true)
})

test('fewer than minArrivals v2 arrivals → no pass; one airframe twice (> 10 min apart) counts twice', () => {
  const two = approachResiduals([...arrival('a00001', 0), ...arrival('a00002', 0)], e28r)
  assert.equal(summarizeDatum(two).pass, false)
  assert.equal(summarizeDatum(two, 2).pass, true)
  const again = approachResiduals([...arrival('a00001', 0), ...arrival('a00001', 3_600_000)], e28r)
  assert.equal(summarizeDatum(again).arrivals, 2)
})

test('no residuals → NaN median, no pass', () => {
  const sum = summarizeDatum([])
  assert.deepEqual({ ...sum, medianM: Number.isNaN(sum.medianM) }, { arrivals: 0, n: 0, medianM: true, pass: false })
})

test('quantile: linear interpolation, unsorted input, empty → NaN', () => {
  assert.equal(quantile([3, 1, 2], 0.5), 2)
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(quantile([0, 10], 0.9), 9)
  assert.ok(Number.isNaN(quantile([], 0.5)))
})
