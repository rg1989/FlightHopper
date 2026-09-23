// client/browse/fleet.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearingDeg, destination, distanceNm } from '../../shared/geo.ts'
import { toInfo } from '../../shared/info.ts'
import type { Sample } from '../../shared/types.ts'
import { Fleet } from './fleet.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const FT = 0.3048
const T0 = 1_790_000_000_000

const BASE: Sample = {
  hex: 'abc123', tMs: T0, rxMs: T0, lat: 32, lon: 34.8, onGround: false,
  altBaroFt: 35000, altGeomFt: 35500, gsKt: 360, trackDeg: 90, trueHeadingDeg: null, rollDeg: null,
  baroRateFpm: -500, geomRateFpm: -480, navQnhHpa: null, version: 2, nic: 8, quality: 'adsb2', nM: 19.6,
  callsign: 'ELY001', typeCode: 'B738', reg: '4X-EKA',
}
const smp = (o: Partial<Sample> = {}): Sample => ({ ...BASE, ...o })

test('dead-reckons along track at ground speed: 360 kt for 10 s is 1 nm due east on the great circle', () => {
  const f = new Fleet()
  f.ingest([smp()])
  const [e] = f.entries(T0 + 10_000)
  const want = destination(32, 34.8, 90, 1)
  near(e.lat, want.lat, 1e-9)
  near(e.lon, want.lon, 1e-9)
  near(distanceNm(32, 34.8, e.lat, e.lon), 1, 1e-9)
  near(bearingDeg(32, 34.8, e.lat, e.lon), 90, 1e-6)
  assert.equal(e.ageS, 10)
})

test('direction follows the track in every quadrant, across the antimeridian and the equator', () => {
  const cases: [number, number, number][] = [[60, 10, 225], [-33.9, 151.2, 30], [51.5, 179.99, 80], [0.001, 0, 180], [45, -73, 315]]
  for (const [lat, lon, trk] of cases) {
    const f = new Fleet()
    f.ingest([smp({ lat, lon, trackDeg: trk, gsKt: 480 })])
    const [e] = f.entries(T0 + 15_000) // 480 kt × 15 s = 2 nm
    const want = destination(lat, lon, trk, 2)
    near(e.lat, want.lat, 1e-9, `lat from ${lat},${lon} trk ${trk}`)
    near(e.lon, want.lon, 1e-9, `lon from ${lat},${lon} trk ${trk}`)
    near(distanceNm(lat, lon, e.lat, e.lon), 2, 1e-9)
  }
})

test('dead-reckoning stops 60 s after the newest sample; before the sample the sample position is used', () => {
  const f = new Fleet()
  f.ingest([smp()])
  const at60 = { ...f.entries(T0 + 60_000)[0] }
  const at90 = f.entries(T0 + 90_000)[0]
  assert.equal(at90.lat, at60.lat)
  assert.equal(at90.lon, at60.lon)
  near(distanceNm(32, 34.8, at90.lat, at90.lon), 6, 1e-9)
  assert.equal(at90.ageS, 90) // the age keeps counting
  const early = f.entries(T0 - 5_000)[0]
  assert.equal(early.lat, 32)
  assert.equal(early.lon, 34.8)
  assert.equal(early.ageS, 0)
})

test('no motion when parked on the ground (< 3 kt) or when track or speed is unknown; taxiing moves', () => {
  const f = new Fleet()
  const ground = { onGround: true, altBaroFt: null, altGeomFt: null }
  f.ingest([
    smp({ hex: 'a00001', ...ground, gsKt: 2.9 }),
    smp({ hex: 'a00002', ...ground, gsKt: 15, trackDeg: 0 }),
    smp({ hex: 'a00003', trackDeg: null }),
    smp({ hex: 'a00004', gsKt: null }),
  ])
  f.entries(T0 + 10_000)
  const g = (hex: string) => f.get(hex)!
  for (const hex of ['a00001', 'a00003', 'a00004']) {
    assert.equal(g(hex).lat, 32, hex)
    assert.equal(g(hex).lon, 34.8, hex)
    assert.equal(g(hex).ageS, 10, hex)
  }
  near(distanceNm(32, 34.8, g('a00002').lat, g('a00002').lon), (15 * 10) / 3600, 1e-12)
  near(g('a00002').lon, 34.8, 1e-9) // due north
  assert.ok(g('a00002').lat > 32)
  assert.equal(g('a00001').onGround, true)
  assert.equal(g('a00001').hM, 19.6) // on the ground: the geoid
  assert.equal(g('a00001').altFt, null)
})

