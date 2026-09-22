// client/track/track.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Enu } from '../../shared/enu.ts'
import type { Sample } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import { hermite } from './hermite.ts'
import { velocitiesFromPositions } from './mlat.ts'
import { Track } from './track.ts'
import type { PosT } from './types.ts'

const KT = 1852 / 3600
const FT = 0.3048
const R = 6_371_000
const T0 = 1_760_000_000_000 // server-clock ms of t = 0 s
const frame = new Enu(32.0, 34.9, 0) // truth frame; near LLBG
const rad = (d: number): number => (d * Math.PI) / 180
const wrap180 = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

/** A Sample with realistic defaults (v2 ADS-B airborne at 10 000 ft); tests override what they need. */
function sample(o: Partial<Sample> & Pick<Sample, 'tMs' | 'lat' | 'lon'>): Sample {
  return {
    hex: 'abc123', rxMs: o.tMs + 1000, onGround: false, altBaroFt: 10000, altGeomFt: 10200, gsKt: null, trackDeg: null,
    trueHeadingDeg: null, rollDeg: null, baroRateFpm: null, geomRateFpm: null, navQnhHpa: null, version: 2, nic: 8,
    quality: 'adsb2', nM: 19.6, callsign: 'ELY001', typeCode: 'B738', reg: '4X-EKA', ...o,
  }
}

interface Truth { e: number; n: number; ve: number; vn: number }
type Path = (t: number) => Truth

/** Surface point whose horizontal ENU coordinates in `frame` are (e, n). */
const geo = (e: number, n: number): { lat: number; lon: number } => frame.inv(e, n, -(e * e + n * n) / (2 * R))

/** Sample of the truth path at t s: exact position; gs and track (local true azimuth of the velocity) as reported. */
function truthSample(path: Path, t: number, o: Partial<Sample> = {}): Sample {
  const p = path(t)
  const g = geo(p.e, p.n)
  const ahead = geo(p.e + p.ve * 0.01, p.n + p.vn * 0.01)
  const [de, dn] = new Enu(g.lat, g.lon, 0).fwd(ahead.lat, ahead.lon, 0)
  const trackDeg = ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360
  return sample({ tMs: T0 + t * 1000, lat: g.lat, lon: g.lon, gsKt: Math.hypot(p.ve, p.vn) / KT, trackDeg, ...o })
}

const straight = (v: number, trkDeg: number): Path => (t) => {
  const a = rad(trkDeg)
  return { e: v * t * Math.sin(a), n: v * t * Math.cos(a), ve: v * Math.sin(a), vn: v * Math.cos(a) }
}

/** Straight on trk0Deg until tTurn, then a constant turn of wDegS (+ = right). */
const turning = (v: number, trk0Deg: number, wDegS: number, tTurn = 0): Path => (t) => {
  if (t <= tTurn) return straight(v, trk0Deg)(t)
  const p0 = straight(v, trk0Deg)(tTurn)
  const a0 = rad(trk0Deg)
  const w = rad(wDegS)
  const psi = a0 + w * (t - tTurn)
  return { e: p0.e + (v / w) * (Math.cos(a0) - Math.cos(psi)), n: p0.n + (v / w) * (Math.sin(psi) - Math.sin(a0)), ve: v * Math.sin(psi), vn: v * Math.cos(psi) }
}

const errM = (s: RenderState, path: Path, t: number): number => {
  const [e, n] = frame.fwd(s.lat, s.lon, 0)
  const p = path(t)
  return Math.hypot(e - p.e, n - p.n)
}

interface Frame { t: number; s: RenderState }

/** Client-side causal playback: each sample becomes visible latencyS after its tMs; renders at 60 Hz, delayS behind. */
function replay(track: Track, samples: Sample[], o: { fromS: number; toS: number; delayS: number; latencyS?: number }): Frame[] {
  const out: Frame[] = []
  let k = 0
  for (let f = Math.round(o.fromS * 60); f <= Math.round(o.toS * 60); f++) {
    const now = T0 + (f * 1000) / 60
    while (k < samples.length && samples[k].tMs + (o.latencyS ?? 1) * 1000 <= now) track.add(samples[k++])
    const tR = now - o.delayS * 1000
    const s = track.stateAt(tR)
    if (s) out.push({ t: (tR - T0) / 1000, s })
  }
  return out
}

const enuOf = (fr: Frame[]): PosT[] => fr.map(({ t, s }) => { const [e, n] = frame.fwd(s.lat, s.lon, 0); return { t, e, n } })

