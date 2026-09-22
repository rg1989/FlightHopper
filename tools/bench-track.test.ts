// tools/bench-track.test.ts
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordingToSamples, type RecordLine } from '../server/recording.ts'
import { Enu } from '../shared/enu.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { benchTrack, evaluateG2, forEachSample, readLines, run, type G2Metrics } from './bench-track.ts'

// Synthetic recording, adsb.lol envelope, 1 Hz server polls for 211 s. Aircraft abc123 (ADS-B v2, 100 m/s):
// north for 60 s, a 2 °/s right turn for 90 s (180°), then south. No new position in (30 s, 42 s): the gap
// opens with 5 re-served copies of the 30 s position, then the aircraft is missing. Every 4th second a second
// poll re-serves the current position (a duplicate). def456 is seen for 20 s; 000002 is LADD (dbFlags 8) and is in
// every poll, so it has the most samples but must stay hidden. One 429 line has no body.
const T0 = 1_790_000_000_000
const HEX = 'abc123'
const V = 100 // m/s
const W = 2 // °/s
const R = V / ((W * Math.PI) / 180) // turn radius, 2864.8 m
const GAP_FROM = 30
const GAP_TO = 42
const ORIGIN = new Enu(32, 34.9, 0)

function truthAt(t: number): { e: number; n: number; trackDeg: number } {
  if (t < 60) return { e: 0, n: V * t, trackDeg: 0 }
  if (t < 150) {
    const th = (W * (t - 60) * Math.PI) / 180
    return { e: R - R * Math.cos(th), n: V * 60 + R * Math.sin(th), trackDeg: W * (t - 60) }
  }
  return { e: 2 * R, n: V * 60 - V * (t - 150), trackDeg: 180 }
}

/** abc123 at position time t (s after T0), reported seenPos seconds before the response's `now`. */
function abc(t: number, seenPos: number): ReadsbAircraft {
  const p = truthAt(t)
  const g = ORIGIN.inv(p.e, p.n, 0)
  const altFt = Math.round((10_000 - (1000 * t) / 60) / 25) * 25 // −1000 fpm, 25 ft quantised
  return {
    hex: HEX, type: 'adsb_icao', flight: 'TST1    ', lat: g.lat, lon: g.lon, alt_baro: altFt, alt_geom: altFt + 300,
    gs: V / 0.514444, track: p.trackDeg, baro_rate: -1000, geom_rate: -1000, nav_qnh: 1013.2, version: 2, nic: 8, seen_pos: seenPos,
  }
}

function line(tRecvMs: number, nowMs: number, ac: ReadsbAircraft[], status = 200): RecordLine {
  const body = status === 200 ? JSON.stringify({ ac, msg: 'No error', now: nowMs, total: ac.length, ctime: nowMs, ptime: 1 }) : ''
  return { v: 1, source: 'adsblol', url: 'synthetic', status, tSendMs: tRecvMs - 100, tRecvMs, bytes: body.length, body }
}

