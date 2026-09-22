// Early fixture collector: polls a small circle around each hero airport on adsb.lol, round-robin,
// and appends every raw response to data/recordings/YYYY-MM-DD.jsonl in the RecordLine format.
// ponytail: standalone on purpose so recording starts on day 1; tools/record-arrivals.ts replaces it after M1b.
//
//   CONTACT=you@example.com node tools/record-cells.ts [--interval-ms 2000] [--radius-nm 40] [--heroes KSFO,LLBG,LOWI]
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { RecordLine } from '../server/recording.ts'

export const HEROES: Record<string, { lat: number; lon: number }> = {
  KSFO: { lat: 37.6188, lon: -122.3758 },
  LLBG: { lat: 32.0114, lon: 34.8867 },
  LOWI: { lat: 47.2602, lon: 11.3439 },
}

const MIN_INTERVAL_MS = 1000 // never faster than 1 req/s total
const MAX_INTERVAL_MS = 5 * 60_000

/** Next request interval after a response. 'stop' on 401/403: never retry a block. */
export function nextInterval(currentMs: number, baseMs: number, status: number, retryAfterS: number | null): number | 'stop' {
  if (status === 401 || status === 403) return 'stop'
  if (status === 429) return Math.min(MAX_INTERVAL_MS, Math.max(currentMs * 2, (retryAfterS ?? 30) * 1000))
  if (status === 0 || status >= 500) return Math.min(MAX_INTERVAL_MS, currentMs * 2)
  // success: recover 10 % per request toward the base interval
  return Math.max(baseMs, Math.max(MIN_INTERVAL_MS, Math.round(currentMs * 0.9)))
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'interval-ms': { type: 'string', default: '2000' },
      'radius-nm': { type: 'string', default: '40' },
      heroes: { type: 'string', default: 'KSFO,LLBG,LOWI' },
      out: { type: 'string', default: 'data/recordings' },
    },
  })
  const contact = process.env.CONTACT
  if (!contact) throw new Error('Set CONTACT (e.g. in .env.local); it goes into the User-Agent.')
  const baseMs = Math.max(MIN_INTERVAL_MS, Number(values['interval-ms']))
  const radius = Number(values['radius-nm'])
  const heroes = values.heroes.split(',').map((id) => ({ id, ...HEROES[id] }))
  if (heroes.some((h) => h.lat === undefined)) throw new Error(`unknown hero in ${values.heroes}`)
  mkdirSync(values.out, { recursive: true })

  let interval = baseMs
  for (let i = 0; ; i++) {
    const h = heroes[i % heroes.length]
    const url = `https://api.adsb.lol/v2/point/${h.lat}/${h.lon}/${radius}`
    const tSendMs = Date.now()
    let status = 0
    let body = ''
    let bytes = 0
    let retryAfterS: number | null = null
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': `FlightHopper/0.1 (+${contact})`, 'Accept-Encoding': 'gzip' },
        signal: AbortSignal.timeout(10_000),
      })
      status = res.status
      body = await res.text()
      bytes = Number(res.headers.get('content-length') ?? Buffer.byteLength(body))
      const ra = res.headers.get('retry-after')
      retryAfterS = ra !== null && Number.isFinite(Number(ra)) ? Number(ra) : null
    } catch {
      status = 0
    }
    const line: RecordLine = { v: 1, source: 'adsblol', url, status, tSendMs, tRecvMs: Date.now(), bytes, body: status === 200 ? body : '' }
    appendFileSync(join(values.out, `${new Date(tSendMs).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(line) + '\n')
    const next = nextInterval(interval, baseMs, status, retryAfterS)
    if (next === 'stop') {
      console.error(`HTTP ${status} from ${url}: blocked. Stopping; do not retry automatically.`)
      process.exit(1)
    }
    if (status !== 200) console.error(`${new Date().toISOString()} HTTP ${status} ${h.id}; next in ${next} ms`)
    interval = next
    await new Promise((r) => setTimeout(r, interval))
  }
}

if (import.meta.main) await main()
