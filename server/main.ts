// server/main.ts
// The FlightHopper server: one Source → Poller → SampleStore + InfoStore, served as plain HTTP polling, plus the built client.
//   npm run server                      (settings: .env.local, see .env.example)
//   GET /api/view?lat&lon&nm&since      samples in a circle received after `since` (server-clock rxMs), + the info the client lacks
//   GET /api/chase?hex&since            one aircraft's samples received after `since`, + its newest full object and info
//   GET /api/status                     the poller's StatusReport
//   GET /api/record                     the flights being recorded (FLIGHTS_DIR set; else 404)
//   POST /api/record?hex&on=1|0         start or stop recording one aircraft → RecordResponse
//   GET /api/recordings                 every recorded flight, newest first; /api/recordings/track?file= one of them
//   POST /api/recordings/rename?file&name, POST /api/recordings/delete?file   name one (blank clears), delete one for good
//   GET /api/wx/metar?bbox=s,w,n,e      METARs in the box (whole degrees, ≤ 40° a side); GET /api/wx/sigmet: SIGMETs (wx.ts)
//   GET /api/history?slot&lat&lon&nm    one past UTC half hour in a circle (adsb.lol's heatmap file: historyStore.ts). 404: adsb.lol
//                                       has none (or it is older than 31 days); 503 + Retry-After: 15: it cannot be had now
//   GET /api/history/status             the half hours held, being fetched or missing, and the newest published
//   GET /api/trace?hex&at               an aircraft's flight leg flying at `at` (default now; adsb.lol's trace: trace.ts), 404: none
//   GET /*                              dist/ (index.html for client routes)
// JSON over 1 KB is gzipped when the client accepts it. ADSB_SOURCE=adsblol with ROUTES=1 also looks up flight routes;
// any other live source with a CONTACT looks up only the routes of the aircraft selected or recorded (adsbdb.com).
// The command line also keeps the newest hour of the past in memory for a live source (two heatmap files, refreshed each
// half hour: rollHistory). A server made in code, a test's included, fetches the past only when it is asked.
import { readFile, stat } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { ChaseResponse, RecordingInfo, RecordResponse, StatusBrief, ViewResponse } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import { EVERYTHING_NM, SLOT_MS } from '../shared/history.ts'
import type { AircraftInfo } from '../shared/info.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { TokenBucket } from './budget.ts'
import { readServerConfig, type ServerConfig } from './config.ts'
import { AdsbdbRoutes } from './adsbdb.ts'
import { FlightLog } from './flightLog.ts'
import { HistoryStore } from './historyStore.ts'
import { InfoStore } from './infoStore.ts'
import { POLLER_DEFAULTS, Poller } from './poller.ts'
import { Recorder } from './recorder.ts'
import { RouteFetcher } from './routes.ts'
import { makeSource, userAgent } from './sources/index.ts'
import type { Source } from './sources/types.ts'
import { SampleStore } from './store.ts'
import { TraceStore } from './trace.ts'
import { WxError, makeWx } from './wx.ts'

