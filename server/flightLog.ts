// server/flightLog.ts
// Records chosen flights, each to its own file, for later study (approach procedures into an airport, and which one a
// flight is flying). The poller hands over every new sample (add); the poller also keeps recorded aircraft polled when
// no view covers them (Poller opts.watched). A recording ends by hand, or by itself once the aircraft has landed and
// slowed to taxi speed, or after it has been silent for a while (out of coverage, often low on an approach).
//
// <dir>/YYYY-MM-DD/HHMMSSZ-<callsign or hex>-<hex>.jsonl (UTC start), one JSON object per line:
//   {"flight": {v, hex, callsign, reg, typeCode, route, source, by, startedMs}}   first line
//   {"s": Sample}                                                                  one per sample, oldest first
//   {"route": "LIRF-LLBG"}                                                         when the route becomes known or changes
//                                                                                   (it often arrives after the start, and an
//                                                                                   aircraft may drop its callsign on landing)
//   {"end": {why: 'stopped'|'landed'|'lost', endedMs, samples}}                    last line, when it ended
// A file without an end line was cut short by a server stop that did not resume it.
// <dir>/active.json lists the recordings under way, so a restarted server carries on appending to the same files.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordingInfo, RecordingState, RecordingTrack } from '../shared/api.ts'
import type { AircraftInfo } from '../shared/info.ts'
import type { Sample, SourceKind } from '../shared/types.ts'

export const LANDED_KT = 40 // on the ground below this, after being airborne in this recording: landed, taxiing
export const LANDED_HOLD_MS = 60_000 // … for this long (the roll-out and the turn off the runway are kept)
export const LOST_MS = 15 * 60_000 // no new sample for this long: gone (out of coverage, or landed where no one hears it)

export type EndReason = 'stopped' | 'landed' | 'lost'

/** A recording's path under the flights directory, as start() names it: nothing else is ever read. */
export const RECORDING_FILE = /^\d{4}-\d{2}-\d{2}\/\d{6}Z-[A-Za-z0-9]*-[0-9a-fx]{6,7}\.jsonl$/

interface Active {
  state: RecordingState
  route: string | null // the last route written
  airborne: boolean // seen airborne since the recording began: only then can it "land"
  slowSinceMs: number | null // rxMs from which it has been on the ground and slow
}

export class FlightLog {
  #dir: string
  #now: () => number
  #source: SourceKind
  #active = new Map<string, Active>()
  #routeOf: (hex: string) => string | null

