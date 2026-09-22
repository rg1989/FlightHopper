// tools/datum-check.ts
// G2 datum gate: |median(alt_geom − nominal 3° glidepath HAE)| ≤ 10 m over ≥ 3 ADS-B v2 arrivals.
//
//   node tools/datum-check.ts --recordings 'data/recordings/*.jsonl' --airports public/airports/heroes.json --airport KSFO [--out .planning/reports]
//
// --recordings takes files and/or globs (quoted globs are expanded here). Files are read in name order,
// which is time order for the UTC daily recording files. Writes <out>/datum-<ICAO>-<YYYY-MM-DD>.json; exit code 1 = fail.
import { createReadStream, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { parseRecordLine, recordingToSamples, type RecordLine } from '../server/recording.ts'
import type { Airport } from '../shared/airports.ts'
import { distanceNm } from '../shared/geo.ts'
import type { Sample } from '../shared/types.ts'
import { RADIUS_NM } from './analysis/census.ts'
import { approachResiduals, quantile, summarizeDatum } from './analysis/datum.ts'

const OFFSET_WINDOW_MS = 10 * 60_000 // recordingToSamples' MinOffset window

/**
 * Samples within radiusNm of the airport, decoded chunkLines lines at a time. A day of recordings is
 * larger than the biggest string V8 can hold, so readRecording (one readFileSync) cannot load it.
 * Each chunk is re-decoded with the previous 10 min of lines in front, so the clock offset and the
 * dedupe state match a single recordingToSamples pass; samples of those lead-in lines are not emitted twice.
 */
export async function samplesNear(files: string[], ap: Airport, radiusNm: number, chunkLines = 2000): Promise<Sample[]> {
  const out: Sample[] = []
  let lines: RecordLine[] = []
  let fresh = 0
  let doneRxMs = -Infinity
  const flush = (): void => {
    for (const s of recordingToSamples(lines)) {
      if (s.rxMs > doneRxMs && distanceNm(ap.lat, ap.lon, s.lat, s.lon) <= radiusNm) out.push(s)
    }
    doneRxMs = lines[lines.length - 1].tRecvMs
    lines = lines.filter((l) => l.tRecvMs >= doneRxMs - OFFSET_WINDOW_MS)
    fresh = 0
  }
  for (const file of files) {
    for await (const text of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      if (text.trim() === '') continue
      lines.push(parseRecordLine(text))
      if (++fresh >= chunkLines) flush()
    }
  }
  if (fresh > 0) flush()
  return out
}

export interface Inputs {
  airport: Airport
  files: string[]
  samples: Sample[]
  out: string
}

/** Shared by tools/datum-check.ts and tools/census.ts: parse the CLI, load the airport and the nearby samples. */
export async function loadInputs(argv: string[]): Promise<Inputs> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      recordings: { type: 'string', multiple: true, default: [] },
      airports: { type: 'string', default: 'public/airports/heroes.json' },
      airport: { type: 'string' },
      out: { type: 'string', default: '.planning/reports' },
    },
  })
  const ident = values.airport?.toUpperCase()
  if (!ident) throw new Error('--airport <ICAO> is required')
  const airport = (JSON.parse(readFileSync(values.airports, 'utf8')) as Airport[]).find((a) => a.ident === ident)
  if (!airport) throw new Error(`${ident} is not in ${values.airports}`)
  const patterns = [...values.recordings, ...positionals]
  const files = [...new Set(patterns.flatMap((p) => (/[*?[{]/.test(p) ? globSync(p) : [p])))].sort()
  if (files.length === 0) throw new Error(`no recordings match ${patterns.join(' ') || '(none given)'}: pass --recordings <files or glob>`)
  return { airport, files, samples: await samplesNear(files, airport, RADIUS_NM), out: values.out }
}

/** Writes <out>/<name>-<UTC date>.json and returns its path. */
export function writeReport(out: string, name: string, report: unknown): string {
  mkdirSync(out, { recursive: true })
  const path = join(out, `${name}-${new Date().toISOString().slice(0, 10)}.json`)
  writeFileSync(path, JSON.stringify(report, null, 1) + '\n')
  return path
}

export const round1 = (x: number | null): number | null => (x === null || Number.isNaN(x) ? null : Math.round(x * 10) / 10)

export async function run(argv: string[]) {
  const { airport, files, samples, out } = await loadInputs(argv)
  const ends = airport.runways.flatMap((r) => r.ends).map((e) => ({ ident: e.ident, res: approachResiduals(samples, e) }))
  const all = ends.flatMap((e) => e.res)
  const summary = summarizeDatum(all)
  const notV2 = all.filter((r) => r.version !== 2)
  const report = {
    airport: airport.ident,
    generatedAt: new Date().toISOString(),
    files,
    samplesNearAirport: samples.length,
    summary,
    runwayEnds: ends.map((e) => {
      const { arrivals, n, medianM } = summarizeDatum(e.res, 1)
      return { ident: e.ident, arrivals, n, medianM }
    }),
    // v0/v1 alt_geom may legitimately be MSL: reported for information, never part of the gate.
    notV2: { n: notV2.length, medianM: quantile(notV2.map((r) => r.rM), 0.5) },
    residuals: ends.flatMap((e) => e.res.map((r) => ({ end: e.ident, ...r }))),
  }
  const path = writeReport(out, `datum-${airport.ident}`, report)
  console.log(`Datum check ${airport.ident} (EGM96 N ${airport.nM} m): ${samples.length} samples within ${RADIUS_NM} nm, ${files.length} file(s)`)
  console.table([
    ...report.runwayEnds.map((e) => ({ set: `v2 ${e.ident}`, arrivals: e.arrivals, samples: e.n, medianM: round1(e.medianM) })),
    { set: 'v2 all (gate)', arrivals: summary.arrivals, samples: summary.n, medianM: round1(summary.medianM) },
    { set: 'v0/v1 (flagged, not gated)', arrivals: null, samples: notV2.length, medianM: round1(report.notV2.medianM) },
  ])
  console.log(`${summary.pass ? 'PASS' : 'FAIL'}: |median| ${round1(Math.abs(summary.medianM)) ?? 'n/a'} m (limit 10 m), ${summary.arrivals} v2 arrivals (need 3)`)
  console.log(`wrote ${path}`)
  return report
}

if (import.meta.main) {
  const r = await run(process.argv.slice(2))
  process.exitCode = r.summary.pass ? 0 : 1
}
