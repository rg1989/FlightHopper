// tools/gate-g1.ts
// Gate G1 (PLAN.md §6): proves the running server kept to the upstream budget. It polls GET {base}/api/status
// every 10 s for --minutes, then scores the first/last reports and writes .planning/reports/G1-<YYYY-MM-DD>.json.
//
//   node tools/gate-g1.ts --base http://127.0.0.1:8787 --minutes 60 [--out .planning/reports]
//
// Exit code 0 = pass, 1 = fail.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { StatusReport } from '../shared/api.ts'

export interface G1Check {
  name: string
  value: number
  threshold: number
  pass: boolean
}

const BURST = 2 // server/budget.ts TokenBucket burst: a saturated bucket may exceed rate·T by this many requests

const fourxx = (r: StatusReport): number => r.budget.counts.r429 + r.budget.counts.r4xx

/** Largest non-null value; NaN when there is none (NaN never passes a check). */
function maxOf(xs: (number | null)[]): number {
  const v = xs.filter((x): x is number => x !== null)
  return v.length > 0 ? Math.max(...v) : NaN
}

/**
 * Scores status reports taken in order over `seconds` of wall time (first → last report).
 * Checks: no 429/4xx during the window; worst cell period p95 ≤ 3.5 s (scaled to 7 s at MAX_RPS 0.5);
 * worst chase period p95 ≤ 1.5 s; average upstream rate ≤ maxRps (+ one burst); bytes/hour reported.
 */
export function evaluateG1(reports: StatusReport[], seconds: number): { pass: boolean; checks: G1Check[] } {
  if (reports.length < 2 || !(seconds > 0)) throw new Error('evaluateG1 needs at least 2 reports over a positive number of seconds')
  const first = reports[0]
  const last = reports[reports.length - 1]
  const maxRps = last.budget.maxRps
  const check = (name: string, value: number, threshold: number): G1Check => ({ name, value, threshold, pass: value <= threshold })
  const checks = [
    check('upstream4xx', fourxx(last) - fourxx(first), 0),
    check('cellPeriodP95S', maxOf(reports.flatMap((r) => r.cells.map((c) => c.periodP95S))), 3.5 / Math.min(1, maxRps)),
    check('chasePeriodP95S', maxOf(reports.map((r) => r.chasePeriodP95S)), 1.5),
    check('avgUpstreamRps', (last.requestsTotal - first.requestsTotal) / seconds, maxRps + BURST / seconds),
    check('bytesPerHourEstimate', last.bytesPerHourEstimate, Infinity),
  ]
  return { pass: checks.every((c) => c.pass), checks }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://127.0.0.1:8787' },
      minutes: { type: 'string', default: '60' },
      out: { type: 'string', default: '.planning/reports' },
      'interval-ms': { type: 'string', default: '10000' }, // hidden: tests poll faster
    },
  })
  const minutes = Number(values.minutes)
  const intervalMs = Number(values['interval-ms'])
  if (!(minutes > 0) || !(intervalMs > 0)) throw new Error('--minutes and --interval-ms must be positive numbers')
  const endMs = Date.now() + minutes * 60_000
  const reports: StatusReport[] = []
  let firstMs = 0
  let lastMs = 0
  let extraPolls = 0
  for (;;) {
    try {
      const res = await fetch(`${values.base}/api/status`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      reports.push((await res.json()) as StatusReport)
      lastMs = Date.now()
      if (reports.length === 1) firstMs = lastMs
    } catch (e) {
      console.error(`${new Date().toISOString()} status poll failed: ${(e as Error).message}`)
    }
    const leftMs = endMs - Date.now()
    // A slow first answer (cold start, loaded machine) must not end the run with one report:
    // past the end, keep polling until there are two, but give up after 3 more tries.
    if (leftMs <= 0 && (reports.length >= 2 || ++extraPolls > 3)) break
    await new Promise((r) => setTimeout(r, leftMs > 0 ? Math.min(intervalMs, leftMs) : intervalMs))
  }

  const seconds = (lastMs - firstMs) / 1000
  const result = evaluateG1(reports, seconds)
  const now = new Date()
  mkdirSync(values.out, { recursive: true })
  const path = join(values.out, `G1-${now.toISOString().slice(0, 10)}.json`)
  // JSON has no Infinity/NaN: the bytes threshold (Infinity) and a missing metric (NaN) are written as null.
  const report = { gate: 'G1', date: now.toISOString(), base: values.base, seconds, reports: reports.length, ...result, last: reports[reports.length - 1] }
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n')
  for (const c of result.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name} = ${c.value} (≤ ${c.threshold})`)
  console.log(`G1 ${result.pass ? 'PASS' : 'FAIL'} → ${path}`)
  process.exitCode = result.pass ? 0 : 1
}

if (import.meta.main) await main()
