// server/main.ts
// The FlightHopper server: one Source → Poller → SampleStore + InfoStore, served as plain HTTP polling, plus the built client.
//   npm run server                      (settings: .env.local, see .env.example)
//   GET /api/view?lat&lon&nm&since      samples in a circle received after `since` (server-clock rxMs), + the info the client lacks
//   GET /api/chase?hex&since            one aircraft's samples received after `since`, + its newest full object and info
//   GET /api/status                     the poller's StatusReport
//   GET /*                              dist/ (index.html for client routes)
// JSON over 1 KB is gzipped when the client accepts it. ADSB_SOURCE=adsblol with ROUTES=1 also looks up flight routes.
import { readFile, stat } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { ChaseResponse, ViewResponse } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import type { AircraftInfo } from '../shared/info.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { TokenBucket } from './budget.ts'
import { readServerConfig, type ServerConfig } from './config.ts'
import { InfoStore } from './infoStore.ts'
import { POLLER_DEFAULTS, Poller } from './poller.ts'
import { Recorder } from './recorder.ts'
import { RouteFetcher } from './routes.ts'
import { makeSource, userAgent } from './sources/index.ts'
import type { Source } from './sources/types.ts'
import { SampleStore } from './store.ts'

// ponytail: loopback only. Cloudflare Tunnel and the Vite dev proxy both connect locally, but other machines on the
// LAN cannot. Add a HOST variable when one needs to.
const HOST = '127.0.0.1'
// ponytail: an area source (adsb.lol) polls the cells of at most a 250 nm view; a wider view still gets whatever the
// store holds. Full-snapshot sources have no cells, so the cap costs them nothing.
const MAX_POLLED_NM = 250
const LOW_BUDGET_RPS = 0.5 // below this an area source polls one circle per view, not the cell cover (Poller singleCircle)
const HEX = /^~?[0-9a-f]{6}$/
const GZIP_MIN_BYTES = 1024
// Fastest level: a 5,000-aircraft view (2.7 MB of JSON) → ~430 KB in ~10 ms; level 6 saves 20 % more bytes for 2.4× the time.
const GZIP_LEVEL = 1
// An aircraft silent this long may have been dropped by the client (its Fleet prunes old entries): send its info again.
const INFO_RESEND_GAP_MS = 60_000
const ROUTE_TICK_MS = 100 // RouteFetcher.tick itself keeps ≥ 60 s between requests
const gzipAsync = promisify(gzip)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

class BadRequest extends Error {}

/** A finite number from the query string; `def` when missing or empty, else 400. */
function num(q: URLSearchParams, name: string, def?: number): number {
  const raw = q.get(name)?.trim() ?? ''
  if (raw === '' && def !== undefined) return def
  const v = raw === '' ? NaN : Number(raw)
  if (!Number.isFinite(v)) throw new BadRequest(`${name} must be a number, got "${raw}"`)
  return v
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new BadRequest(message)
}

/** Whether Accept-Encoding lists gzip with a non-zero q. ponytail: `*` is not read as gzip. */
function acceptsGzip(header: string | undefined): boolean {
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.split(';').map((x) => x.trim().toLowerCase())
    if (name !== 'gzip') continue
    const q = params.find((p) => p.startsWith('q='))
    return q === undefined || Number(q.slice(2)) > 0
  }
  return false
}

/** JSON, gzipped off the event loop (zlib's thread pool) when it is over 1 KB and the client accepts gzip. */
async function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): Promise<void> {
  const text = JSON.stringify(body)
  const bytes = Buffer.byteLength(text)
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'accept-encoding' }
  if (bytes > GZIP_MIN_BYTES && acceptsGzip(req.headers['accept-encoding'])) {
    const gz = await gzipAsync(text, { level: GZIP_LEVEL })
    res.writeHead(status, { ...headers, 'content-encoding': 'gzip', 'content-length': gz.length }).end(gz)
    return
  }
  res.writeHead(status, { ...headers, 'content-length': bytes }).end(text)
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) }).end(text)
}

const isFile = (p: string): Promise<boolean> => stat(p).then((s) => s.isFile(), () => false)

/**
 * A file under root: the path itself, index.html for client routes (no extension), else 404.
 * Anything that decodes to a path outside root (%2e%2e, %2f, %5c, NUL) is a 404 before the disk is touched.
 * ponytail: no caching headers, ETags or compression. Every page load re-sends Cesium's assets; put the Cloudflare
 * cache in front, or add `cache-control: immutable` for Vite's hashed /assets/, when that matters.
 */
