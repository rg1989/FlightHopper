// tools/bench-track.ts
// Gate G2 motion bench (PLAN.md §6): replays recordings causally through the real client estimator and scores the
// rendered 60 Hz path of one aircraft with tools/metrics.ts. Writes <out>/G2-<hex>-<YYYY-MM-DD>.json.
//
//   node tools/bench-track.ts --recordings 'data/recordings/*.jsonl' [--hex 4x1234] [--decimate 3,5] [--no-dedupe]
//                             [--from 2026-09-22T10:00Z] [--to 2026-09-22T12:00Z] [--out .planning/reports]
//
// Causal replay: recorded polls in arrival (tRecvMs) order → server stamping and dedupe exactly as recordingToSamples
// (a sample becomes visible at its line's tRecvMs) → a simulated client polls the chased hex every 1 s and gets every
// sample with rxMs ≤ poll − 100 ms → TrackRegistry → RenderClock at 60 Hz with serverNow = the simulation clock.
// --decimate k[,k…] replays every k-th sample and scores the rest as held-out truth (G2 needs 3 and 5). --no-dedupe also
// replays the positions the server dedupe dropped and reports that run's jerk next to the deduped one.
// --from/--to take ISO times or epoch ms. Exit code 0 = pass, 1 = fail.
import { globSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { turnRateDegS } from '../client/track/attitude.ts'
import { RenderClock } from '../client/track/delay.ts'
import { TrackRegistry } from '../client/track/registry.ts'
import { Track } from '../client/track/track.ts'
import { readRecording, type RecordLine } from '../server/recording.ts'
import { MinOffset } from '../shared/clock.ts'
import { Deduper } from '../shared/dedupe.ts'
import { Enu } from '../shared/enu.ts'
import { normalizers } from '../shared/readsb.ts'
import { isHidden, toSample } from '../shared/sample.ts'
import type { Quality, Sample } from '../shared/types.ts'
import { crossTrackErrors, delaySlew, frameDiscontinuity, jerk, lateralAccel, percentile, verticalMetrics } from './metrics.ts'
import type { Frame, RateAt } from './types.ts'

const POLL_MS = 1000 // simulated client chase poll
const HOP_MS = 100 // server → client: a poll at t sees samples with rxMs ≤ t − 100 ms
const FPS = 60
const SESSION_GAP_MS = 60_000 // a longer silence means the aircraft left coverage; the longest session is benched
// A longer gap is a coverage hole, not starvation. G2's line: the delay cap (10 s) when G2 was set. MAX_DELAY_S is 30 s
// since sparse live feeds (25 s between samples), but a 1 Hz track's p90 gap never asks for more than 10 s.
const COVERAGE_GAP_MS = 10_000
const TURN_DEGS = 1 // |track rate| above this is a turn (G2 cross-track bar)
const FPM = 0.00508 // m/s per ft/min
const G = 9.80665
const TURN_BAR_M: Record<number, number> = { 3: 5, 5: 15 } // G2: decimated to 3 s / 5 s (1 Hz recordings, so k = seconds)

export interface CrossTrack {
  k: number
  nTurn: number
  nStraight: number
  turnP95M: number
  straightP95M: number
  linearTurnP95M: number // the same held-out turn points scored against straight lines between kept samples
}

export interface G2Metrics {
  hex: string
  quality: Quality // the session's most common quality
  samples: number // deduped samples in the session
  frames: number
  delayS: { start: number; p50: number; max: number }
  starvationFrames: number // not 'interp' although the bracketing samples are ≤ 10 s apart
  gapFrames: number // not 'interp' inside a coverage gap (> 10 s between samples): reported, not gated
  frameDiscontinuity: { maxM: number; p99M: number }
  lateralAccel: { p99: number; max: number }
  jerk: { p99: number }
  vertical: { vsErrP95: number; maxStepM: number }
  delaySlew: number
  rejoin: { count: number; errP95M: number; blendMaxS: number }
  crossTrack: CrossTrack[]
  dedupe: { served: number; unique: number; duplicateFraction: number; jerkP99NoDedupe: number | null }
}

export interface BenchOpts {
  hex?: string // default: the hex with the most deduped samples in the window
  decimate?: number[] // default [3, 5]
  noDedupe?: boolean // also replay the positions the server dedupe dropped and report that run's jerk
  fromMs?: number // sample time window, server clock
  toMs?: number
}

export interface BenchResult {
  metrics: G2Metrics
  frames: Frame[]
  delays: { t: number; d: number }[]
  rates: RateAt[]
  session: { fromMs: number; toMs: number } // first and last sample tMs; Frame.t = (tMs − fromMs) / 1000
}

export interface G2Check {
  name: string
  value: number
  threshold: number
  pass: boolean
}

/** All record lines of the files in arrival order (stable, so equal tRecvMs keep file order). */
export function readLines(files: string[]): RecordLine[] {
  // ponytail: readRecording holds each file in one string, so a file must stay under V8's ~512 MB string limit
  // (a day of record-cells is ~100 MB). Upgrade: stream lines with node:readline as tools/datum-check.ts does.
  return files.flatMap((f) => readRecording(f)).sort((a, b) => a.tRecvMs - b.tRecvMs)
}

/**
 * Server-side stamping exactly as recordingToSamples (server/recording.ts): lines in the given order, the clock
 * offset updated before each line's samples are stamped, rxMs = tRecvMs. fn also sees the positions the Deduper
 * rejects (dup = true), so the duplicate fraction and the no-dedupe replay come from the same pass.
 */
export function forEachSample(lines: RecordLine[], fn: (s: Sample, dup: boolean) => void, hideFlagged = true): void {
  const offset = new MinOffset(10 * 60_000)
  const dedupe = new Deduper()
  for (const line of lines) {
    if (line.status !== 200 || line.body === '') continue
    const snap = normalizers[line.source](line.body)
    offset.update(line.tRecvMs, snap.nowMs)
    for (const ac of snap.aircraft) {
      if (hideFlagged && isHidden(ac)) continue
      const s = toSample(ac, snap.nowMs, offset.get(), line.tRecvMs)
      if (s) fn(s, !dedupe.accept(s))
    }
  }
}

function pickHex(lines: RecordLine[], fromMs: number, toMs: number): string {
  const count = new Map<string, number>()
  forEachSample(lines, (s, dup) => {
    if (!dup && s.tMs >= fromMs && s.tMs <= toMs) count.set(s.hex, (count.get(s.hex) ?? 0) + 1)
  })
  let best = ''
  let most = 0
  for (const [hex, n] of count) if (n > most) [best, most] = [hex, n]
  if (best === '') throw new Error('no samples in the recordings and time window')
  return best
}

/** The run of samples with the most samples between silences longer than SESSION_GAP_MS. */
function longestSession(ss: Sample[]): Sample[] {
  let best: Sample[] = []
  let start = 0
  for (let i = 1; i <= ss.length; i++) {
    if (i < ss.length && ss[i].tMs - ss[i - 1].tMs <= SESSION_GAP_MS) continue
    if (i - start > best.length) best = ss.slice(start, i)
    start = i
  }
  return best
}

function mostCommon<T>(xs: T[]): T {
  const n = new Map<T, number>()
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
}

/**
 * The simulated client. Polls every POLL_MS from the first sample's rxMs + HOP_MS, ingesting what each poll sees.
 * Renders at 60 Hz from the first poll + D, D = the registry's delay target after that poll, so the first frame's
 * render time is the first poll (after the first sample). Stops when render time passes the newest sample.
 */
function simulate(ss: Sample[], hex: string, enu: Enu, t0Ms: number): { frames: Frame[]; delays: { t: number; d: number }[] } {
  const byRx = ss.toSorted((a, b) => a.rxMs - b.rxMs)
  const endMs = ss.reduce((m, s) => Math.max(m, s.tMs), -Infinity)
  const reg = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
  let next = 0
  const deliver = (pollMs: number): void => {
    const batch: Sample[] = []
    while (next < byRx.length && byRx[next].rxMs <= pollMs - HOP_MS) batch.push(byRx[next++])
    if (batch.length > 0) reg.ingest(batch)
  }
  let pollMs = byRx[0].rxMs + HOP_MS
  deliver(pollMs)
  const clock = new RenderClock(reg.delayTargetS(hex))
  const startMs = pollMs + clock.delayS * 1000
  const frames: Frame[] = []
  const delays: { t: number; d: number }[] = []
  let prevMs = startMs
  for (let i = 0; ; i++) {
    const nowMs = startMs + (i * 1000) / FPS
    while (pollMs + POLL_MS <= nowMs) deliver((pollMs += POLL_MS))
    const tR = clock.tick(nowMs, reg.delayTargetS(hex), (nowMs - prevMs) / 1000)
    prevMs = nowMs
    if (tR > endMs) break
    delays.push({ t: (nowMs - t0Ms) / 1000, d: clock.delayS })
    const st = reg.get(hex)?.stateAt(tR)
    if (!st) continue // cannot happen: the first render time is after the first sample, and sessions have no > 60 s gaps
    const [e, n] = enu.fwd(st.lat, st.lon, 0)
    frames.push({ t: (tR - t0Ms) / 1000, e, n, u: st.hM, mode: st.mode, headingDeg: st.headingDeg, pitchDeg: st.pitchDeg, rollDeg: st.rollDeg })
  }
  return { frames, delays }
}

/** Frames not interpolating, split by the gap between the samples that bracket their render time. ss sorted by tMs. */
function starvation(frames: Frame[], ss: Sample[], t0Ms: number): { starvationFrames: number; gapFrames: number } {
  let j = 0
  let starvationFrames = 0
  let gapFrames = 0
  for (const f of frames) {
    if (f.mode === 'interp') continue
    const tMs = t0Ms + f.t * 1000
    while (j + 1 < ss.length && ss[j + 1].tMs <= tMs) j++
    const next = ss[j + 1]
    if (next !== undefined && next.tMs - ss[j].tMs > COVERAGE_GAP_MS) gapFrames++
    else starvationFrames++
  }
  return { starvationFrames, gapFrames }
}

/**
 * Every return to 'interp' after extrapolating or going stale is a re-join. Its error is the horizontal distance, at
 * the last frame before the new data, between what was on screen and hindsight: a fresh Track given the samples from
 * 100 s before to 30 s after. The blend time runs from that frame to the first frame within max(0.5 m, 1 % of the
 * error) of hindsight; Infinity if 3 s of interpolation never get there. A re-join the data cuts short is skipped.
 * No re-join at all → blendMaxS 0 (nothing needed blending).
 */
function rejoins(frames: Frame[], ss: Sample[], hex: string, enu: Enu, t0Ms: number): G2Metrics['rejoin'] {
  const errs: number[] = []
  const blends: number[] = []
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].mode !== 'interp' || frames[i - 1].mode === 'interp') continue
    const a = frames[i - 1]
    const hind = new Track(hex, { pollPeriodS: POLL_MS / 1000 })
    for (const s of ss) if (s.tMs >= t0Ms + (a.t - 100) * 1000 && s.tMs <= t0Ms + (a.t + 30) * 1000) hind.add(s)
    const miss = (f: Frame): number => {
      const st = hind.stateAt(t0Ms + f.t * 1000)!
      const [e, n] = enu.fwd(st.lat, st.lon, 0)
      return Math.hypot(f.e - e, f.n - n)
    }
    const err = miss(a)
    const tol = Math.max(0.5, 0.01 * err)
    let j = i
    while (j < frames.length && frames[j].mode === 'interp' && frames[j].t - a.t <= 3 && miss(frames[j]) > tol) j++
    const f = frames[j]
    if (f === undefined || f.mode !== 'interp') continue
    errs.push(err)
    blends.push(f.t - a.t <= 3 ? f.t - a.t : Infinity)
  }
  return { count: errs.length, errP95M: percentile(errs, 95), blendMaxS: blends.reduce((m, b) => Math.max(m, b), 0) }
}