/** Largest change of the per-frame displacement: a position jump of X m shows up as X. */
function maxJumpM(p: PosT[]): number {
  let m = 0
  for (let i = 2; i < p.length; i++) m = Math.max(m, Math.hypot(p[i].e - 2 * p[i - 1].e + p[i - 2].e, p[i].n - 2 * p[i - 1].n + p[i - 2].n))
  return m
}

const pct = (xs: number[], q: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }

/** p99 of the acceleration component perpendicular to the velocity, from 60 Hz positions. */
function latAccP99(p: PosT[]): number {
  const a: number[] = []
  for (let i = 1; i < p.length - 1; i++) {
    const dt = (p[i + 1].t - p[i - 1].t) / 2
    const ve = (p[i + 1].e - p[i - 1].e) / (2 * dt)
    const vn = (p[i + 1].n - p[i - 1].n) / (2 * dt)
    const ae = (p[i + 1].e - 2 * p[i].e + p[i - 1].e) / (dt * dt)
    const an = (p[i + 1].n - 2 * p[i].n + p[i - 1].n) / (dt * dt)
    a.push(Math.abs(ae * vn - an * ve) / Math.hypot(ve, vn))
  }
  return pct(a, 0.99)
}

/** Deterministic Gaussian noise (mulberry32 + Box–Muller) and uniform [0, 1). */
function rng(seed: number): { uni: () => number; gauss: () => number } {
  let a = seed >>> 0
  const uni = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { uni, gauss: () => Math.sqrt(-2 * Math.log(1 - uni())) * Math.cos(2 * Math.PI * uni()) }
}

const times = (from: number, to: number, step: number): number[] => { const t: number[] = []; for (let x = from; x <= to + 1e-9; x += step) t.push(x); return t }

test('straight flight: reproduced between samples, track and speed as reported', () => {
  const path = straight(230, 60)
  const tr = new Track('abc123')
  for (const t of times(0, 30, 1)) assert.equal(tr.add(truthSample(path, t)), true)
  let worst = 0
  for (let t = 0; t <= 30; t += 1 / 60) {
    const s = tr.stateAt(T0 + t * 1000)!
    assert.equal(s.mode, 'interp')
    worst = Math.max(worst, errM(s, path, t))
  }
  assert.ok(worst < 0.05, `max error ${worst} m`)
  const s = tr.stateAt(T0 + 12_500)!
  const local = truthSample(path, 12.5).trackDeg! // 60° in the truth frame; 60.013° as local true track 2.9 km away
  near(s.trackDeg!, local, 0.001)
  near(s.headingDeg, local, 0.001)
  near(s.gsKt!, 230 / KT, 0.01)
  near(s.rollDeg, 0, 0.01)
  assert.equal(s.hex, 'abc123')
  assert.equal(s.callsign, 'ELY001')
  assert.equal(s.typeCode, 'B738')
  assert.equal(s.quality, 'adsb2')
  assert.equal(s.onGround, false)
  near(s.ageS, -17.5, 1e-9)
})

test('3°/s turn sampled every 3 s stays on the arc (< 5 m) and banks right', (t) => {
  const path = turning(120, 10, 3) // radius 2292 m, one full circle in 120 s
  const tr = new Track('abc123')
  // adsb.lol precision: lat/lon 6 decimals, gs 0.1 kt, track 0.01°
  const q = (x: number, step: number): number => Math.round(x / step) * step
  for (const ts of times(0, 120, 3)) {
    const s = truthSample(path, ts)
    tr.add({ ...s, lat: q(s.lat, 1e-6), lon: q(s.lon, 1e-6), gsKt: q(s.gsKt!, 0.1), trackDeg: q(s.trackDeg!, 0.01) })
  }
  let worst = 0
  let chord = 0
  for (let ts = 0; ts <= 120; ts += 1 / 60) {
    worst = Math.max(worst, errM(tr.stateAt(T0 + ts * 1000)!, path, ts))
    const a = path(Math.floor(ts / 3) * 3)
    const b = path(Math.min(120, Math.floor(ts / 3) * 3 + 3))
    const u = (ts % 3) / 3
    const x = path(ts)
    chord = Math.max(chord, Math.hypot(a.e + u * (b.e - a.e) - x.e, a.n + u * (b.n - a.n) - x.n))
  }
  t.diagnostic(`max error ${worst.toFixed(3)} m (straight chords: ${chord.toFixed(1)} m)`)
  assert.ok(worst < 5, `max error ${worst} m`)
  // coordinated bank: atan(v·ω/g) = 32.6° right-wing-down
  const s = tr.stateAt(T0 + 60_000)!
  near(s.rollDeg, (Math.atan((120 * rad(3)) / 9.80665) * 180) / Math.PI, 1.5)
})

