// tools/record-arrivals.ts
// Arrival recorder (replaces tools/record-cells.ts): polls a 40 nm circle around each hero airport on adsb.lol,
// round-robin, and follows every aircraft that is landing there with one batched /v2/hex poll per second, all
// under one TokenBucket. Every raw response goes to data/recordings/YYYY-MM-DD.jsonl (RecordLine format).
//
//   CONTACT=you@example.com node tools/record-arrivals.ts [--max-rps 0.08] [--heroes KSFO,LLBG,LOWI] [--radius-nm 40]
//     [--cell-period-ms 6000] [--hex-period-ms 1000] [--out data/recordings]
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { TokenBucket } from '../server/budget.ts'
import { Recorder } from '../server/recorder.ts'
import { makeAdsblol } from '../server/sources/adsblol.ts'
import type { FetchResult, Source } from '../server/sources/types.ts'
import { SampleStore } from '../server/store.ts'
import { MinOffset } from '../shared/clock.ts'
import { distanceNm } from '../shared/geo.ts'
import { isHidden, toSample } from '../shared/sample.ts'
import type { Sample } from '../shared/types.ts'

export interface Hero {
  ident: string
  lat: number
  lon: number
  elevFt: number
}

/** Airport reference points and field elevations from OurAirports (data/fixtures/golden/airports-sample.json). */
export const HEROES: Hero[] = [
  { ident: 'KSFO', lat: 37.619806, lon: -122.374821, elevFt: 13 },
  { ident: 'LLBG', lat: 32.011398, lon: 34.8867, elevFt: 135 },
  { ident: 'LOWI', lat: 47.260201, lon: 11.344, elevFt: 1907 },
]

const PICK_NM = 25
const MAX_ABOVE_FIELD_FT = 10_000
const DESCENT_FPM = -300
const ROLL_KT = 30
const MAX_HEXES = 100 // server/sources/adsblol.ts batch limit
const MAX_GAP_MS = 5 * 60_000

/**
 * Hexes worth following to the runway. Per hex only its latest sample (largest tMs) counts: within 25 nm of a
 * hero, and either airborne below 10,000 ft above that field and descending faster than 300 fpm (baro rate, else
 * geometric rate; baro altitude, else geometric), or on the ground rolling faster than 30 kt (landing roll).
 */
export function pickArrivals(samples: Sample[], heroes: { ident: string; lat: number; lon: number; elevFt: number }[]): string[] {
  const latest = new Map<string, Sample>()
  for (const s of samples) {
    const p = latest.get(s.hex)
    if (!p || s.tMs > p.tMs) latest.set(s.hex, s)
  }
  const out: string[] = []
  for (const s of latest.values()) {
    const alt = s.altBaroFt ?? s.altGeomFt
    const rate = s.baroRateFpm ?? s.geomRateFpm
    const near = heroes.filter((h) => distanceNm(h.lat, h.lon, s.lat, s.lon) <= PICK_NM)
    const rolling = s.onGround && (s.gsKt ?? 0) > ROLL_KT
    const descending = !s.onGround && rate !== null && rate < DESCENT_FPM && alt !== null && near.some((h) => alt - h.elevFt < MAX_ABOVE_FIELD_FT)
    if (near.length > 0 && (rolling || descending)) out.push(s.hex)
  }
  return out
}

export interface ArrivalLoopOpts {
  source: Source
  bucket: TokenBucket
  store: SampleStore
  recorder: Recorder | null
  heroes: Hero[]
  radiusNm?: number
  cellPeriodMs?: number
  hexPeriodMs?: number
  nowMs?: () => number
  log?: (line: string) => void
}

/**
 * The recorder's scheduler. step() sends at most one request: of the hero cells (each due cellPeriodMs after its
 * last poll) and the arrival batch (due hexPeriodMs after its last poll, only while pickArrivals finds any), the
 * most overdue goes first, the batch winning ties. Requests are spaced ≥ 1/maxRps apart; every 429 doubles that
 * spacing for the rest of the run (never climb back to a rate that was refused), on top of the bucket's own
 * Retry-After pause. 'blocked' after a 401/403: the caller must stop.
 */