/** Reported vertical rate per airborne sample, m/s: geometric for ADS-B v2 when present (as Track uses it), else barometric. */
function ratesOf(ss: Sample[], t0Ms: number): RateAt[] {
  const out: RateAt[] = []
  for (const s of ss) {
    const fpm = s.version === 2 && s.geomRateFpm !== null ? s.geomRateFpm : s.baroRateFpm
    if (!s.onGround && fpm !== null) out.push({ t: (s.tMs - t0Ms) / 1000, vsMs: fpm * FPM })
  }
  return out
}

/**
 * Keeps every k-th session sample, replays those, and scores the held-out rest as truth. A held-out sample is a turn
 * point when |track rate| (central difference of the reported track) > 1 °/s; without a reported track it is skipped.
 * The linear baseline is the straight line between the kept samples around it, at the same time.
 */
function crossTrack(k: number, session: Sample[], hex: string, enu: Enu, t0Ms: number): CrossTrack {
  const pt = (s: Sample): { t: number; e: number; n: number } => {
    const [e, n] = enu.fwd(s.lat, s.lon, 0)
    return { t: (s.tMs - t0Ms) / 1000, e, n }
  }
  const kept = session.filter((_, i) => i % k === 0)
  const K = kept.map(pt)
  const { frames } = simulate(kept, hex, enu, t0Ms)
  const first = frames[0]?.t ?? Infinity
  const last = frames.at(-1)?.t ?? -Infinity
  const turn: { t: number; e: number; n: number }[] = []
  const straight: { t: number; e: number; n: number }[] = []
  const linear: number[] = []
  let j = 0
  for (let i = 1; i < session.length; i++) {
    if (i % k === 0) continue
    const p = pt(session[i])
    const a = session[i - 1]
    const b = session[Math.min(session.length - 1, i + 1)]
    if (p.t < first || p.t > last || a.trackDeg === null || b.trackDeg === null) continue
    if (Math.abs(turnRateDegS(a.trackDeg, b.trackDeg, (b.tMs - a.tMs) / 1000)) <= TURN_DEGS) {
      straight.push(p)
      continue
    }
    while (j + 1 < K.length && K[j + 1].t <= p.t) j++
    const [x, y] = [K[j], K[j + 1]]
    const w = (p.t - x.t) / (y.t - x.t)
    turn.push(p)
    linear.push(Math.hypot(x.e + w * (y.e - x.e) - p.e, x.n + w * (y.n - x.n) - p.n))
  }
  return {
    k,
    nTurn: turn.length,
    nStraight: straight.length,
    turnP95M: percentile(crossTrackErrors(frames, turn), 95),
    straightP95M: percentile(crossTrackErrors(frames, straight), 95),
    linearTurnP95M: percentile(linear, 95),
  }
}

