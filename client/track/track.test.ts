// client/track/track.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Enu } from '../../shared/enu.ts'
import type { Sample } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
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

/**
 * As the feed reports it, the velocity trails its position: measured on adsb.fi in turns at Heathrow (2026-09-28), the
 * reported track lags the direction flown by 0.73 s (median). The fixtures do the same, so turns test the real thing.
 */
const REPORT_LAG_S = 0.75

/** Sample of the truth path at t s: exact position; gs and track (local true azimuth of the velocity) as reported, REPORT_LAG_S late. */
function truthSample(path: Path, t: number, o: Partial<Sample> = {}): Sample {
  const p = path(t)
  const g = geo(p.e, p.n)
  const v = path(Math.max(0, t - REPORT_LAG_S))
  const ahead = geo(p.e + v.ve * 0.01, p.n + v.vn * 0.01)
  const [de, dn] = new Enu(g.lat, g.lon, 0).fwd(ahead.lat, ahead.lon, 0)
  const trackDeg = ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360
  return sample({ tMs: T0 + t * 1000, lat: g.lat, lon: g.lon, gsKt: Math.hypot(v.ve, v.vn) / KT, trackDeg, ...o })
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
  // Following the turn: a straight line would be off by V·ω·t²/2 = 65 m after 5 s.
  assert.ok(errM(e5, path, 35) < 20, `5 s dead-reckoning error ${errM(e5, path, 35)} m`)
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
  const path = turning(200, 45, 1.5, 20) // a 1.5°/s turn (28° of bank at 390 kt) starts at 20 s, when the data stops
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
  assert.ok(after.every((f) => f.s.mode === 'interp'))
  // A turn begun unseen in the gap: the smoothed path converges on it as the samples after the gap come in (a few
  // metres on a 38 m aircraft are invisible; what shows is a jump, and there is none).
  const worst = (from: number): number => Math.max(...fr.filter((f) => f.t >= from).map((f) => errM(f.s, path, f.t)))
  assert.ok(worst(30) < 8, `4 s after the gap (${worst(30)} m)`)
  assert.ok(worst(40) < 4, `14 s after the gap (${worst(40)} m)`)
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
  // The path follows the reported velocities closely, and 100 km out the tangent plane tilts 0.9° from the local one.
  assert.ok(worst < 3, `max error ${worst} m`)
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
  assert.ok(fr.every((f) => f.s.quality === 'mlat'))
  // Bank from the smoothed path: wings about level on the straight, the coordinated bank in the 1°/s turn (19.6°).
  const bank = (a: number, b: number): number[] => fr.filter((f) => f.t >= a && f.t <= b).map((f) => f.s.rollDeg)
  t.diagnostic(`bank straight ${Math.min(...bank(30, 55)).toFixed(1)}…${Math.max(...bank(30, 55)).toFixed(1)}°, turning ${Math.min(...bank(100, 280)).toFixed(1)}…${Math.max(...bank(100, 280)).toFixed(1)}°`)
  assert.ok(bank(30, 55).every((r) => Math.abs(r) < 5), 'straight: wings about level')
  assert.ok(bank(100, 280).every((r) => Math.abs(r - 19.6) < 6), 'turning: the coordinated bank')
  const rendered = latAccP99(enuOf(fr))
  const rawPts = raw.filter((p) => p.t >= 30 && p.t <= 280)
  const rawAcc = latAccP99(rawPts) // what the raw positions imply, point to point
  const posErr = pct(fr.map((f) => errM(f.s, path, f.t)), 0.95)
  const rawErr = pct(rawPts.map((f) => { const p = path(f.t); return Math.hypot(f.e - p.e, f.n - p.n) }), 0.95)
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
  assert.ok(late.every((f) => f.s.altSource === 'geom'))
  // A 3° glide at the approach speed flies nose up, as a real airliner does (+2.5…+3.5°): never nose down, never nodding.
  const pitch = late.map((f) => f.s.pitchDeg)
  t.diagnostic(`pitch ${Math.min(...pitch).toFixed(2)}…${Math.max(...pitch).toFixed(2)}°`)
  assert.ok(pitch.every((p) => p > 2 && p < 4), 'approach pitch')
  assert.ok(Math.max(...pitch) - Math.min(...pitch) < 0.5, 'no nodding')
})