test('duplicate and re-served samples are ignored', () => {
  const path = straight(200, 90)
  const tr = new Track('abc123')
  const a = truthSample(path, 0)
  assert.equal(tr.add(a), true)
  assert.equal(tr.add(a), false)
  assert.equal(tr.add({ ...a, tMs: a.tMs + 3 }), false)
  assert.equal(tr.add(truthSample(path, -1)), false) // older than the newest
  assert.equal(tr.add({ ...truthSample(path, 1), hex: 'fff000' }), false) // another aircraft
  assert.equal(tr.add(truthSample(path, 1)), true)
  assert.equal(tr.newestTMs, T0 + 1000)
  assert.equal(tr.gapP90S(), 1)
})

test('dead reckoning follows the current turn, stops after 8 s and freezes as stale', () => {
  const path = turning(150, 0, 2)
  const tr = new Track('abc123')
  for (const t of times(0, 30, 1)) tr.add(truthSample(path, t))
  const at = (t: number): RenderState => tr.stateAt(T0 + t * 1000)!
  assert.equal(at(30).mode, 'interp')
  const e5 = at(35)
  assert.equal(e5.mode, 'extrap')
  assert.ok(errM(e5, path, 35) < 2, `5 s dead-reckoning error ${errM(e5, path, 35)} m`)
  assert.equal(at(38).mode, 'extrap')
  const frozen = at(38)
  const s1 = at(38.5)
  const s2 = at(60)
  for (const s of [s1, s2]) {
    assert.equal(s.mode, 'stale')
    near(s.lat, frozen.lat, 1e-9)
    near(s.lon, frozen.lon, 1e-9)
    near(s.hM, frozen.hM, 1e-9)
  }
  near(s2.ageS, 30, 1e-9)
})

test('a sample arriving after extrapolation re-joins without a frame jump (> 2 m at 60 Hz)', (t) => {
  const path = turning(200, 45, 3, 20) // starts a 3°/s turn at 20 s, exactly when the data stops
  const samples = [...times(0, 20, 1), ...times(26, 60, 1)].map((ts) => truthSample(path, ts))
  const fr = replay(new Track('abc123'), samples, { fromS: 3, toS: 60, delayS: 3 })
  const i = fr.findIndex((f) => f.t >= 24) // sample 26 s arrives at 27 s → render time 24 s
  assert.equal(fr[i - 1].s.mode, 'extrap')
  assert.equal(fr[i].s.mode, 'interp')
  // Without a blend the frame would land on the new estimate: a fresh Track holding the same samples.
  const fresh = new Track('abc123')
  for (const s of samples.filter((s) => s.tMs <= T0 + 26_000)) fresh.add(s)
  const [e0, n0] = frame.fwd(fr[i - 1].s.lat, fr[i - 1].s.lon, 0)
  const u = fresh.stateAt(T0 + fr[i].t * 1000)!
  const [e1, n1] = frame.fwd(u.lat, u.lon, 0)
  const unblended = Math.hypot(e1 - e0, n1 - n0) - 200 / 60
  const jump = maxJumpM(enuOf(fr))
  t.diagnostic(`unblended step ${unblended.toFixed(1)} m; blended max frame jump ${jump.toFixed(3)} m`)
  assert.ok(unblended > 20, `the scenario must need a real correction (${unblended} m)`)
  assert.ok(jump <= 2, `max frame jump ${jump} m`)
  const after = fr.filter((f) => f.t >= 26)
  const worst = Math.max(...after.map((f) => errM(f.s, path, f.t)))
  assert.ok(worst < 1, `back on the true path once the blend ends (${worst} m)`)
  assert.ok(after.every((f) => f.s.mode === 'interp'))
})

test('a reported velocity that contradicts the positions is replaced by the finite difference', () => {
  const path = straight(200, 90)
  const good = new Track('abc123')
  const badTrack = new Track('abc123')
  const badSpeed = new Track('abc123')
  for (const t of times(0, 20, 1)) {
    good.add(truthSample(path, t))
    badTrack.add(truthSample(path, t, { trackDeg: 120 })) // 30° off
    badSpeed.add(truthSample(path, t, { gsKt: 300 })) // 23 % slow
  }
  for (let t = 1; t < 19; t += 0.1) {
    for (const tr of [good, badTrack, badSpeed]) assert.ok(errM(tr.stateAt(T0 + t * 1000)!, path, t) < 0.5)
  }
  near(badTrack.stateAt(T0 + 10_500)!.trackDeg!, 90, 0.5)
  near(badSpeed.stateAt(T0 + 10_500)!.gsKt!, 200 / KT, 1)
})