/** Runs the causal replay for one aircraft and computes every G2 motion metric. */
export function benchTrack(files: string[], opts: BenchOpts = {}): BenchResult {
  const lines = readLines(files)
  const fromMs = opts.fromMs ?? -Infinity
  const toMs = opts.toMs ?? Infinity
  const hex = opts.hex?.toLowerCase() ?? pickHex(lines, fromMs, toMs)
  const unique: Sample[] = []
  const served: Sample[] = []
  forEachSample(lines, (s, dup) => {
    if (s.hex !== hex || s.tMs < fromMs || s.tMs > toMs) return
    served.push(s)
    if (!dup) unique.push(s)
  })
  if (unique.length === 0) throw new Error(`no samples for ${hex} in the recordings and time window`)
  // ponytail: one session per run (the longest); upgrade: bench every session and pool the per-frame values.
  const session = longestSession(unique)
  const t0Ms = session[0].tMs
  const endMs = session[session.length - 1].tMs
  const inSession = served.filter((s) => s.tMs >= t0Ms && s.tMs <= endMs + 100) // + the Deduper's 100 ms window
  // ponytail: one ENU frame at the first sample; its scale error is ≈ d²/2R² (1.2 % at 1000 km). Use --from/--to on long flights.
  const enu = new Enu(session[0].lat, session[0].lon, 0)
  const { frames, delays } = simulate(session, hex, enu, t0Ms)
  const rates = ratesOf(session, t0Ms)
  const ds = delays.map((x) => x.d)
  const metrics: G2Metrics = {
    hex,
    quality: mostCommon(session.map((s) => s.quality)),
    samples: session.length,
    frames: frames.length,
    delayS: { start: ds[0] ?? NaN, p50: percentile(ds, 50), max: ds.length > 0 ? ds.reduce((m, d) => Math.max(m, d)) : NaN },
    ...starvation(frames, session, t0Ms),
    frameDiscontinuity: frameDiscontinuity(frames),
    lateralAccel: lateralAccel(frames),
    jerk: jerk(frames),
    vertical: verticalMetrics(frames, rates),
    delaySlew: delaySlew(delays),
    rejoin: rejoins(frames, session, hex, enu, t0Ms),
    crossTrack: (opts.decimate ?? [3, 5]).map((k) => crossTrack(k, session, hex, enu, t0Ms)),
    dedupe: {
      served: inSession.length,
      unique: session.length,
      duplicateFraction: 1 - session.length / inSession.length,
      // ponytail: Track (WP-I2) dedupes on its own, so this equals jerk.p99 unless a duplicate slips past both.
      jerkP99NoDedupe: opts.noDedupe ? jerk(simulate(inSession, hex, enu, t0Ms).frames).p99 : null,
    },
  }
  return { metrics, frames, delays, rates, session: { fromMs: t0Ms, toMs: endMs } }
}

