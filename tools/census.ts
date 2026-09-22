// tools/census.ts
// G2 coverage census: can this airport be a landing hero (≥ 80 % of arrivals tracked below 200 ft AGL)?
//
//   node tools/census.ts --recordings 'data/recordings/*.jsonl' --airports public/airports/heroes.json --airport LLBG [--out .planning/reports]
//
// Same inputs as tools/datum-check.ts. Writes <out>/census-<ICAO>-<YYYY-MM-DD>.json; exit code 1 = not a landing hero.
import { RADIUS_NM, findArrivals, summarizeCensus } from './analysis/census.ts'
import { loadInputs, round1, writeReport } from './datum-check.ts'

export async function run(argv: string[]) {
  const { airport, files, samples, out } = await loadInputs(argv)
  const arrivals = findArrivals(samples, airport)
  const summary = summarizeCensus(arrivals)
  const report = {
    airport: airport.ident,
    generatedAt: new Date().toISOString(),
    files,
    samplesNearAirport: samples.length,
    summary,
    arrivalsWithJumps: arrivals.filter((a) => a.jumps > 0).length,
    arrivals,
  }
  const path = writeReport(out, `census-${airport.ident}`, report)
  console.log(`Census ${airport.ident}: ${samples.length} samples within ${RADIUS_NM} nm, ${files.length} file(s)`)
  console.table([
    {
      arrivals: summary.arrivals,
      'tracked <200 ft %': round1(summary.trackedBelow200Pct),
      'p90 gap <1000 ft s': round1(summary.p90GapBelow1000S),
      'alt_geom %': round1(summary.geomSharePct),
      'nic<6 %': round1(summary.badNicPct),
      'with jumps': report.arrivalsWithJumps,
      'landing hero': summary.landingHeroOk,
    },
  ])
  if (summary.arrivals < 10) console.log('fewer than 10 arrivals: treat the verdict as indicative only')
  console.log(`wrote ${path}`)
  return report
}

if (import.meta.main) {
  const r = await run(process.argv.slice(2))
  process.exitCode = r.summary.landingHeroOk ? 0 : 1
}