test('altitude fields: altFt = baro ?? geom; hM = geom (v2 HAE) else baro + N; vsFpm = baro rate ?? geom rate', () => {
  const f = new Fleet()
  f.ingest([
    smp({ hex: 'b00001' }), // v2: geom is HAE
    smp({ hex: 'b00002', version: 1 }), // v0/v1: geom is not HAE → baro + N
    smp({ hex: 'b00003', altGeomFt: null }), // v2 without geom → baro + N
    smp({ hex: 'b00004', version: 0, altBaroFt: null, baroRateFpm: null }), // geom only, not HAE → geom + N
    smp({ hex: 'b00005', altBaroFt: null, altGeomFt: null, baroRateFpm: null, geomRateFpm: null, version: null }),
    smp({ hex: 'b00006', onGround: true, altBaroFt: null, altGeomFt: 120, gsKt: 0 }), // ground wins over geom
  ])
  f.entries(T0)
  const g = (hex: string) => f.get(hex)!
  near(g('b00001').hM, 35500 * FT, 1e-9)
  near(g('b00002').hM, 35000 * FT + 19.6, 1e-9)
  near(g('b00003').hM, 35000 * FT + 19.6, 1e-9)
  near(g('b00004').hM, 35500 * FT + 19.6, 1e-9)
  assert.equal(g('b00005').hM, 19.6)
  assert.equal(g('b00006').hM, 19.6)
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((i) => g(`b0000${i}`).altFt), [35000, 35000, 35000, 35500, null, 120])
  assert.deepEqual([1, 4, 5].map((i) => g(`b0000${i}`).vsFpm), [-500, -480, null])
  assert.deepEqual({ ...g('b00001'), hM: 0 }, {
    hex: 'b00001', lat: 32, lon: 34.8, hM: 0, altFt: 35000, onGround: false, trackDeg: 90, gsKt: 360,
    vsFpm: -500, ageS: 0, quality: 'adsb2', info: null,
  })
})

test('keeps only the newest sample per hex: older and same-tMs samples are ignored, in any batch order', () => {
  const f = new Fleet()
  f.ingest([smp({ tMs: T0 + 5_000, lat: 33, trackDeg: null }), smp({ tMs: T0, lat: 31 })])
  f.ingest([smp({ tMs: T0 + 5_000, lat: 40 }), smp({ tMs: T0 + 1_000, lat: 41 })])
  assert.equal(f.size, 1)
  assert.equal(f.entries(T0 + 5_000)[0].lat, 33)
  const s6 = smp({ tMs: T0 + 6_000, lat: 34, trackDeg: null, quality: 'mlat' })
  f.ingest([s6])
  const e = f.entries(T0 + 6_000)[0]
  assert.equal(e.lat, 34)
  assert.equal(e.quality, 'mlat')
  assert.equal(f.newest('abc123'), s6)
  assert.equal(f.newest('ffffff'), undefined)
})

test('a newer sample updates the entry at once (get() is right before the next entries())', () => {
  const f = new Fleet()
  f.ingest([smp({ trackDeg: null })])
  f.entries(T0 + 3_000)
  f.ingest([smp({ tMs: T0 + 2_000, lat: 32.5, trackDeg: null, altBaroFt: 1000 })])
  const e = f.get('abc123')!
  assert.equal(e.lat, 32.5)
  assert.equal(e.altFt, 1000)
  assert.equal(e.ageS, 1) // measured at the last entries() time
})

test('info: the latest AircraftInfo per hex is attached to its entry, arriving with, after or before the sample', () => {
  const f = new Fleet()
  const i1 = toInfo({ hex: 'abc123', flight: 'ELY001', squawk: '1000' })
  f.ingest([smp()], [i1])
  const e = f.get('abc123')!
  assert.equal(e.info, i1)
  const i2 = { ...i1, squawk: '7700' }
  f.ingest([], [i2])
  assert.equal(f.get('abc123'), e) // same object, new info
  assert.equal(e.info, i2)
  f.ingest([smp({ tMs: T0 + 1_000 })]) // a reply without info keeps the info
  assert.equal(e.info, i2)
  const early = toInfo({ hex: 'def456', flight: 'LY001' })
  f.ingest([], [early])
  assert.equal(f.get('def456'), undefined) // info alone is not an aircraft
  assert.equal(f.size, 1)
  f.ingest([smp({ hex: 'def456' })])
  assert.equal(f.get('def456')!.info, early)
})

test('prune forgets hexes whose newest sample is older than maxAgeS; the others keep their objects and positions', () => {
  const f = new Fleet()
  f.ingest([smp({ hex: 'a00001', tMs: T0 }), smp({ hex: 'a00002', tMs: T0 + 30_000 }), smp({ hex: 'a00003', tMs: T0 + 50_000 })])
  const e2 = f.get('a00002')!
  const e3 = f.get('a00003')!
  f.prune(T0 + 70_000, 60)
  assert.equal(f.size, 2)
  assert.equal(f.get('a00001'), undefined)
  assert.deepEqual(f.entries(T0 + 70_000).map((e) => e.hex).sort(), ['a00002', 'a00003'])
  assert.equal(f.get('a00002'), e2)
  f.prune(T0 + 90_000, 60) // exactly maxAgeS old stays
  assert.equal(f.size, 2)
  f.prune(T0 + 90_001, 60)
  const left = f.entries(T0 + 90_001)
  assert.deepEqual(left.map((e) => e.hex), ['a00003'])
  assert.equal(left[0], e3)
  near(distanceNm(32, 34.8, e3.lat, e3.lon), 4.0001, 1e-9) // 40.001 s old at 360 kt
  f.prune(T0 + 1e9, 60)
  assert.equal(f.size, 0)
  assert.equal(f.entries(T0 + 1e9).length, 0)
})