test('the ENU origin re-centres after 100 km without disturbing the path', () => {
  const path = straight(250, 70)
  const samples = times(0, 600, 1).map((t) => truthSample(path, t)) // 150 km
  const fr = replay(new Track('abc123'), samples, { fromS: 5, toS: 600, delayS: 3 })
  const worst = Math.max(...fr.map((f) => errM(f.s, path, f.t)))
  assert.ok(worst < 1, `max error ${worst} m`)
  assert.ok(maxJumpM(enuOf(fr)) < 0.05, `max frame jump ${maxJumpM(enuOf(fr))} m`)
})

test('MLAT: gated, smoothed track renders with far lower lateral acceleration than raw positions', (t) => {
  const path = turning(200, 30, 1, 60)
  const r = rng(7)
  const samples: Sample[] = []
  const raw: PosT[] = []
  for (let ts = 0; ts <= 300; ts += 1 + 2 * r.uni()) {
    const s = truthSample(path, ts, { quality: 'mlat', version: null, altGeomFt: null, gsKt: 200 / KT + 5 * r.gauss(), trackDeg: null })
    const p = path(ts)
    const noisy = raw.length === 70 ? { e: p.e + 3000, n: p.n } : { e: p.e + 30 * r.gauss(), n: p.n + 30 * r.gauss() } // one 3 km outlier
    const g = geo(noisy.e, noisy.n)
    samples.push({ ...s, lat: g.lat, lon: g.lon })
    raw.push({ t: ts, ...noisy })
  }
  const tr = new Track('abc123')
  const fr = replay(tr, samples, { fromS: 30, toS: 280, delayS: 6 })
  assert.equal(tr.quality, 'mlat')
  assert.ok(fr.every((f) => f.s.quality === 'mlat' && f.s.rollDeg === 0))
  const rendered = latAccP99(enuOf(fr))
  const kin = velocitiesFromPositions(raw)
  const rawFrames: PosT[] = fr.map((f) => {
    let i = 0
    while (kin[i + 1].t < f.t) i++
    const h = hermite(kin[i], kin[i + 1], f.t)
    return { t: f.t, e: h.e, n: h.n }
  })
  const rawAcc = latAccP99(rawFrames)
  const posErr = pct(fr.map((f) => errM(f.s, path, f.t)), 0.95)
  const rawErr = pct(rawFrames.map((f) => { const p = path(f.t); return Math.hypot(f.e - p.e, f.n - p.n) }), 0.95)
  t.diagnostic(`lateral accel p99: rendered ${rendered.toFixed(2)} m/s², raw ${rawAcc.toFixed(2)} m/s²; position error p95: rendered ${posErr.toFixed(1)} m, raw ${rawErr.toFixed(1)} m`)
  assert.ok(rendered < rawAcc / 4, `rendered ${rendered} vs raw ${rawAcc}`)
  assert.ok(posErr < rawErr, `position error p95 ${posErr} m vs raw ${rawErr} m`)
})

test('vertical: 25 ft-quantised 3° descent renders with no step > 1 m per 60 Hz frame', (t) => {
  const vs = -140 * KT * Math.tan(rad(3)) // −3.77 m/s
  const h = (ts: number): number => 1000 + vs * ts // HAE metres
  const path = straight(140 * KT, 120)
  const r = rng(42)
  const q = (x: number, step: number): number => Math.round(x / step) * step
  const samples: Sample[] = []
  for (let ts = 0; ts <= 200; ts += 0.5 + r.uni()) {
    samples.push(truthSample(path, ts, {
      altGeomFt: q(h(ts) / FT, 25), altBaroFt: q((h(ts) - 19.6) / FT, 25),
      geomRateFpm: q((vs / FT) * 60, 64), baroRateFpm: q((vs / FT) * 60, 64),
    }))
  }
  const fr = replay(new Track('abc123'), samples, { fromS: 3.5, toS: 195, delayS: 3, latencyS: 0.3 })
  let maxStep = 0
  for (let i = 1; i < fr.length; i++) maxStep = Math.max(maxStep, Math.abs(fr[i].s.hM - fr[i - 1].s.hM))
  const late = fr.filter((f) => f.t >= 20)
  const hErr = pct(late.map((f) => Math.abs(f.s.hM - h(f.t))), 0.95)
  const vsErr = pct(late.map((f) => Math.abs((f.s.vsFpm! * FT) / 60 - vs)), 0.95)
  t.diagnostic(`max step ${maxStep.toFixed(3)} m, height error p95 ${hErr.toFixed(2)} m, VS error p95 ${vsErr.toFixed(2)} m/s`)
  assert.ok(maxStep <= 1, `max per-frame step ${maxStep} m`)
  assert.ok(hErr <= 2.5, `height error p95 ${hErr} m`)
  assert.ok(vsErr <= 2, `VS error p95 ${vsErr} m/s`)
  assert.ok(late.every((f) => f.s.altSource === 'geom' && f.s.pitchDeg < 2 && f.s.pitchDeg > -2))
})