/**
 * G2 motion bars (PLAN.md §6). ADS-B (the v2 table): interpolation discontinuity ≤ 2 m, 0 starvation frames, held-out
 * turn cross-track p95 ≤ 5 m at k = 3 and ≤ 15 m at k = 5 and ≤ 50 % of linear, lateral acceleration p99 ≤ 5.7 m/s²,
 * VS error p95 ≤ 2 m/s, height step ≤ 1 m per frame, delay slew ≤ 0.2 s/s, re-join blended ≤ 1.5 s. An MLAT hex is held
 * to its separate bar only: lateral acceleration p99 ≤ 0.5 g. NaN (no data) fails; 1e-9 absorbs float noise at a bar.
 */
export function evaluateG2(m: G2Metrics): { pass: boolean; checks: G2Check[] } {
  const check = (name: string, value: number, threshold: number): G2Check => ({ name, value, threshold, pass: value <= threshold + 1e-9 })
  const done = (checks: G2Check[]): { pass: boolean; checks: G2Check[] } => ({ pass: checks.every((c) => c.pass), checks })
  if (m.quality === 'mlat') return done([check('lateralAccelP99', m.lateralAccel.p99, 0.5 * G)])
  return done([
    check('frameDiscontinuityMaxM', m.frameDiscontinuity.maxM, 2),
    check('starvationFrames', m.starvationFrames, 0),
    ...[3, 5].flatMap((k) => {
      const c = m.crossTrack.find((x) => x.k === k)
      return [
        check(`crossTrackTurnP95M@${k}`, c?.turnP95M ?? NaN, TURN_BAR_M[k]),
        check(`crossTrackTurnVsLinear@${k}`, c ? c.turnP95M / c.linearTurnP95M : NaN, 0.5),
      ]
    }),
    check('lateralAccelP99', m.lateralAccel.p99, 5.7),
    check('vsErrP95', m.vertical.vsErrP95, 2),
    check('verticalMaxStepM', m.vertical.maxStepM, 1),
    check('delaySlew', m.delaySlew, 0.2),
    check('rejoinBlendMaxS', m.rejoin.blendMaxS, 1.5),
  ])
}