/** A 25 ft-quantised 3° descent at 140 kt through a Track, rendered 3 s behind: height and V/S errors after 20 s. */
function descent(o: Partial<Sample> | ((ts: number) => Partial<Sample>)): { hErr: number; vsErr: number; vsMax: number; maxStep: number; pitch: number[] } {
  const vs = -140 * KT * Math.tan(rad(3))
  const h = (ts: number): number => 1000 + vs * ts
  const path = straight(140 * KT, 120)
  const r = rng(42)
  const qz = (x: number, step: number): number => Math.round(x / step) * step
  const samples: Sample[] = []
  for (let ts = 0; ts <= 200; ts += 0.5 + r.uni()) {
    samples.push(truthSample(path, ts, {
      altGeomFt: qz(h(ts) / FT, 25), altBaroFt: qz((h(ts) - 19.6) / FT, 25), geomRateFpm: null, baroRateFpm: null,
      ...(typeof o === 'function' ? o(ts) : o),
    }))
  }
  const fr = replay(new Track('abc123'), samples, { fromS: 3.5, toS: 195, delayS: 3, latencyS: 0.3 })
  let maxStep = 0
  for (let i = 1; i < fr.length; i++) maxStep = Math.max(maxStep, Math.abs(fr[i].s.hM - fr[i - 1].s.hM))
  const late = fr.filter((f) => f.t >= 20)
  const vsE = late.map((f) => Math.abs((f.s.vsFpm! * FT) / 60 - vs))
  return { hErr: pct(late.map((f) => Math.abs(f.s.hM - h(f.t))), 0.95), vsErr: pct(vsE, 0.95), vsMax: Math.max(...vsE), maxStep, pitch: late.map((f) => f.s.pitchDeg) }
}

test('vertical: without any reported rate the heights alone give a smooth, accurate descent', () => {
  const r = descent({})
  // From 25 ft steps alone: V/S within 0.8 m/s (160 fpm, half a degree of pitch at 140 kt).
  assert.ok(r.hErr <= 2.5 && r.vsErr <= 0.8 && r.vsMax <= 1.2 && r.maxStep <= 1, JSON.stringify({ ...r, pitch: undefined }))
})

test('vertical: a reported rate 10 % steeper than the heights (baro rate vs geometric height) does not drag the path away', () => {
  const vsFpm = ((-140 * KT * Math.tan(rad(3))) / FT) * 60 * 1.1
  const r = descent({ geomRateFpm: vsFpm, baroRateFpm: vsFpm })
  assert.ok(r.hErr <= 3 && r.vsErr <= 0.6, JSON.stringify({ ...r, pitch: undefined }))
})

test('vertical: a rate contradicting the heights (+2,600 fpm reported while descending) is ignored — no nodding', () => {
  const r = descent({ geomRateFpm: 2600, baroRateFpm: 2600 })
  assert.ok(r.hErr <= 2.5 && r.vsErr <= 0.8, JSON.stringify({ ...r, pitch: undefined }))
  // From 25 ft steps alone the path angle is known to about ±0.3°: a slow wander within 1.5°, not a nod.
  assert.ok(Math.max(...r.pitch) - Math.min(...r.pitch) < 1.5, `pitch ${Math.min(...r.pitch)}…${Math.max(...r.pitch)}`)
})

test('vertical: a switch from geometric to QNH-corrected baro height mid-descent shows no V/S spike and no step', () => {
  const vs = -140 * KT * Math.tan(rad(3))
  const qnh = 1020
  const corrM = (qnh - 1013.25) * 27 * FT
  const r = descent((ts) => {
    const hm = 1000 + vs * ts
    return {
      altBaroFt: Math.round((hm - 19.6 - corrM) / FT / 25) * 25, navQnhHpa: qnh,
      altGeomFt: ts < 100 ? Math.round((hm + 40) / FT / 25) * 25 : null, // geom 40 m above the same air's QNH height
      geomRateFpm: Math.round(((vs / FT) * 60) / 64) * 64, version: 0,
    }
  })
  // (without the ladder's continuity offset the 40 m rung jump would read as a V/S spike of ~12 m/s)
  assert.ok(r.maxStep <= 1 && r.vsMax <= 1.5, JSON.stringify({ ...r, pitch: undefined }))
})

test('heading = track + the wind correction the reported heading shows (averaged); implausible or missing: the track', () => {
  const path = straight(200 * KT, 90)
  const crab = new Track('abc123')
  for (const t of times(0, 10, 1)) crab.add(truthSample(path, t, { trueHeadingDeg: 100 }))
  const s = crab.stateAt(T0 + 5_500)!
  near(s.headingDeg, 100, 0.01) // the nose 10° into the wind
  near(s.trackDeg!, 90, 0.01)
  const plain = new Track('abc123')
  for (const t of times(0, 10, 1)) plain.add(truthSample(path, t))
  near(plain.stateAt(T0 + 5_500)!.headingDeg, 90, 0.01)
  const wild = new Track('abc123') // a heading 90° off the track is not a wind correction
  for (const t of times(0, 10, 1)) wild.add(truthSample(path, t, { trueHeadingDeg: 180 }))
  near(wild.stateAt(T0 + 5_500)!.headingDeg, 90, 0.01)
  const north = new Track('abc123') // across north: 358 then 2 on a northbound track averages near 0, not 180
  const up = straight(200 * KT, 0)
  north.add(truthSample(up, 0, { trueHeadingDeg: 358 }))
  north.add(truthSample(up, 1, { trueHeadingDeg: 2 }))
  north.add(truthSample(up, 2, { trueHeadingDeg: 2 }))
  assert.ok(Math.abs(wrap180(north.stateAt(T0 + 1_500)!.headingDeg)) < 2)
})