test('heading prefers true_heading (interpolated the short way), else the track', () => {
  const path = straight(200 * KT, 90)
  const crab = new Track('abc123')
  for (const t of times(0, 10, 1)) crab.add(truthSample(path, t, { trueHeadingDeg: 100 }))
  const s = crab.stateAt(T0 + 5_500)!
  near(s.headingDeg, 100, 1e-6)
  near(s.trackDeg!, 90, 0.01)
  const plain = new Track('abc123')
  for (const t of times(0, 10, 1)) plain.add(truthSample(path, t))
  near(plain.stateAt(T0 + 5_500)!.headingDeg, 90, 0.01)
  const north = new Track('abc123')
  north.add(truthSample(path, 0, { trueHeadingDeg: 358 }))
  north.add(truthSample(path, 1, { trueHeadingDeg: 2 }))
  near(wrap180(north.stateAt(T0 + 500)!.headingDeg), 0, 1e-6)
})

test('ground aircraft: onGround, roll and pitch 0, MSL height, true heading', () => {
  const path = straight(15 * KT, 280)
  const tr = new Track('abc123')
  for (const t of times(0, 20, 1)) {
    tr.add(truthSample(path, t, { onGround: true, altBaroFt: null, altGeomFt: null, trueHeadingDeg: 281, rollDeg: 4 }))
  }
  const s = tr.stateAt(T0 + 10_000)!
  assert.equal(s.onGround, true)
  assert.equal(s.rollDeg, 0)
  assert.equal(s.pitchDeg, 0)
  assert.equal(s.hM, 19.6) // MSL 0 as HAE; consumers clamp ground aircraft to terrain
  assert.equal(s.vsFpm, 0)
  near(s.headingDeg, 281, 1e-6)
  assert.equal(s.altBaroFt, null)
})

test('landing: ground height holds the last airborne height for 60 s, then MSL; altSource keeps the last rung', () => {
  const path = straight(70, 300)
  const tr = new Track('abc123')
  for (const t of times(0, 20, 1)) tr.add(truthSample(path, t, { altGeomFt: 500 - 10 * t, altBaroFt: 400 - 10 * t }))
  for (const t of times(21, 120, 1)) tr.add(truthSample(path, t, { onGround: true, altBaroFt: null, altGeomFt: null, gsKt: 30 }))
  const air = tr.stateAt(T0 + 20_000)!
  assert.equal(air.onGround, false)
  const ground = tr.stateAt(T0 + 30_000)!
  assert.equal(ground.onGround, true)
  near(ground.hM, air.hM, 1e-9)
  assert.equal(ground.altSource, 'geom')
  assert.equal(tr.stateAt(T0 + 85_000)!.hM, 19.6)
})

test('gapP90S covers the last 60 s of gaps; delayTargetS follows quality, poll period and gaps', () => {
  const path = straight(200, 0)
  const tr = new Track('abc123')
  for (const t of [...times(0, 100, 5), ...times(101, 110, 1)]) tr.add(truthSample(path, t))
  assert.equal(tr.gapP90S(), 5)
  assert.equal(tr.delayTargetS, 6)
  for (const t of times(111, 200, 1)) tr.add(truthSample(path, t))
  assert.equal(tr.gapP90S(), 1)
  assert.equal(tr.delayTargetS, 3)
  assert.equal(tr.quality, 'adsb2')
  const slowPoll = new Track('abc123', { pollPeriodS: 4 })
  slowPoll.add(truthSample(path, 0))
  assert.equal(slowPoll.delayTargetS, 5)
  const mlat = new Track('abc123')
  mlat.add(truthSample(path, 0, { quality: 'mlat' }))
  assert.equal(mlat.delayTargetS, 6)
})

test('empty track and render times before the first sample give null', () => {
  const tr = new Track('abc123')
  assert.equal(tr.stateAt(T0), null)
  assert.equal(tr.newestTMs, null)
  assert.equal(tr.quality, 'other')
  tr.add(truthSample(straight(200, 0), 10))
  assert.equal(tr.stateAt(T0 + 9_999), null)
  const s = tr.stateAt(T0 + 10_000)!
  assert.equal(s.mode, 'interp')
  assert.equal(tr.stateAt(T0 + 12_000)!.mode, 'extrap')
})
