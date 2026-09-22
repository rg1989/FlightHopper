// tools/fake-readsb.ts
// Stand-in for your own receiver: serves a recording through readsb's --net-api-port query API, so
// ADSB_SOURCE=readsb can be developed and flip-tested before the receiver exists.
//
//   node tools/fake-readsb.ts --files 'data/fixtures/*.jsonl' --port 8042 [--speed 1] [--loop]
//   curl 'http://127.0.0.1:8042/?circle=37.6188,-122.3758,40'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseArgs } from 'node:util'
import { makeReplay } from '../server/sources/replay.ts'
import type { FetchResult, Source } from '../server/sources/types.ts'

/** The three readsb API queries the server uses; null for anything else. */
function route(src: Source, q: URLSearchParams): Promise<FetchResult> | null {
  const circle = q.get('circle')
  if (circle !== null) {
    const p = circle.split(',').map(Number)
    return p.length === 3 && p.every(Number.isFinite) ? src.circle(p[0], p[1], p[2]) : null
  }
  const hexes = q.get('find_hex')
  if (hexes !== null) return src.hexes(hexes.split(',').filter((h) => h !== ''))
  if (q.has('all_with_pos')) return src.all()
  return null
}

/**
 * Serves `files` (paths or globs) as readsb does on --net-api-port: /?circle=lat,lon,nm, /?find_hex=h1,h2,
 * /?all_with_pos, in the envelope { now (s), resultCount, ptime (ms), aircraft }. Listens on 127.0.0.1;
 * port 0 picks a free port. The replay clock starts now; speed 0 freezes it at the first poll.
 */
export async function startFakeReadsb(opts: {
  files: string[]
  port: number
  speed?: number
  loop?: boolean
}): Promise<{ url: string; close(): Promise<void> }> {
  const src = makeReplay({ files: opts.files, speed: opts.speed, loop: opts.loop })
  const server = createServer(async (req, res) => {
    const t0 = performance.now()
    const pending = route(src, new URL(req.url ?? '/', 'http://fake').searchParams)
    if (pending === null) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('expected ?circle=lat,lon,nm | ?find_hex=h1,h2 | ?all_with_pos\n')
      return
    }
    const { nowMs, aircraft } = (await pending).snapshot!
    const ptime = Math.round((performance.now() - t0) * 1000) / 1000
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ now: nowMs / 1000, resultCount: aircraft.length, ptime, aircraft }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()))
        server.closeAllConnections() // keep-alive clients would otherwise hold close() open
      }),
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      files: { type: 'string', multiple: true },
      port: { type: 'string', default: '8042' },
      speed: { type: 'string', default: '1' },
      loop: { type: 'boolean', default: false },
    },
  })
  // An unquoted `--files data/*.jsonl` arrives shell-expanded: the first file as --files, the rest as positionals.
  const files = [...(values.files ?? []), ...positionals]
  if (files.length === 0) throw new Error('usage: node tools/fake-readsb.ts --files <glob or paths> [--port 8042] [--speed 1] [--loop]')
  const { url } = await startFakeReadsb({ files, port: Number(values.port), speed: Number(values.speed), loop: values.loop })
  console.log(`fake readsb on ${url} (try ${url}/?all_with_pos)`)
}

if (import.meta.main) await main()