function recording(): RecordLine[] {
  const out: RecordLine[] = []
  for (let i = 0; i <= 210; i++) {
    const now = T0 + i * 1000 + 250 // upstream clock; the position at T0 + i s is 0.25 s old
    const rx = now + 150 + (i % 3) * 40 // latency 150–230 ms, so the stamping offset is 150 ms
    const ac: ReadsbAircraft[] = [{ hex: '000002', type: 'adsb_icao', dbFlags: 8, version: 2, lat: 32.5, lon: 34.5, alt_baro: 30_000, seen_pos: 0.1 }]
    if (i < 20) ac.push({ hex: 'def456', type: 'adsb_icao', version: 2, lat: 32.2, lon: 34.6 + i * 0.001, alt_baro: 5000, gs: 180, track: 90, seen_pos: 0.3 })
    const inGap = i > GAP_FROM && i < GAP_TO
    if (!inGap) ac.push(abc(i, 0.25))
    else if (i <= GAP_FROM + 5) ac.push(abc(GAP_FROM, 0.25 + i - GAP_FROM))
    out.push(line(rx, now, ac))
    if (i % 4 === 2 && !inGap) out.push(line(rx + 500, now + 500, [abc(i, 0.75)]))
  }
  out.splice(100, 0, line(T0 + 99_900, 0, [], 429))
  return out
}

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Writes the recording as two JSONL files, the later half first, so the bench must merge them by tRecvMs. */
function files(): string[] {
  const dir = tmp('bench-track-')
  const lines = recording()
  const late = join(dir, 'late.jsonl')
  const early = join(dir, 'early.jsonl')
  writeFileSync(late, lines.slice(120).map((l) => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(early, lines.slice(0, 120).map((l) => JSON.stringify(l)).join('\n') + '\n')
  return [late, early]
}

const FILES = files()
const main = benchTrack(FILES, { noDedupe: true })

test('lines replay in arrival order; server stamping and dedupe equal recordingToSamples', () => {
  const lines = readLines(FILES)
  assert.deepEqual(lines.map((l) => l.tRecvMs), recording().map((l) => l.tRecvMs).toSorted((a, b) => a - b))
  const unique: Sample[] = []
  let dups = 0
  forEachSample(lines, (s, dup) => (dup ? dups++ : unique.push(s)))
  assert.deepEqual(unique, recordingToSamples(lines))
  assert.ok(dups > 0)
})

test('auto hex: the visible hex with the most samples (LADD 000002 stays hidden)', () => {
  assert.equal(main.metrics.hex, HEX)
  assert.equal(main.metrics.quality, 'adsb2')
  assert.equal(main.metrics.samples, 211 - (GAP_TO - GAP_FROM - 1))
  assert.equal(main.session.fromMs, T0 + 150) // stamped: upstream now − seen_pos + 150 ms offset
})

test('starvation is 0 at the chosen D; the 12 s gap extrapolates, then goes stale, then re-joins within 1.5 s', () => {
  const m = main.metrics
  assert.deepEqual(m.delayS, { start: 3, p50: 3, max: 3 })
  assert.equal(m.starvationFrames, 0)
  const off = main.frames.filter((f) => f.mode !== 'interp')
  assert.equal(m.gapFrames, off.length)
  const extrap = off.filter((f) => f.mode === 'extrap')
  const stale = off.filter((f) => f.mode === 'stale')
  assert.ok(extrap.length > 0 && stale.length > 0)
  for (const f of off) assert.ok(f.t > GAP_FROM && f.t < GAP_TO, `non-interp frame at ${f.t} s is outside the gap`)
  assert.ok(extrap.at(-1)!.t < stale[0].t, 'extrapolation comes before stale')
  assert.ok(Math.abs(extrap.length / 60 - 8) < 0.05, `8 s of extrapolation, got ${extrap.length / 60} s`)
  assert.equal(m.rejoin.count, 1)
  assert.ok(m.rejoin.errP95M > 100, `frozen pose vs hindsight: ${m.rejoin.errP95M} m`)
  assert.ok(m.rejoin.blendMaxS > 1 && m.rejoin.blendMaxS <= 1.5, `blend ${m.rejoin.blendMaxS} s`)
})

test('every G2 metric is finite; frames are 60 Hz in one ENU frame at the first sample', () => {
  const m = main.metrics
  for (const [name, v] of Object.entries({
    discMax: m.frameDiscontinuity.maxM, discP99: m.frameDiscontinuity.p99M, latP99: m.lateralAccel.p99, latMax: m.lateralAccel.max,
    jerkP99: m.jerk.p99, vsErrP95: m.vertical.vsErrP95, maxStepM: m.vertical.maxStepM, delaySlew: m.delaySlew,
  })) assert.ok(Number.isFinite(v), `${name} = ${v}`)
  assert.ok(m.delaySlew <= 0.2 + 1e-9)
  assert.ok(m.frameDiscontinuity.maxM < 2, `interp discontinuity ${m.frameDiscontinuity.maxM} m`)
  const f = main.frames
  assert.equal(m.frames, f.length)
  assert.ok(Math.abs(f[1].t - f[0].t - 1 / 60) < 1e-6)
  assert.ok(Math.hypot(f[0].e, f[0].n) < V * 1.5, 'starts near the origin')
  const turn = f.filter((x) => x.t > 80 && x.t < 130)
  const lat = Math.max(...turn.map((x) => Math.abs(x.rollDeg)))
  assert.ok(lat > 15 && lat < 25, `coordinated-turn roll ≈ atan(v·ω/g) = 20°, got ${lat}`)
  assert.ok(main.rates.length > 0 && Math.abs(main.rates[0].vsMs + 5.08) < 1e-9)
})

test('dedupe: re-served positions counted and removed; the no-dedupe replay is scored too', () => {
  const d = main.metrics.dedupe
  assert.equal(d.unique, main.metrics.samples)
  assert.ok(d.served > d.unique)
  assert.ok(d.duplicateFraction > 0.15 && d.duplicateFraction < 0.3, `duplicate fraction ${d.duplicateFraction}`)
  assert.ok(Number.isFinite(d.jerkP99NoDedupe))
  assert.equal(benchTrack(FILES, { decimate: [] }).metrics.dedupe.jerkP99NoDedupe, null)
})

test('decimate 3 and 5 score held-out truth, split turn vs straight, against linear interpolation', () => {
  const [c3, c5] = main.metrics.crossTrack
  assert.deepEqual([c3.k, c5.k], [3, 5])
  for (const c of [c3, c5]) {
    assert.ok(c.nTurn > 20 && c.nStraight > 20, `k=${c.k}: ${c.nTurn} turn, ${c.nStraight} straight`)
    assert.ok(c.turnP95M <= 0.5 * c.linearTurnP95M, `k=${c.k}: ${c.turnP95M} m vs linear ${c.linearTurnP95M} m`)
  }
  assert.ok(c3.turnP95M < 5 && c3.linearTurnP95M > 2, `chord sag at 3 s ≈ 3.5 m: ${c3.linearTurnP95M}`)
  assert.ok(c5.turnP95M < 15 && c5.linearTurnP95M > c3.linearTurnP95M)
})

test('--hex and --from/--to select one aircraft and window', () => {
  const r = benchTrack(FILES, { hex: 'DEF456', decimate: [] })
  assert.equal(r.metrics.hex, 'def456')
  assert.equal(r.metrics.samples, 20)
  const w = benchTrack(FILES, { hex: HEX, fromMs: T0 + 60_000, toMs: T0 + 150_999, decimate: [3] })
  assert.equal(w.session.fromMs, T0 + 60_150)
  assert.equal(w.session.toMs, T0 + 150_150)
  assert.equal(w.metrics.samples, 91)
  assert.equal(w.metrics.gapFrames, 0)
  assert.throws(() => benchTrack(FILES, { hex: 'zzz999' }), /no samples/)
})

test('run() writes .planning-style G2-<hex>-<date>.json and returns the verdict', () => {
  const out = tmp('bench-report-')
  const { report, path } = run(['--recordings', ...FILES, '--hex', HEX, '--decimate', '3', '--out', out])
  assert.equal(path, join(out, `G2-${HEX}-${new Date().toISOString().slice(0, 10)}.json`))
  assert.ok(existsSync(path))
  const j = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(j.gate, 'G2')
  assert.equal(j.hex, HEX)
  assert.equal(j.pass, report.pass)
  assert.ok(j.checks.some((c: { name: string }) => c.name === 'crossTrackTurnP95M@5'))
  assert.throws(() => run(['--out', out]), /no recordings/)
})

// ---- evaluateG2 on hand-made metrics ----

function good(): G2Metrics {
  return {
    hex: 'abc123', quality: 'adsb2', samples: 200, frames: 12_000,
    delayS: { start: 3, p50: 3, max: 3 },
    starvationFrames: 0, gapFrames: 0,
    frameDiscontinuity: { maxM: 0.5, p99M: 0.01 },
    lateralAccel: { p99: 3.5, max: 4 },
    jerk: { p99: 1 },
    vertical: { vsErrP95: 1, maxStepM: 0.2 },
    delaySlew: 0.2,
    rejoin: { count: 1, errP95M: 200, blendMaxS: 1.45 },
    crossTrack: [
      { k: 3, nTurn: 60, nStraight: 80, turnP95M: 1, straightP95M: 0.5, linearTurnP95M: 3.5 },
      { k: 5, nTurn: 70, nStraight: 90, turnP95M: 4, straightP95M: 1, linearTurnP95M: 10 },
    ],
    dedupe: { served: 250, unique: 200, duplicateFraction: 0.2, jerkP99NoDedupe: null },
  }
}

const failing = (m: G2Metrics): string[] => evaluateG2(m).checks.filter((c) => !c.pass).map((c) => c.name)

test('evaluateG2: a metric set inside every ADS-B v2 bar passes', () => {
  const r = evaluateG2(good())
  assert.equal(r.pass, true)
  assert.deepEqual(r.checks.map((c) => [c.name, c.threshold]), [
    ['frameDiscontinuityMaxM', 2], ['starvationFrames', 0],
    ['crossTrackTurnP95M@3', 5], ['crossTrackTurnVsLinear@3', 0.5], ['crossTrackTurnP95M@5', 15], ['crossTrackTurnVsLinear@5', 0.5],
    ['lateralAccelP99', 5.7], ['vsErrP95', 2], ['verticalMaxStepM', 1], ['delaySlew', 0.2], ['rejoinBlendMaxS', 1.5],
  ])
})

test('evaluateG2: each bar fails on its own', () => {
  const cases: [string, (m: G2Metrics) => void][] = [
    ['frameDiscontinuityMaxM', (m) => (m.frameDiscontinuity.maxM = 2.5)],
    ['starvationFrames', (m) => (m.starvationFrames = 1)],
    ['crossTrackTurnP95M@3', (m) => Object.assign(m.crossTrack[0], { turnP95M: 6, linearTurnP95M: 20 })],
    ['crossTrackTurnVsLinear@3', (m) => Object.assign(m.crossTrack[0], { turnP95M: 2, linearTurnP95M: 3 })],
    ['crossTrackTurnP95M@5', (m) => Object.assign(m.crossTrack[1], { turnP95M: 16, linearTurnP95M: 40 })],
    ['crossTrackTurnVsLinear@5', (m) => Object.assign(m.crossTrack[1], { turnP95M: 6, linearTurnP95M: 10 })],
    ['lateralAccelP99', (m) => (m.lateralAccel.p99 = 5.8)],
    ['vsErrP95', (m) => (m.vertical.vsErrP95 = 2.1)],
    ['verticalMaxStepM', (m) => (m.vertical.maxStepM = 1.2)],
    ['delaySlew', (m) => (m.delaySlew = 0.25)],
    ['rejoinBlendMaxS', (m) => (m.rejoin.blendMaxS = 1.6)],
  ]
  for (const [name, spoil] of cases) {
    const m = good()
    spoil(m)
    assert.deepEqual(failing(m), [name])
    assert.equal(evaluateG2(m).pass, false)
  }
})

test('evaluateG2: no data fails, float noise at a bar does not, no re-join passes', () => {
  const nan = good()
  nan.frameDiscontinuity.maxM = NaN
  assert.deepEqual(failing(nan), ['frameDiscontinuityMaxM'])
  const no5 = good()
  no5.crossTrack = no5.crossTrack.slice(0, 1)
  assert.deepEqual(failing(no5), ['crossTrackTurnP95M@5', 'crossTrackTurnVsLinear@5'])
  const edge = good()
  edge.delaySlew = 0.2 + 1e-12
  edge.lateralAccel.p99 = 5.7
  assert.deepEqual(failing(edge), [])
  const calm = good()
  calm.rejoin = { count: 0, errP95M: NaN, blendMaxS: 0 }
  assert.equal(evaluateG2(calm).pass, true)
  const inf = good()
  inf.rejoin.blendMaxS = Infinity
  assert.deepEqual(failing(inf), ['rejoinBlendMaxS'])
})

test('evaluateG2: an MLAT hex is held to the separate bar, lateral acceleration p99 ≤ 0.5 g', () => {
  const m = good()
  m.quality = 'mlat'
  m.lateralAccel.p99 = 4.8
  m.crossTrack = [] // not gated for MLAT
  const r = evaluateG2(m)
  assert.equal(r.pass, true)
  assert.deepEqual(r.checks.map((c) => c.name), ['lateralAccelP99'])
  assert.ok(Math.abs(r.checks[0].threshold - 4.903325) < 1e-9)
  m.lateralAccel.p99 = 5 // inside the ADS-B bar, outside the MLAT one
  assert.equal(evaluateG2(m).pass, false)
})