test('prune: info outlives its hex for an hour, because the server resends info only when it changes', () => {
  const f = new Fleet()
  const info = toInfo({ hex: 'abc123', flight: 'ELY001' })
  f.ingest([smp()], [info])
  f.prune(T0 + 120_000, 60)
  assert.equal(f.size, 0)
  f.ingest([smp({ tMs: T0 + 600_000 })]) // back 10 min later, no info in this reply
  assert.equal(f.get('abc123')!.info, info)
  f.prune(T0 + 700_000, 60) // gone again; its newest sample was T0 + 600 s
  f.prune(T0 + 600_000 + 3_600_000, 60) // exactly an hour: still kept
  f.ingest([smp({ tMs: T0 + 4_100_000 })])
  assert.equal(f.get('abc123')!.info, info)
  f.prune(T0 + 4_200_000, 60)
  f.prune(T0 + 4_100_000 + 3_600_001, 60) // more than an hour after its newest sample: forgotten
  f.ingest([smp({ tMs: T0 + 8_000_000 })])
  assert.equal(f.get('abc123')!.info, null)
  f.ingest([], [toInfo({ hex: 'fff000' })]) // info for a hex that never showed up goes at the next prune
  f.prune(T0 + 8_000_000, 60)
  f.ingest([smp({ hex: 'fff000', tMs: T0 + 8_000_001 })])
  assert.equal(f.get('fff000')!.info, null)
})

test('entries() reuses one array and one object per aircraft between frames (no per-frame allocation)', () => {
  const f = new Fleet()
  f.ingest([smp({ hex: 'a00001' }), smp({ hex: 'a00002', trackDeg: 0 })])
  const a = f.entries(T0 + 1_000)
  const objs = [...a]
  const lat2 = f.get('a00002')!.lat
  const b = f.entries(T0 + 2_000)
  assert.equal(b, a)
  assert.equal(b.length, 2)
  b.forEach((e, i) => assert.equal(e, objs[i]))
  assert.ok(f.get('a00002')!.lat > lat2) // moved north in place
  assert.equal(f.get('a00001'), objs.find((e) => e.hex === 'a00001'))
  f.ingest([smp({ hex: 'a00001', tMs: T0 + 1_500 })]) // a newer sample updates the same object
  const c = f.entries(T0 + 3_000)
  assert.equal(c, a)
  c.forEach((e, i) => assert.equal(e, objs[i]))
  f.ingest([smp({ hex: 'a00003' })]) // a new hex joins the same array
  assert.equal(f.entries(T0 + 3_000), a)
  assert.equal(a.length, 3)
})

test('perf: entries() for 10,000 aircraft, CPU p95 ≤ 2 ms', (t) => {
  const f = new Fleet()
  const samples: Sample[] = []
  for (let i = 0; i < 10_000; i++) {
    samples.push(smp({
      hex: i.toString(16).padStart(6, '0'),
      tMs: T0 - (i % 15) * 1_000,
      lat: -70 + (i % 140),
      lon: -180 + i * 0.036,
      trackDeg: i % 11 === 0 ? null : (i * 37) % 360,
      gsKt: 80 + (i % 420),
      onGround: i % 50 === 0,
    }))
  }
  f.ingest(samples)
  assert.equal(f.size, 10_000)
  for (let i = 0; i < 300; i++) f.entries(T0 + i * 16) // warm up the JIT
  // Wall time is reported; the budget is checked on this process's CPU time per call, which a busy machine (npm test
  // runs the test files in parallel next to other work) cannot inflate by descheduling us mid-call.
  const pct = (xs: number[], q: number): number => xs[Math.floor(xs.length * q)]
  const wallMs: number[] = []
  const cpuMs: number[] = []
  for (let i = 0; i < 500; i++) {
    const c0 = process.cpuUsage()
    const t0 = performance.now()
    f.entries(T0 + 5_000 + i * 16)
    wallMs.push(performance.now() - t0)
    const c = process.cpuUsage(c0)
    cpuMs.push((c.user + c.system) / 1000)
  }
  wallMs.sort((x, y) => x - y)
  cpuMs.sort((x, y) => x - y)
  t.diagnostic(`entries() × 10,000 aircraft: wall p50 ${pct(wallMs, 0.5).toFixed(3)} ms, p95 ${pct(wallMs, 0.95).toFixed(3)} ms; ` +
    `CPU p50 ${pct(cpuMs, 0.5).toFixed(3)} ms, p95 ${pct(cpuMs, 0.95).toFixed(3)} ms`)
  assert.ok(pct(cpuMs, 0.95) <= 2, `CPU p95 ${pct(cpuMs, 0.95)} ms`)
})
