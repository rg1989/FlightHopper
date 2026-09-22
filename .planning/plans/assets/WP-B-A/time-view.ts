// .planning/plans/assets/WP-B-A/time-view.ts
// Gate GB: times GET /api/view on a running server over loopback, which is the server time (request to the last gzipped
// byte) plus well under a millisecond: 15 full replies (since=0), then 15 incremental ones a second apart (a client one
// poll behind). Run from the repository root while the server replays the heavy file:
//   node .planning/plans/assets/WP-B-A/time-view.ts [base] [lat] [lon] [nm]
// Defaults: http://127.0.0.1:8787, the heavy replay's centre (LOWI) and the 250 nm browse cap.
import { request } from 'node:http'
import { gunzipSync } from 'node:zlib'

const [base = 'http://127.0.0.1:8787', lat = '47.26', lon = '11.34', nm = '250'] = process.argv.slice(2)
const url = `${base}/api/view?lat=${lat}&lon=${lon}&nm=${nm}`

interface Reply {
  ms: number
  gzBytes: number
  samples: { rxMs: number }[]
  info: unknown[]
}

function get(u: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    request(u, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => {
        const ms = performance.now() - t0
        const buf = Buffer.concat(parts)
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${buf.toString().slice(0, 200)}`))
        const body = JSON.parse((res.headers['content-encoding'] === 'gzip' ? gunzipSync(buf) : buf).toString())
        resolve({ ms, gzBytes: buf.length, samples: body.samples, info: body.info ?? [] })
      })
    }).on('error', reject).end()
  })
}

const pct = (xs: number[], p: number): number => xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]
const line = (xs: number[]): string => `median ${pct(xs, 0.5).toFixed(1)} ms, p90 ${pct(xs, 0.9).toFixed(1)} ms, max ${Math.max(...xs).toFixed(1)} ms`

const full: number[] = []
let last: Reply | null = null
for (let i = 0; i < 15; i++) {
  last = await get(`${url}&since=0`)
  full.push(last.ms)
}
console.log(`since=0: ${last!.samples.length} samples, ${last!.info.length} info, ${last!.gzBytes} B gzipped; ${line(full)}`)

let since = 0
for (const s of last!.samples) if (s.rxMs > since) since = s.rxMs
const inc: number[] = []
let n = 0
let bytes = 0
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const r = await get(`${url}&since=${since}`)
  inc.push(r.ms)
  n += r.samples.length
  bytes += r.gzBytes
  for (const s of r.samples) if (s.rxMs > since) since = s.rxMs
}
console.log(`incremental (1 Hz): ${Math.round(n / inc.length)} samples, ${Math.round(bytes / inc.length)} B per reply; ${line(inc)}`)