// ponytail: loopback only. Cloudflare Tunnel and the Vite dev proxy both connect locally, but other machines on the
// LAN cannot. Add a HOST variable when one needs to.
const HOST = '127.0.0.1'
const LOW_BUDGET_RPS = 0.5 // below this an area source polls one circle per view, however wide (Poller singleCircle)
const HEX = /^~?[0-9a-f]{6}$/
const GZIP_MIN_BYTES = 1024
// Fastest level: a 5,000-aircraft view (2.7 MB of JSON) → ~430 KB in ~10 ms; level 6 saves 20 % more bytes for 2.4× the time.
const GZIP_LEVEL = 1
// An aircraft silent this long may have been dropped by the client (its Fleet prunes old entries): send its info again.
const INFO_RESEND_GAP_MS = 60_000
const ROUTE_TICK_MS = 100 // RouteFetcher.tick itself keeps ≥ 60 s between requests
// Selected-only route lookups (adsbdb.com, one callsign a request): asked when a flight is selected, so at most one
// request per 5 s and ≤ 1 a minute sustained (burst 3).
const SELECTED_ROUTE_GAP_MS = 5000
const SELECTED_ROUTE_RPS = 1 / 60
const FLIGHT_LOG_TICK_MS = 5000
const HISTORY_TICK_MS = 60_000 // the rolling fetch of the newest half hours: a new file appears every 30 min
// Half-hour files held in memory (13-28 MB each): the newest two (rolling), and a replay's previous, current and next.
const HISTORY_SLOTS = 5
const RETRY_AFTER_S = 15 // what a 503 tells the client: the past could not be had now, try again then
const ORIGIN_MAX_AGE_MS = 10 * 60_000 // a leg that ended longer ago than this is not the flight in the air now
const gzipAsync = promisify(gzip)
const POSTS = new Set(['/api/record', '/api/recordings/rename', '/api/recordings/delete']) // the only writes

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
  '.csv': 'text/csv; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.vtt': 'text/vtt; charset=utf-8',
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
async function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): Promise<void> {
  const text = JSON.stringify(body)
  const bytes = Buffer.byteLength(text)
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'accept-encoding', ...extra }
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
 * A single `Range: bytes=a-b | a- | -n` header resolved against a `size`-byte file.
 * null: no Range header, or one this parser doesn't handle as a single range (including a comma-separated list of
 * several ranges) — served as the whole file. 'unsatisfiable': the range fits nowhere in the file (→ 416).
 */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const n = Number(m[2]) // suffix range: the last n bytes
    if (!(n > 0)) return 'unsatisfiable'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start < 0 || start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/**
 * A file under root: the path itself, index.html for client routes (no extension), else 404. Honours a `Range`
 * request (206, one range only — a list of several serves the whole file, matching how few clients ask for one and
 * how rarely servers bother splitting the reply). Every response, ranged or not, advertises `accept-ranges: bytes`.
 * Anything that decodes to a path outside root (%2e%2e, %2f, %5c, NUL) is a 404 before the disk is touched.
 * ponytail: no caching headers, ETags or compression, and a ranged read still loads the whole file into memory
 * first — fine for scenario audio clips (tens of MB); swap for a streamed partial read if that grows much further.
 */