const round3 = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? x : Math.round(x * 1000) / 1000)

function timeArg(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined
  const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v)
  if (Number.isNaN(ms)) throw new Error(`--${name} must be an ISO time or epoch ms, got ${v}`)
  return ms
}

/** The CLI: parse, bench, score, write the report, print a table. Returns the report and where it was written. */
export function run(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      recordings: { type: 'string', multiple: true, default: [] },
      hex: { type: 'string' },
      decimate: { type: 'string', default: '3,5' },
      'no-dedupe': { type: 'boolean', default: false },
      from: { type: 'string' },
      to: { type: 'string' },
      out: { type: 'string', default: '.planning/reports' },
    },
  })
  const patterns = [...values.recordings, ...positionals]
  const files = [...new Set(patterns.flatMap((p) => (/[*?[{]/.test(p) ? globSync(p) : [p])))].sort()
  if (files.length === 0) throw new Error(`no recordings match ${patterns.join(' ') || '(none given)'}: pass --recordings <files or glob>`)
  const decimate = values.decimate.split(',').filter((x) => x !== '').map(Number)
  if (decimate.some((k) => !Number.isInteger(k) || k < 2)) throw new Error(`--decimate takes integers ≥ 2, got ${values.decimate}`)
  const { metrics, session } = benchTrack(files, {
    hex: values.hex,
    decimate,
    noDedupe: values['no-dedupe'],
    fromMs: timeArg(values.from, 'from'),
    toMs: timeArg(values.to, 'to'),
  })
  const result = evaluateG2(metrics)
  const now = new Date()
  // JSON has no NaN/Infinity: a missing metric and an unfinished blend are written as null.
  const report = {
    gate: 'G2',
    generatedAt: now.toISOString(),
    files,
    hex: metrics.hex,
    session: { from: new Date(session.fromMs).toISOString(), to: new Date(session.toMs).toISOString() },
    ...result,
    metrics,
  }
  mkdirSync(values.out, { recursive: true })
  const path = join(values.out, `G2-${metrics.hex}-${now.toISOString().slice(0, 10)}.json`)
  writeFileSync(path, JSON.stringify(report, null, 1) + '\n')
  console.log(`G2 bench ${metrics.hex} (${metrics.quality}), ${report.session.from} → ${report.session.to}, ${metrics.samples} samples, ${metrics.frames} frames, D p50 ${metrics.delayS.p50} s`)
  console.table(result.checks.map((c) => ({ check: c.name, value: round3(c.value), threshold: round3(c.threshold), result: c.pass ? 'pass' : 'FAIL' })))
  console.table({
    gapFrames: metrics.gapFrames,
    frameDiscontinuityP99M: round3(metrics.frameDiscontinuity.p99M),
    lateralAccelMax: round3(metrics.lateralAccel.max),
    jerkP99: round3(metrics.jerk.p99),
    jerkP99NoDedupe: round3(metrics.dedupe.jerkP99NoDedupe),
    duplicateFraction: round3(metrics.dedupe.duplicateFraction),
    rejoins: metrics.rejoin.count,
    rejoinErrP95M: round3(metrics.rejoin.errP95M),
    ...Object.fromEntries(metrics.crossTrack.map((c) => [`straightP95M@${c.k}`, round3(c.straightP95M)])),
  })
  console.log(`G2 ${result.pass ? 'PASS' : 'FAIL'} → ${path}`)
  return { report, path }
}

if (import.meta.main) {
  const { report } = run(process.argv.slice(2))
  process.exitCode = report.pass ? 0 : 1
}
