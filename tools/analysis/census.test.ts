// tools/analysis/census.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Airport } from '../../shared/airports.ts'
import { destination } from '../../shared/geo.ts'
import { geoidN } from '../../shared/geoid.ts'
import type { Sample } from '../../shared/types.ts'
import { type Arrival, aglFt, findArrivals, summarizeCensus } from './census.ts'

const airports: Airport[] = JSON.parse(readFileSync(new URL('../../data/fixtures/golden/airports-sample.json', import.meta.url), 'utf8'))
const ksfo = airports.find((a) => a.ident === 'KSFO')!
const ends = ksfo.runways.flatMap((r) => r.ends)
const e28r = ends.find((e) => e.ident === '28R')!
const e28l = ends.find((e) => e.ident === '28L')!
const FT = 0.3048
const TAN3 = Math.tan((3 * Math.PI) / 180)

const BASE: Sample = {
  hex: 'a00001', tMs: 0, rxMs: 0, lat: 0, lon: 0, onGround: false, altBaroFt: null, altGeomFt: null, gsKt: 140,
  trackDeg: 298, trueHeadingDeg: null, rollDeg: null, baroRateFpm: -750, geomRateFpm: null, navQnhHpa: 1013.2,
  version: 2, nic: 8, quality: 'adsb2', nM: 0, callsign: null, typeCode: null, reg: null,
}

type ApproachOpts = {
  t0Ms?: number
  stepS?: number // sample spacing
  slowBelowFt?: number // switch to slowStepS below this AGL
  slowStepS?: number
  lostBelowFt?: number // coverage ends before going below this AGL
  ground?: boolean // add 5 rollout samples (default true)
  version?: number
  geom?: boolean
  nic?: (i: number) => number | null
  jumpAt?: number // displace sample i by 5 km to the right
}

/** A 140 kt arrival on the KSFO 28R 3° glidepath from 12 nm, altitudes consistent in baro (QNH 1013.2) and HAE geom. */
function approach(hex: string, o: ApproachOpts = {}): Sample[] {
  const mps = (140 * 1852) / 3600
  const t0 = o.t0Ms ?? 0
  const out: Sample[] = []
  let t = 0
  for (let i = 0; ; i++) {
    const d = 12 - (t * mps) / 1852
    if (d <= 0) break
    const agl = (15 + d * 1852 * TAN3) / FT
    if (o.lostBelowFt !== undefined && agl < o.lostBelowFt) return out
    let p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg + 180, d)
    if (o.jumpAt === i) p = destination(p.lat, p.lon, e28r.hdgTrueDeg + 90, 5000 / 1852)
    const mslFt = e28r.elevFt + agl
    out.push({
      ...BASE, hex, tMs: t0 + t * 1000, rxMs: t0 + t * 1000 + 500, lat: p.lat, lon: p.lon,
      altBaroFt: Math.round(mslFt / 25) * 25, altGeomFt: o.geom === false ? null : (mslFt * FT + geoidN(p.lat, p.lon)) / FT,
      version: o.version ?? 2, nic: o.nic ? o.nic(i) : 8, callsign: 'UAL123',
    })
    t += o.slowBelowFt !== undefined && agl < o.slowBelowFt ? o.slowStepS! : (o.stepS ?? 2)
  }
  if (o.ground === false) return out
  let past = (t * mps) / 1852 - 12
  for (let k = 0; k < 5; k++, t += 2, past += 0.05) {
    const p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg, past)
    out.push({ ...BASE, hex, tMs: t0 + t * 1000, lat: p.lat, lon: p.lon, onGround: true, gsKt: 100 - 15 * k, version: o.version ?? 2, callsign: 'UAL123' })
  }
  return out
}

/** Takeoff from 28L: 4 ground samples, then a climb along 298° to 3,000 ft. */
function departure(hex: string, t0Ms: number): Sample[] {
  const out: Sample[] = []
  for (let k = 0; k < 40; k++) {
    const x = 0.1 + k * 0.08 // nm past the 28L threshold
    const p = destination(e28l.thrLat, e28l.thrLon, e28l.hdgTrueDeg, x)
    const onGround = k < 4
    const altFt = onGround ? null : 13 + (x - 0.3) * 1000
    out.push({ ...BASE, hex, tMs: t0Ms + k * 2000, lat: p.lat, lon: p.lon, onGround, altBaroFt: altFt, altGeomFt: altFt === null ? null : (altFt * FT + geoidN(p.lat, p.lon)) / FT, gsKt: 150 })
  }
  return out
}

test('aglFt: ground 0; v2 alt_geom above airport HAE; else QNH-corrected baro; else raw baro; else null', () => {
  const apHaeFt = ksfo.elevFt + ksfo.nM / FT
  assert.equal(aglFt({ ...BASE, onGround: true, altGeomFt: 500 }, ksfo), 0)
  assert.equal(aglFt({ ...BASE, altGeomFt: 400, altBaroFt: 900 }, ksfo), 400 - apHaeFt)
  assert.equal(aglFt({ ...BASE, version: 0, altGeomFt: 400, altBaroFt: 900, navQnhHpa: 1000 }, ksfo), 900 + (1000 - 1013.25) * 27 - 13)
  assert.equal(aglFt({ ...BASE, version: 0, altBaroFt: 900, navQnhHpa: null }, ksfo), 900 - 13)
  assert.equal(aglFt({ ...BASE, version: 1, altBaroFt: 900, navQnhHpa: 1100 }, ksfo), 900 - 13)
  assert.equal(aglFt({ ...BASE, version: 0, altBaroFt: 20_000, navQnhHpa: 1000 }, ksfo), 20_000 - 13)
  assert.equal(aglFt({ ...BASE, version: 0 }, ksfo), null)
})