async function serveStatic(root: string, pathname: string, range: string | undefined, res: ServerResponse): Promise<void> {
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
  const type = TYPES[extname(file)] ?? 'application/octet-stream'
  const r = parseRange(range, body.length)
  if (r === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${body.length}`, 'accept-ranges': 'bytes' }).end()
    return
  }
  if (r === null) {
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'accept-ranges': 'bytes' }).end(body)
    return
  }
  const slice = body.subarray(r.start, r.end + 1)
  res
    .writeHead(206, {
      'content-type': type,
      'content-length': slice.length,
      'content-range': `bytes ${r.start}-${r.end}/${body.length}`,
      'accept-ranges': 'bytes',
    })
    .end(slice)
}

/**
 * Wires one Source (cfg, or deps.source) to a Poller, a SampleStore, an InfoStore and an HTTP server.
 * deps.nowMs is the server clock for the poller and the budget; it must be the clock the source stamps tRecvMs with
 * (Date.now for live sources, the same injected clock for a replay built with it).
 * deps.routesFetch replaces fetch for the route lookups (tests); routes run only with ADSB_SOURCE=adsblol and ROUTES=1.
 * deps.historyFetch replaces fetch for the past (adsb.lol's heatmap and trace files; tests). deps.rollHistory (default false)
 * keeps the newest two half hours of the past fetched while the server listens: the command line sets it for a live source.
 * Off, the past is fetched only when a client asks, so a test server on a live source asks adsb.lol for nothing by itself.
 */
export function createServer(
  cfg: ServerConfig,
  deps: { source?: Source; nowMs?: () => number; routesFetch?: typeof fetch; wxFetch?: typeof fetch; historyFetch?: typeof fetch; rollHistory?: boolean } = {},
): { listen(port: number): Promise<string>; close(): Promise<void>; poller: Poller; info: InfoStore } {
  const nowMs = deps.nowMs ?? Date.now
  const source = deps.source ?? makeSource(cfg)
  const store = new SampleStore()
  const info = new InfoStore({ nowMs })
  const rps = Math.min(cfg.maxRps, source.caps.maxRps)
  const bucket = new TokenBucket(rps, nowMs, Math.random, source.caps.burst)
  const recorder = cfg.recordDir !== null && source.caps.kind !== 'replay' ? new Recorder(cfg.recordDir) : null
  const flights = cfg.flightsDir === null ? null : new FlightLog({ dir: cfg.flightsDir, source: source.caps.kind, nowMs })
  // The poller prunes the sample store (180 s of track, 35 min for each newest sample) on every 100 ms tick and the info store on every good answer,
  // so no separate prune timer is needed.
  const poller = new Poller(source, store, bucket, {
    ...POLLER_DEFAULTS,
    singleCircle: rps < LOW_BUDGET_RPS,
    recorder,
    hideFlagged: !cfg.showPiaLadd,
    nowMs,
    info,
    onSample: flights === null ? undefined : (s) => flights.add(s),
    watched: flights === null ? undefined : () => flights.hexes(),
  })
  // All routes (adsb.lol, sharing its bucket), or only the selected and recorded aircraft's (own slow bucket).
  const allRoutes = cfg.routes && cfg.source === 'adsblol'
  const routes =
    cfg.contact === null || source.caps.kind === 'replay'
      ? null
      : allRoutes
        ? new RouteFetcher({ bucket, userAgent: userAgent(cfg.contact), nowMs, fetchFn: deps.routesFetch })
        : new AdsbdbRoutes({
            bucket: new TokenBucket(SELECTED_ROUTE_RPS, nowMs, Math.random, 3),
            userAgent: userAgent(cfg.contact),
            nowMs,
            fetchFn: deps.routesFetch,
            minIntervalMs: SELECTED_ROUTE_GAP_MS,
          })
  const routesFor = (): ReadonlySet<string> | undefined => (allRoutes ? undefined : new Set([...poller.chasedHexes(), ...(flights?.hexes() ?? [])]))
  let flightTimer: ReturnType<typeof setInterval> | null = null
  let routeTimer: ReturnType<typeof setInterval> | null = null
  const root = resolve(cfg.staticDir)
  const wx = makeWx({ userAgent: userAgent(cfg.contact ?? 'personal use'), fetchFn: deps.wxFetch })
  // The past (History mode, the flown path): adsb.lol's files, fetched when asked and held in memory only.
  const pastUa = userAgent(cfg.contact ?? 'personal use')
  const history = new HistoryStore({ userAgent: pastUa, fetchFn: deps.historyFetch, nowMs, maxSlots: HISTORY_SLOTS })
  const traces = new TraceStore({ userAgent: pastUa, fetchFn: deps.historyFetch, nowMs })
  let historyTimer: ReturnType<typeof setInterval> | null = null

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

  /** The poller's brief, with the flights being recorded. */
  function brief(): StatusBrief {
    const b = poller.brief()
    const rec = flights?.active() ?? []
    if (rec.length > 0) b.recording = rec.map((r) => ({ hex: r.hex, callsign: r.callsign }))
    return b
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
    poller.touchView(lat, lon, nm)
    const samples = store.view(lat, lon, nm, since)
    return { serverNowMs: nowMs(), samples, status: brief(), info: viewInfo(samples, lat, lon, nm, since) }
  }

  function chase(q: URLSearchParams): ChaseResponse {
    const hex = (q.get('hex') ?? '').trim().toLowerCase()
    const since = num(q, 'since', 0)
    check(HEX.test(hex), 'hex must be 6 hex digits (optionally prefixed with ~)')
    check(since >= 0, 'since must be ≥ 0')
    poller.touchChase(hex)
    const now = nowMs()
    const out: ChaseResponse = { serverNowMs: now, samples: store.track(hex, since), status: brief(), raw: rawAt(hex, now), info: info.get(hex), dest: info.dest(hex), origin: info.origin(hex) }
    if (flights !== null) out.rec = flights.get(hex)
    return out
  }

  /**
   * One past half hour in a circle: [200, HistorySlot]; [404, …] when adsb.lol has no file for it (or it is older than 31
   * days); [503, …] when it cannot be had now (adsb.lol failed or is not done with it yet, too many downloads): ask again.
   */
  async function pastSlot(q: URLSearchParams): Promise<[number, unknown]> {
    const slot = num(q, 'slot')
    const lat = num(q, 'lat')
    const lon = num(q, 'lon')
    const nm = num(q, 'nm')
    check(slot > 0 && slot % SLOT_MS === 0, 'slot must be the start of a UTC half hour, in ms')
    check(Math.abs(lat) <= 90, 'lat must be in [-90, 90]')
    check(Math.abs(lon) <= 180, 'lon must be in [-180, 180]')
    check(nm > 0 && nm <= EVERYTHING_NM, `nm must be in (0, ${EVERYTHING_NM}]`)
    const r = await history.query(slot, { lat, lon, nm })
    if (r === 'missing') return [404, { error: 'no data for this half hour' }]
    if (r === 'unavailable') return [503, { error: 'this half hour cannot be had now, try again' }]
    return [200, r]
  }

  /**
   * One aircraft's flight leg flying at `at` (default now). Its route's first airport comes with it only for the flight in the
   * air now: a leg whose last point is within 10 min of now and whose callsign is the aircraft's. The route is the aircraft's
   * current one, so an older leg (yesterday's of the same aircraft, another flight) must not be given its origin.
   */
  async function trace(q: URLSearchParams): Promise<[number, unknown]> {
    const hex = (q.get('hex') ?? '').trim().toLowerCase()
    check(HEX.test(hex), 'hex must be 6 hex digits (optionally prefixed with ~)')
    const at = num(q, 'at', nowMs())
    check(at > 0, 'at must be a time in ms')
    const r = await traces.get(hex, at)
    if (r === null) return [404, { error: 'no trace' }]
    const lastMs = r.t0Ms + (r.t.at(-1) ?? 0) * 1000
    const flyingNow = nowMs() - lastMs <= ORIGIN_MAX_AGE_MS && r.callsign !== null && r.callsign === info.get(hex)?.callsign
    return [200, { ...r, origin: flyingNow ? info.origin(hex) : null }]
  }

  function recordings(): { recordings: RecordingInfo[] } {
    if (flights === null) throw new BadRequest('recording is off: set FLIGHTS_DIR')
    return { recordings: flights.list() }
  }

  /** Rename or delete one recording: [200, its list after] or [404, …]. */
  function editRecording(q: URLSearchParams, what: 'rename' | 'delete'): [number, unknown] {
    if (flights === null) throw new BadRequest('recording is off: set FLIGHTS_DIR')
    const file = q.get('file') ?? ''
    const name = q.get('name')
    if (what === 'rename') check(name !== null, 'name is required (blank clears it)')
    const done = what === 'rename' ? flights.rename(file, name!) !== undefined : flights.remove(file)
    return done ? [200, { recordings: flights.list() }] : [404, { error: 'no such recording' }]
  }

  function record(q: URLSearchParams, post: boolean): RecordResponse {
    if (flights === null) throw new BadRequest('recording is off: set FLIGHTS_DIR')
    if (!post) return { rec: null, active: flights.active() }
    const hex = (q.get('hex') ?? '').trim().toLowerCase()
    const on = q.get('on')
    check(HEX.test(hex), 'hex must be 6 hex digits (optionally prefixed with ~)')
    check(on === '1' || on === '0', 'on must be 1 or 0')
    const rec = on === '1' ? flights.start(hex, info.get(hex), store.track(hex, 0)) : (flights.stop(hex), null)
    return { rec, active: flights.active() }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/')
    const post = req.method === 'POST' && POSTS.has(url.pathname)
    if (req.method !== 'GET' && !post) {
      if (isApi) return sendJson(req, res, 405, { error: `only GET (and POST ${[...POSTS].join(', ')})` })
      return sendText(res, 405, 'only GET\n')
    }
    if (!isApi) return serveStatic(root, url.pathname, req.headers.range, res)
    let status = 200
    let body: unknown
    try {
      if (url.pathname === '/api/wx/metar') body = await wx.metars(url.searchParams.get('bbox'))
      else if (url.pathname === '/api/wx/sigmet') body = await wx.sigmets()
      else if (url.pathname === '/api/view') body = view(url.searchParams)
      else if (url.pathname === '/api/chase') body = chase(url.searchParams)
      else if (url.pathname === '/api/status') body = poller.report()
      else if (url.pathname === '/api/history') [status, body] = await pastSlot(url.searchParams)
      else if (url.pathname === '/api/history/status') body = history.status()
      else if (url.pathname === '/api/trace') [status, body] = await trace(url.searchParams)
      else if (url.pathname === '/api/record') body = record(url.searchParams, post)
      else if (url.pathname === '/api/recordings') body = recordings()
      else if (post && url.pathname === '/api/recordings/rename') [status, body] = editRecording(url.searchParams, 'rename')
      else if (post && url.pathname === '/api/recordings/delete') [status, body] = editRecording(url.searchParams, 'delete')
      else if (url.pathname === '/api/recordings/track') {
        if (flights === null) throw new BadRequest('recording is off: set FLIGHTS_DIR')
        const r = flights.read(url.searchParams.get('file') ?? '')
        ;[status, body] = r === null ? [404, { error: 'no such recording' }] : [200, r]
      }
      else [status, body] = [404, { error: `no such endpoint: ${url.pathname}` }]
    } catch (e) {
      if (e instanceof WxError) [status, body] = [e.status, { error: e.message }]
      else if (!(e instanceof BadRequest)) throw e
      else [status, body] = [400, { error: e.message }]
    }
    return sendJson(req, res, status, body, status === 503 ? { 'retry-after': String(RETRY_AFTER_S) } : {})
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
              routes.tick(info, routesFor()).catch((e: unknown) => console.error('routes: tick failed:', e))
            }, ROUTE_TICK_MS)
            routeTimer.unref()
          }
          // Asked to roll (the command line does, for a live source): the newest hour of the past stays ready, so History
          // opens on it without a wait. Otherwise the past is fetched only when a client asks.
          if (deps.rollHistory === true && historyTimer === null) {
            const roll = (): void => void history.tick().catch((e: unknown) => console.error('history: tick failed:', e))
            roll()
            historyTimer = setInterval(roll, HISTORY_TICK_MS)
            historyTimer.unref()
          }
          if (flights !== null && flightTimer === null) {
            flightTimer = setInterval(() => flights.tick(), FLIGHT_LOG_TICK_MS)
            flightTimer.unref()
          }
          poller.start()
          done(`http://${HOST}:${(server.address() as AddressInfo).port}`)
        })
      })
    },
    close(): Promise<void> {
      history.close() // the downloads under way end now
      traces.close()
      if (routeTimer !== null) clearInterval(routeTimer)
      routeTimer = null
      if (flightTimer !== null) clearInterval(flightTimer)
      flightTimer = null
      if (historyTimer !== null) clearInterval(historyTimer)
      historyTimer = null
      poller.stop()
      if (!server.listening) return Promise.resolve()
      return new Promise((done, fail) => {
        server.close((e) => (e ? fail(e) : done()))
        server.closeAllConnections() // keep-alive clients would otherwise hold close() open
      })
    },
  }
}

/** Whether the command line keeps the newest hour of the past fetched: for a live source, not for a replay. */
export const rollsHistory = (cfg: ServerConfig): boolean => cfg.source !== 'replay'

if (import.meta.main) {
  try {
    const cfg = readServerConfig(process.env)
    const url = await createServer(cfg, { rollHistory: rollsHistory(cfg) }).listen(cfg.port)
    const routes = cfg.contact === null || cfg.source === 'replay' ? '' : cfg.routes && cfg.source === 'adsblol' ? ', routes on' : ', routes of selected flights'
    const rec = cfg.flightsDir === null ? '' : `, recording flights to ${cfg.flightsDir}`
    console.log(`FlightHopper server on ${url} (source ${cfg.source}${routes}${rec})`)
  } catch (e) {
    console.error(`server: ${(e as Error).message}`)
    process.exit(1)
  }
}