export function arrivalLoop(o: ArrivalLoopOpts): { step(): Promise<'sent' | 'idle' | 'blocked'>; picked(): string[] } {
  const radiusNm = o.radiusNm ?? 40
  const cellPeriodMs = o.cellPeriodMs ?? 6000
  const hexPeriodMs = o.hexPeriodMs ?? 1000
  const nowMs = o.nowMs ?? Date.now
  const log = o.log ?? console.log
  const offset = new MinOffset(10 * 60_000)
  const lastCellMs = o.heroes.map(() => -Infinity)
  let lastHexMs = -Infinity
  let lastSendMs = -Infinity
  let gapMs = 1000 / o.bucket.state().maxRps
  let picked: string[] = []

  function ingest(r: FetchResult): void {
    o.bucket.onResult(r.status, r.retryAfterS)
    if (r.status === 429) gapMs = Math.min(MAX_GAP_MS, gapMs * 2)
    o.recorder?.write(o.source.caps.kind, r)
    if (r.status !== 200) log(`${new Date(nowMs()).toISOString()} HTTP ${r.status} ${r.url}; spacing ${gapMs} ms`)
    const snap = r.snapshot
    if (snap === null) return
    offset.update(r.tRecvMs, snap.nowMs)
    for (const ac of snap.aircraft) {
      if (isHidden(ac)) continue // never follow PIA/LADD aircraft (their raw lines are still recorded as served)
      const s = toSample(ac, snap.nowMs, offset.get(), r.tRecvMs)
      if (s) o.store.add(s)
    }
  }

  async function step(): Promise<'sent' | 'idle' | 'blocked'> {
    if (o.bucket.degraded === 'blocked') return 'blocked'
    const now = nowMs()
    o.store.prune(now)
    const next = pickArrivals(o.heroes.flatMap((h) => o.store.view(h.lat, h.lon, PICK_NM, 0)), o.heroes)
    if (next.join() !== picked.join()) log(`${new Date(now).toISOString()} following ${next.length}: ${next.join(' ')}`)
    picked = next
    if (now - lastSendMs < gapMs) return 'idle'
    // overdue = time since the last poll in periods; ≥ 1 is due. The most overdue goes first, so when the budget
    // is short every job slows by the same factor and the 1 s : 6 s proportion holds.
    let most = picked.length > 0 ? (now - lastHexMs) / hexPeriodMs : 0
    let cell = -1 // -1: the arrival batch
    for (let i = 0; i < o.heroes.length; i++) {
      const overdue = (now - lastCellMs[i]) / cellPeriodMs
      if (overdue > most) {
        most = overdue
        cell = i
      }
    }
    if (most < 1 || !o.bucket.tryTake()) return 'idle'
    lastSendMs = now
    if (cell === -1) {
      lastHexMs = now
      ingest(await o.source.hexes(picked.slice(0, MAX_HEXES)))
    } else {
      lastCellMs[cell] = now
      const h = o.heroes[cell]
      ingest(await o.source.circle(h.lat, h.lon, radiusNm))
    }
    return 'sent'
  }

  return { step, picked: () => picked }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'max-rps': { type: 'string', default: '0.08' },
      heroes: { type: 'string', default: 'KSFO,LLBG,LOWI' },
      'radius-nm': { type: 'string', default: '40' },
      'cell-period-ms': { type: 'string', default: '6000' },
      'hex-period-ms': { type: 'string', default: '1000' },
      out: { type: 'string', default: 'data/recordings' },
      'base-url': { type: 'string' }, // hidden: tests point the CLI at a local fake adsb.lol
    },
  })
  const contact = process.env.CONTACT
  if (!contact) throw new Error('Set CONTACT (e.g. in .env.local); it goes into the User-Agent.')
  const maxRps = Number(values['max-rps'])
  if (!(maxRps > 0 && maxRps <= 1)) throw new Error('--max-rps must be in (0, 1]: adsb.lol gets at most 1 req/s from all our processes')
  const heroes = values.heroes.split(',').map((id) => {
    const h = HEROES.find((x) => x.ident === id)
    if (!h) throw new Error(`unknown hero ${id}; known: ${HEROES.map((x) => x.ident).join(',')}`)
    return h
  })
  const bucket = new TokenBucket(maxRps)
  const loop = arrivalLoop({
    source: makeAdsblol({ userAgent: `FlightHopper/0.1 (+${contact})`, baseUrl: values['base-url'] }),
    bucket,
    store: new SampleStore(),
    recorder: new Recorder(values.out),
    heroes,
    radiusNm: Number(values['radius-nm']),
    cellPeriodMs: Number(values['cell-period-ms']),
    hexPeriodMs: Number(values['hex-period-ms']),
  })
  console.log(`record-arrivals: ${values.heroes} at ${values['radius-nm']} nm, ≤ ${maxRps} req/s → ${values.out}`)
  let summaryAt = Date.now() + 60_000
  for (;;) {
    const r = await loop.step()
    if (r === 'blocked') {
      console.error('HTTP 401/403 from adsb.lol: blocked. Stopping; do not retry automatically.')
      process.exit(1)
    }
    if (Date.now() >= summaryAt) {
      const s = bucket.state()
      console.log(`${new Date().toISOString()} ok ${s.counts.ok} 429 ${s.counts.r429} 5xx ${s.counts.r5xx} err ${s.counts.err} rps ${s.rps.toFixed(3)} following ${loop.picked().length}`)
      summaryAt += 60_000
    }
    if (r === 'idle') await sleep(100)
  }
}

if (import.meta.main) await main()