async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    return sendText(res, 404, 'not found\n')
  }
  const abs = resolve(root, `.${path}`)
  if (path.includes('\0') || (abs !== root && !abs.startsWith(root + sep))) return sendText(res, 404, 'not found\n')
  let file = abs
  if (!(await isFile(file))) {
    if (extname(path) !== '') return sendText(res, 404, 'not found\n')
    file = join(root, 'index.html')
    if (!(await isFile(file))) return sendText(res, 404, 'the client is not built: run npm run build\n')
  }
  const body = await readFile(file)
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': body.length }).end(body)
}

/**
 * Wires one Source (cfg, or deps.source) to a Poller, a SampleStore, an InfoStore and an HTTP server.
 * deps.nowMs is the server clock for the poller and the budget; it must be the clock the source stamps tRecvMs with
 * (Date.now for live sources, the same injected clock for a replay built with it).
 * deps.routesFetch replaces fetch for the route lookups (tests); routes run only with ADSB_SOURCE=adsblol and ROUTES=1.
 */
export function createServer(
  cfg: ServerConfig,
  deps: { source?: Source; nowMs?: () => number; routesFetch?: typeof fetch } = {},
): { listen(port: number): Promise<string>; close(): Promise<void>; poller: Poller; info: InfoStore } {
  const nowMs = deps.nowMs ?? Date.now
  const source = deps.source ?? makeSource(cfg)
  const store = new SampleStore()
  const info = new InfoStore({ nowMs })
  const rps = Math.min(cfg.maxRps, source.caps.maxRps)
  const bucket = new TokenBucket(rps, nowMs)
  const recorder = cfg.recordDir !== null && source.caps.kind !== 'replay' ? new Recorder(cfg.recordDir) : null
  // The poller prunes the sample store (180 s horizon) on every 100 ms tick and the info store on every good answer,
  // so no separate prune timer is needed.
  const poller = new Poller(source, store, bucket, { ...POLLER_DEFAULTS, singleCircle: rps < LOW_BUDGET_RPS, recorder, hideFlagged: !cfg.showPiaLadd, nowMs, info })
  const routes =
    cfg.routes && cfg.source === 'adsblol' && cfg.contact !== null
      ? new RouteFetcher({ bucket, userAgent: userAgent(cfg.contact), nowMs, fetchFn: deps.routesFetch })
      : null
  let routeTimer: ReturnType<typeof setInterval> | null = null
  const root = resolve(cfg.staticDir)

  /**
   * The AircraftInfo this client lacks for the aircraft in a view answer. since = 0: all of them. Otherwise an
   * aircraft's info goes out when it is new to the client (no stored sample at or before `since` inside the circle),
   * when it was silent for ≥ 60 s (the client may have dropped it), or when it changed after the client's last sample
   * of it. (Plain "changed after since" would lose aircraft that fly into a fixed view, and route answers that land
   * between two of an aircraft's samples.)
   */
  function viewInfo(samples: readonly Sample[], lat: number, lon: number, nm: number, since: number): AircraftInfo[] {
    const hexes = new Set<string>()
    for (const s of samples) hexes.add(s.hex)
    if (since <= 0) return info.since(hexes, 0)
    const out: AircraftInfo[] = []
    for (const hex of hexes) {
      const i = info.get(hex)
      const changedMs = info.changedMs(hex)
      if (i === null || changedMs === null) continue
      // Samples of the last gap before `since` are enough: an older previous sample means a gap ≥ 60 s anyway.
      const list = store.track(hex, since - INFO_RESEND_GAP_MS)
      let k = list.length - 1
      while (k >= 0 && list[k].rxMs > since) k--
      const prev = k >= 0 ? list[k] : null
      const lacks =
        prev === null || // new to the store, or silent for longer than the gap
        changedMs > prev.rxMs || // changed after the client's last sample of it
        list[k + 1].rxMs - prev.rxMs >= INFO_RESEND_GAP_MS || // silent: the client may have dropped it
        distanceNm(lat, lon, prev.lat, prev.lon) > nm // flew into the circle
      if (lacks) out.push(i)
    }
    return out
  }

  /** The newest full upstream object with its ages (seen, seen_pos) counted to `now` instead of to its receipt. */
  function rawAt(hex: string, now: number): ReadsbAircraft | null {
    const raw = info.raw(hex)
    const rxMs = info.rxMs(hex)
    if (raw === null || rxMs === null) return null
    const dtS = Math.max(0, now - rxMs) / 1000
    const age = (s: number | undefined): number | undefined => (s === undefined ? s : Math.round((s + dtS) * 1000) / 1000)
    return { ...raw, seen: age(raw.seen), seen_pos: age(raw.seen_pos) }
  }

  function view(q: URLSearchParams): ViewResponse {
    const lat = num(q, 'lat')
    const lon = num(q, 'lon')
    const nm = num(q, 'nm')
    const since = num(q, 'since', 0)
    check(Math.abs(lat) <= 90, 'lat must be in [-90, 90]')
    check(Math.abs(lon) <= 180, 'lon must be in [-180, 180]')
    check(nm > 0, 'nm must be > 0')
    check(since >= 0, 'since must be ≥ 0')
    poller.touchView(lat, lon, Math.min(nm, MAX_POLLED_NM))
    const samples = store.view(lat, lon, nm, since)
    return { serverNowMs: nowMs(), samples, status: poller.brief(), info: viewInfo(samples, lat, lon, nm, since) }
  }

  function chase(q: URLSearchParams): ChaseResponse {
    const hex = (q.get('hex') ?? '').trim().toLowerCase()
    const since = num(q, 'since', 0)
    check(HEX.test(hex), 'hex must be 6 hex digits (optionally prefixed with ~)')
    check(since >= 0, 'since must be ≥ 0')
    poller.touchChase(hex)
    const now = nowMs()
    return { serverNowMs: now, samples: store.track(hex, since), status: poller.brief(), raw: rawAt(hex, now), info: info.get(hex) }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/')
    if (req.method !== 'GET') {
      if (isApi) return sendJson(req, res, 405, { error: 'only GET' })
      return sendText(res, 405, 'only GET\n')
    }
    if (!isApi) return serveStatic(root, url.pathname, res)
    let status = 200
    let body: unknown
    try {
      if (url.pathname === '/api/view') body = view(url.searchParams)
      else if (url.pathname === '/api/chase') body = chase(url.searchParams)
      else if (url.pathname === '/api/status') body = poller.report()
      else [status, body] = [404, { error: `no such endpoint: ${url.pathname}` }]
    } catch (e) {
      if (!(e instanceof BadRequest)) throw e
      ;[status, body] = [400, { error: e.message }]
    }
    return sendJson(req, res, status, body)
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error('server: request failed:', e)
      if (res.headersSent) res.destroy()
      else void sendJson(req, res, 500, { error: 'internal error' }) // under 1 KB: never gzipped, cannot reject
    })
  })

  return {
    poller,
    info,
    listen(port: number): Promise<string> {
      return new Promise((done, fail) => {
        server.once('error', fail)
        server.listen(port, HOST, () => {
          server.off('error', fail)
          if (routes !== null && routeTimer === null) {
            // Armed just before the poller's 100 ms timer: Node keeps same-period timers in one list and re-arms them
            // in firing order, so this one keeps firing first. A due route request (≤ 1 a minute) then gets the next
            // token instead of losing every race to a cell poll, which at MAX_RPS 0.08 wants every token.
            routeTimer = setInterval(() => {
              routes.tick(info).catch((e: unknown) => console.error('routes: tick failed:', e))
            }, ROUTE_TICK_MS)
            routeTimer.unref()
          }
          poller.start()
          done(`http://${HOST}:${(server.address() as AddressInfo).port}`)
        })
      })
    },
    close(): Promise<void> {
      if (routeTimer !== null) clearInterval(routeTimer)
      routeTimer = null
      poller.stop()
      if (!server.listening) return Promise.resolve()
      return new Promise((done, fail) => {
        server.close((e) => (e ? fail(e) : done()))
        server.closeAllConnections() // keep-alive clients would otherwise hold close() open
      })
    },
  }
}

if (import.meta.main) {
  try {
    const cfg = readServerConfig(process.env)
    const url = await createServer(cfg).listen(cfg.port)
    const routes = cfg.routes && cfg.source === 'adsblol' ? ', routes on' : ''
    console.log(`FlightHopper server on ${url} (source ${cfg.source}${routes})`)
  } catch (e) {
    console.error(`server: ${(e as Error).message}`)
    process.exit(1)
  }
}