test('ground aircraft: onGround, roll and pitch 0, MSL height; the nose along the track while moving, else as reported', () => {
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
  near(s.headingDeg, 280, 0.01) // nose-wheel steering: no crab on the ground
  assert.equal(s.altBaroFt, null)
  const parked = new Track('abc123')
  for (const t of times(0, 20, 1)) {
    parked.add(sample({ tMs: T0 + t * 1000, lat: 32, lon: 34.9, onGround: true, altBaroFt: null, altGeomFt: null, gsKt: 0, trackDeg: null, trueHeadingDeg: 123 }))
  }
  near(parked.stateAt(T0 + 10_000)!.headingDeg, 123, 0.01)
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

// ---------- a new track's first seconds: never a made-up speed ----------

test('new ADS-B track: a late-stamped second position does not throw away the reported speed (it read 125 kt, not 461)', () => {
  // Measured (adsb.fi, B77W 4bb144 at FL320): the first two positions 1.27 s apart but 520 m apart — 800 kt — while both
  // report 461.5 kt; one of the two time stamps is ~0.9 s off. The reported velocity is the trustworthy one.
  const path = straight(461.5 * KT, 277)
  const tr = new Track('abc123', { pollPeriodS: 1 })
  tr.add(truthSample(path, 0))
  const late = truthSample(path, 2.19) // flown 2.19 s…
  tr.add({ ...late, tMs: T0 + 1270, rxMs: T0 + 1400 }) // …stamped 1.27 s
  for (const dt of [0, 0.5, 1]) {
    const s = tr.stateAt(T0 + 1270 + dt * 1000)!
    near(s.gsKt!, 461.5, 25, `gs at +${dt} s`)
    assert.ok(Math.abs(wrap180(s.trackDeg! - 277)) < 5, `track ${s.trackDeg} at +${dt} s`)
  }
})

test('new MLAT track: the first frames show the reported speed, not 0 kt', () => {
  const path = straight(107 * KT, 177)
  const tr = new Track('abc123', { pollPeriodS: 1 })
  tr.add(truthSample(path, 0, { quality: 'mlat', version: null }))
  for (const dt of [0, 0.3, 0.8]) near(tr.stateAt(T0 + dt * 1000)!.gsKt!, 107, 11, `one sample, +${dt} s`)
  tr.add(truthSample(path, 2.5, { quality: 'mlat', version: null }))
  near(tr.stateAt(T0 + 2600)!.gsKt!, 107, 15, 'two samples')
})

test('MLAT light aircraft: 60 m position noise does not overrule its reported speed (a C152 at 93 kt was drawn at 22 kt)', (t) => {
  const v = 93 * KT
  const path = straight(v, 250)
  const r = rng(11)
  const samples: Sample[] = []
  for (let ts = 0; ts <= 240; ts += 1 + 2.5 * r.uni() + (r.uni() < 0.05 ? 4 : 0)) {
    const s = truthSample(path, ts, { quality: 'mlat', version: null, altGeomFt: null, gsKt: 93 + 3 * r.gauss(), trackDeg: 250 + 3 * r.gauss() })
    const p = path(ts)
    const g = geo(p.e + 60 * r.gauss(), p.n + 60 * r.gauss())
    samples.push({ ...s, lat: g.lat, lon: g.lon })
  }
  const fr = replay(new Track('abc123'), samples, { fromS: 20, toS: 230, delayS: 6 })
  const gs = fr.map((f) => f.s.gsKt!).sort((a, b) => a - b)
  t.diagnostic(`drawn gs p1 ${gs[Math.floor(gs.length * 0.01)].toFixed(1)}, min ${gs[0].toFixed(1)}, p99 ${gs[Math.floor(gs.length * 0.99)].toFixed(1)} kt`)
  assert.ok(gs[0] > 0.75 * 93, `min ${gs[0]}`)
  assert.ok(gs[gs.length - 1] < 1.25 * 93, `max ${gs[gs.length - 1]}`)
})