  /** routeOf: the aircraft's route as known now (the InfoStore's), for recordings started before it was. */
  constructor(opts: { dir: string; source: SourceKind; nowMs?: () => number; routeOf?: (hex: string) => string | null }) {
    this.#dir = opts.dir
    this.#routeOf = opts.routeOf ?? (() => null)
    this.#source = opts.source
    this.#now = opts.nowMs ?? Date.now
    mkdirSync(this.#dir, { recursive: true })
    this.#resume()
  }

  /**
   * Starts recording this aircraft (a no-op answer if it already is), beginning with `backfill`: the samples the store
   * still holds of it (the last few minutes).
   */
  start(hex: string, info: AircraftInfo | null, backfill: readonly Sample[]): RecordingState {
    hex = hex.toLowerCase()
    const had = this.#active.get(hex)
    if (had) return { ...had.state }
    const now = this.#now()
    const iso = new Date(now).toISOString() // 2026-09-30T14:30:12.345Z
    const name = (info?.callsign ?? hex).replace(/[^A-Za-z0-9]/g, '')
    const file = `${iso.slice(0, 10)}/${iso.slice(11, 19).replace(/:/g, '')}Z-${name}-${hex.replace('~', 'x')}.jsonl`
    mkdirSync(join(this.#dir, iso.slice(0, 10)), { recursive: true })
    const flight = {
      v: 1,
      hex,
      callsign: info?.callsign ?? null,
      reg: info?.reg ?? null,
      typeCode: info?.typeCode ?? null,
      category: info?.category ?? null,
      military: info?.military ?? false,
      route: info?.route ?? null,
      source: this.#source,
      by: 'hand',
      startedMs: now,
    }
    appendFileSync(join(this.#dir, file), JSON.stringify({ flight }) + '\n')
    const a: Active = { state: { hex, callsign: flight.callsign, file, startedMs: now, samples: 0, lastMs: null }, route: flight.route, airborne: false, slowSinceMs: null }
    this.#active.set(hex, a)
    for (const s of backfill) this.#write(a, s)
    this.#save()
    return { ...a.state }
  }

  /** Ends this aircraft's recording. Its final state, or null when it was not being recorded. */
  stop(hex: string, why: EndReason = 'stopped'): RecordingState | null {
    hex = hex.toLowerCase()
    const a = this.#active.get(hex)
    if (!a) return null
    this.#active.delete(hex)
    this.#noteRoute(hex, a)
    const end = { why, endedMs: this.#now(), samples: a.state.samples }
    appendFileSync(join(this.#dir, a.state.file), JSON.stringify({ end }) + '\n')
    this.#save()
    return { ...a.state }
  }

  /** A new sample from the poller: appended when its aircraft is being recorded. */
  add(s: Sample): void {
    const a = this.#active.get(s.hex)
    if (a) this.#write(a, s)
  }

  /** Writes routes learnt since; ends recordings that landed (slow for LANDED_HOLD_MS after flying) or fell silent for LOST_MS. */
  tick(): void {
    const now = this.#now()
    for (const [hex, a] of this.#active) {
      this.#noteRoute(hex, a)
      if (a.slowSinceMs !== null && now - a.slowSinceMs >= LANDED_HOLD_MS) this.stop(hex, 'landed')
      else if (now - (a.state.lastMs ?? a.state.startedMs) >= LOST_MS) this.stop(hex, 'lost')
    }
  }

  get(hex: string): RecordingState | null {
    const a = this.#active.get(hex.toLowerCase())
    return a ? { ...a.state } : null
  }

  active(): RecordingState[] {
    return [...this.#active.values()].map((a) => ({ ...a.state }))
  }

  hexes(): string[] {
    return [...this.#active.keys()]
  }

  /** Every recording on disk, newest first. ponytail: reads every file whole per call (KBs to a few MB each). */
  list(): RecordingInfo[] {
    const out: RecordingInfo[] = []
    let days: string[]
    try {
      days = readdirSync(this.#dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    } catch {
      return out
    }
    for (const day of days) {
      for (const name of readdirSync(join(this.#dir, day))) {
        const file = `${day}/${name}`
        if (!RECORDING_FILE.test(file)) continue
        const r = this.read(file)
        if (r !== null) out.push(r.info)
      }
    }
    return out.sort((a, b) => b.startedMs - a.startedMs)
  }

  /** One recording (its info and samples, oldest first), or null: not a recording file, missing, or no header. */
  read(file: string): RecordingTrack | null {
    if (!RECORDING_FILE.test(file)) return null
    let text: string
    try {
      text = readFileSync(join(this.#dir, file), 'utf8')
    } catch {
      return null
    }
    let head: Record<string, unknown> | null = null
    let ended: RecordingInfo['ended'] = null
    let route: string | null = null
    const samples: Sample[] = []
    for (const line of text.split('\n')) {
      if (line === '') continue
      let o: { flight?: Record<string, unknown>; s?: Sample; route?: unknown; end?: { why: EndReason; endedMs: number } }
      try {
        o = JSON.parse(line)
      } catch {
        continue // a line cut short by a crash mid-write
      }
      if (o.s) samples.push(o.s)
      else if (o.flight) head = o.flight
      else if (typeof o.route === 'string') route = o.route
      else if (o.end) ended = { why: o.end.why, endedMs: o.end.endedMs }
    }
    if (head === null || typeof head.hex !== 'string') return null
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
    const hex = head.hex
    const active = ended === null && this.#active.get(hex)?.state.file === file
    return {
      info: {
        file, hex,
        callsign: str(head.callsign), reg: str(head.reg), typeCode: str(head.typeCode), category: str(head.category),
        military: head.military === true, route: route ?? str(head.route) ?? (active ? this.#routeOf(hex) : null), source: str(head.source) ?? '',
        startedMs: typeof head.startedMs === 'number' ? head.startedMs : 0,
        firstMs: samples.length > 0 ? samples[0].tMs : null,
        lastMs: samples.length > 0 ? samples[samples.length - 1].tMs : null,
        samples: samples.length,
        ended,
        active,
      },
      samples,
    }
  }

  #write(a: Active, s: Sample): void {
    try {
      appendFileSync(join(this.#dir, a.state.file), JSON.stringify({ s }) + '\n')
    } catch (e) {
      console.error('flightLog: write failed:', e) // ponytail: a full disk logs once per sample; the recording goes on
      return
    }
    a.state.samples++
    a.state.lastMs = Math.max(a.state.lastMs ?? -Infinity, s.rxMs)
    if (!s.onGround) {
      a.airborne = true
      a.slowSinceMs = null
    } else if (a.airborne && (s.gsKt ?? 0) < LANDED_KT) a.slowSinceMs ??= s.rxMs
    else a.slowSinceMs = null
  }

  /** A route line when the aircraft's route is known and differs from the last one written. */
  #noteRoute(hex: string, a: Active): void {
    const route = this.#routeOf(hex)
    if (route === null || route === a.route) return
    a.route = route
    try {
      appendFileSync(join(this.#dir, a.state.file), JSON.stringify({ route }) + '\n')
    } catch (e) {
      console.error('flightLog: write failed:', e)
    }
  }

  #save(): void {
    const list = [...this.#active.values()].map((a) => ({ ...a.state, airborne: a.airborne }))
    writeFileSync(join(this.#dir, 'active.json'), JSON.stringify(list, null, 1) + '\n')
  }

  /** Picks up the recordings a previous server left under way; their counts from the files (active.json has the start's). */
  #resume(): void {
    let list: (RecordingState & { airborne?: boolean })[]
    try {
      list = JSON.parse(readFileSync(join(this.#dir, 'active.json'), 'utf8'))
    } catch {
      return // none yet, or unreadable: start clean
    }
    if (!Array.isArray(list)) return
    for (const r of list) {
      if (typeof r?.hex !== 'string' || typeof r.file !== 'string') continue
      const { airborne, ...state } = r
      const a: Active = { state, route: null, airborne: airborne === true, slowSinceMs: null }
      try {
        let n = 0
        for (const line of readFileSync(join(this.#dir, r.file), 'utf8').split('\n')) {
          if (line.startsWith('{"route":')) a.route = (JSON.parse(line) as { route: string }).route
          if (!line.startsWith('{"s":')) continue
          const s = (JSON.parse(line) as { s: Sample }).s
          n++
          state.lastMs = Math.max(state.lastMs ?? -Infinity, s.rxMs)
          if (!s.onGround) a.airborne = true
        }
        state.samples = n
      } catch {
        // the file is gone or unreadable: the count stays as saved; appending recreates it
      }
      this.#active.set(r.hex, a)
    }
  }
}
