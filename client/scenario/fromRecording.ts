// client/scenario/fromRecording.ts
// A recorded flight (server/flightLog.ts, GET /api/recordings/track) as a scenario the player runs like a package: the
// same estimator the live chase uses (track.ts: smoothed path, flight-mechanics attitude) is run over the samples, a
// render clock stepping one second at a time with the samples LOOKAHEAD_MS ahead of it (as the live chase has them
// with its delay), and each second becomes a track row. Take-off and landing are the timeline's marks; the gear follows
// the height above the ground drawn, as in a live chase (gearFromHeight). Times are UTC.
import type { RecordingTrack } from '../../shared/api.ts'
import { geoidN } from '../../shared/geoid.ts'
import type { Sample } from '../../shared/types.ts'
import { Track } from '../track/track.ts'
import type { EventRow, Scenario, TrackRow } from './types.ts'

export const RECORDING_PREFIX = 'rec:'
const LOOKAHEAD_MS = 30_000 // well inside the track's 120 s window; a live chase runs ~5–30 s behind its newest sample
const STEP_MS = 1000
const FT = 0.3048
const DAY_MS = 86_400_000

/** A recording's scenario id ('rec:2026-09-30/002932Z-ITY810-4cae1d'); it also names it in the URL. */
export const recordingId = (file: string): string => RECORDING_PREFIX + file.replace(/\.jsonl$/, '')

/** The recording file a scenario id names, or null when it names a package. */
export const recordingFile = (id: string): string | null => (id.startsWith(RECORDING_PREFIX) ? `${id.slice(RECORDING_PREFIX.length)}.jsonl` : null)

/**
 * The recording as a scenario, flown by manifest model `model`; null when it has too little to play (under two
 * seconds of track). Samples may come in any order and repeat (the Track drops those).
 */
export function recordingScenario(rec: RecordingTrack, model: string): Scenario | null {
  const samples: Sample[] = [...rec.samples].sort((a, b) => a.tMs - b.tMs)
  if (samples.length < 2) return null
  const first = samples[0].tMs
  const last = samples[samples.length - 1].tMs
  const t0UtcMs = Math.floor(first / DAY_MS) * DAY_MS
  const track = new Track(rec.info.hex)
  const rows: TrackRow[] = []
  const events: EventRow[] = []
  let next = 0
  let gnd: boolean | null = null
  for (let tMs = first; tMs <= last; tMs += STEP_MS) {
    while (next < samples.length && samples[next].tMs <= tMs + LOOKAHEAD_MS) track.add(samples[next++])
    const s = track.stateAt(tMs)
    if (s === null) continue
    const t = (tMs - t0UtcMs) / 1000
    rows.push({
      t, lat: s.lat, lon: s.lon, altFt: (s.hM - geoidN(s.lat, s.lon)) / FT,
      hdg: s.headingDeg, pitch: s.pitchDeg, roll: s.rollDeg, gnd: s.onGround,
      iasKt: s.iasKt ?? null, gsKt: s.gsKt, vsFpm: s.vsFpm, g: null, windFromDeg: null, windKt: null, epr: null,
      q: 'A', src: 'ADS-B',
    })
    if (gnd !== null && gnd !== s.onGround) events.push({ t, type: 'mark', value: '', label: s.onGround ? 'Landing' : 'Take-off', src: null })
    gnd = s.onGround
  }
  if (rows.length < 2) return null
  const { info } = rec
  const title = info.callsign ?? info.hex.toUpperCase()
  return {
    format: 1,
    id: recordingId(info.file),
    title,
    subtitle: info.route === null ? '' : info.route.split('-').join(' → '),
    date: new Date(t0UtcMs).toISOString().slice(0, 10),
    utcOffset: '+00:00',
    clockLabel: 'UTC',
    start: rows[0].t,
    end: rows[rows.length - 1].t,
    t0UtcMs,
    note: '',
    summary: [],
    crew: [],
    aircraft: { registration: info.reg ?? '', type: info.typeCode ?? '', callsign: title, operator: '', model },
    speakers: {},
    imagery: [],
    ending: null,
    audio: null,
    sources: [],
    track: rows,
    events,
    lines: [],
    base: '',
    present: { body: false, finLogo: false, audio: false },
    gearFromHeight: true,
  }
}