test('an arrival tracked to the ground: min AGL 0, reached ground, no jumps, full geom share', () => {
  const [a] = findArrivals(approach('a00001'), ksfo)
  assert.equal(a.hex, 'a00001')
  assert.equal(a.callsign, 'UAL123')
  assert.equal(a.minAglFt, 0)
  assert.equal(a.reachedGround, true)
  assert.equal(a.p90GapBelow1000S, 2)
  assert.equal(a.geomShare, 1)
  assert.equal(a.badNicShare, 0)
  assert.equal(a.jumps, 0)
})

test('an arrival lost at 2,500 ft AGL still counts, with its lowest height and no gap stat', () => {
  const [a] = findArrivals(approach('a00002', { lostBelowFt: 2500 }), ksfo)
  assert.ok(a.minAglFt >= 2500 && a.minAglFt < 2530, `minAglFt ${a.minAglFt}`)
  assert.equal(a.reachedGround, false)
  assert.equal(a.p90GapBelow1000S, null)
})

test('gaps below 1,000 ft AGL: 10 s spacing down low gives p90 10 s', () => {
  const [a] = findArrivals(approach('a00003', { slowBelowFt: 1200, slowStepS: 10 }), ksfo)
  assert.equal(a.p90GapBelow1000S, 10)
  assert.equal(a.reachedGround, true)
})

test('nic < 6 share, missing alt_geom share, and a 5 km position jump', () => {
  const nic = approach('a00004', { nic: (i) => (i % 2 === 0 ? 3 : 8), ground: false })
  const [n] = findArrivals(nic, ksfo)
  assert.equal(n.badNicShare, nic.filter((s) => s.nic === 3).length / nic.length)
  const [g] = findArrivals(approach('a00005', { geom: false, version: 0 }), ksfo)
  assert.equal(g.geomShare, 0)
  assert.equal(g.minAglFt, 0)
  const [j] = findArrivals(approach('a00006', { jumpAt: 100 }), ksfo)
  assert.equal(j.jumps, 2) // out to the false position and back
})

test('departures, overflights and traffic outside 15 nm are not arrivals', () => {
  const overflight = approach('b00002', { ground: false }).map((s) => ({ ...s, altBaroFt: 10_000, altGeomFt: 10_000 }))
  const far = approach('b00003').map((s) => ({ ...s, lat: s.lat + 1 }))
  assert.deepEqual(findArrivals([...departure('b00001', 0), ...overflight, ...far], ksfo), [])
})

test('landing then departing in one visit is one arrival that ends at touchdown', () => {
  const arr = approach('a00007')
  const dep = departure('a00007', arr.at(-1)!.tMs + 5 * 60_000)
  const found = findArrivals([...dep, ...arr], ksfo)
  assert.equal(found.length, 1)
  assert.deepEqual(found[0], findArrivals(arr, ksfo)[0])
})

test('the same airframe arriving twice an hour apart is two arrivals, ordered by time', () => {
  const found = findArrivals([...approach('a00008', { t0Ms: 3_600_000 }), ...approach('a00009', { t0Ms: 1_800_000, lostBelowFt: 2500 }), ...approach('a00008')], ksfo)
  assert.deepEqual(found.map((a) => [a.hex, a.reachedGround]), [['a00008', true], ['a00009', false], ['a00008', true]])
})

const A = (minAglFt: number, extra: Partial<Arrival> = {}): Arrival => ({
  hex: 'x', callsign: null, minAglFt, reachedGround: minAglFt === 0, p90GapBelow1000S: 2, geomShare: 1, badNicShare: 0, jumps: 0, ...extra,
})

test('summarizeCensus: landing hero needs ≥ 80 % of arrivals tracked below 200 ft AGL', () => {
  const ok = summarizeCensus([A(0), A(0), A(50), A(199), A(2500)])
  assert.equal(ok.arrivals, 5)
  assert.equal(ok.trackedBelow200Pct, 80)
  assert.equal(ok.landingHeroOk, true)
  const bad = summarizeCensus([A(0), A(0), A(200), A(2500), A(0)])
  assert.equal(bad.trackedBelow200Pct, 60)
  assert.equal(bad.landingHeroOk, false)
})

test('summarizeCensus: gap p90 across arrivals, geom and bad-nic shares as mean percentages', () => {
  const s = summarizeCensus([
    A(0, { p90GapBelow1000S: 2, geomShare: 1, badNicShare: 0 }),
    A(0, { p90GapBelow1000S: 4, geomShare: 0.5, badNicShare: 0.5 }),
    A(0, { p90GapBelow1000S: 6 }),
    A(0, { p90GapBelow1000S: 8 }),
    A(0, { p90GapBelow1000S: 10 }),
    A(2500, { p90GapBelow1000S: null }),
  ])
  assert.ok(Math.abs(s.p90GapBelow1000S! - 9.2) < 1e-9)
  assert.ok(Math.abs(s.geomSharePct - (100 * 5.5) / 6) < 1e-9)
  assert.ok(Math.abs(s.badNicPct - (100 * 0.5) / 6) < 1e-9)
})

test('summarizeCensus: no arrivals → not a landing hero', () => {
  assert.deepEqual(summarizeCensus([]), { arrivals: 0, trackedBelow200Pct: 0, p90GapBelow1000S: null, geomSharePct: 0, badNicPct: 0, landingHeroOk: false })
})
