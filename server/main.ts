// server/main.ts
// The FlightHopper server: one Source → Poller → SampleStore, served as plain HTTP polling, plus the built client.
//   npm run server                      (settings: .env.local, see .env.example)
//   GET /api/view?lat&lon&nm&since      samples in a circle received after `since` (server-clock rxMs)
//   GET /api/chase?hex&since            one aircraft's samples received after `since`
//   GET /api/status                     the poller's StatusReport
//   GET /*                              dist/ (index.html for client routes)
import { readFile, stat } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import type { ChaseResponse, ViewResponse } from '../shared/api.ts'
import { TokenBucket } from './budget.ts'
import { readServerConfig, type ServerConfig } from './config.ts'
import { POLLER_DEFAULTS, Poller } from './poller.ts'
import { Recorder } from './recorder.ts'
import { makeSource } from './sources/index.ts'
import type { Source } from './sources/types.ts'
import { SampleStore } from './store.ts'

// ponytail: loopback only. Cloudflare Tunnel and the Vite dev proxy both connect locally, but other machines on the
// LAN cannot. Add a HOST variable when one needs to.
const HOST = '127.0.0.1'
// ponytail: an area source (adsb.lol) polls the cells of at most a 250 nm view; a wider view still gets whatever the
// store holds. Full-snapshot sources have no cells, so the cap costs them nothing.
const MAX_POLLED_NM = 250
const HEX = /^~?[0-9a-f]{6}$/

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
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
 * Wires one Source (cfg, or deps.source) to a Poller, a SampleStore and an HTTP server.
 * deps.nowMs is the server clock for the poller and the budget; it must be the clock the source stamps tRecvMs with
 * (Date.now for live sources, the same injected clock for a replay built with it).
 */
export function createServer(
  cfg: ServerConfig,
  deps: { source?: Source; nowMs?: () => number } = {},
): { listen(port: number): Promise<string>; close(): Promise<void>; poller: Poller } {
  const nowMs = deps.nowMs ?? Date.now
  const source = deps.source ?? makeSource(cfg)
  const store = new SampleStore()
  const bucket = new TokenBucket(Math.min(cfg.maxRps, source.caps.maxRps), nowMs)
  const recorder = cfg.recordDir !== null && source.caps.kind !== 'replay' ? new Recorder(cfg.recordDir) : null
  // The poller prunes the store (180 s horizon) on every 100 ms tick, so no separate prune timer is needed.
  const poller = new Poller(source, store, bucket, { ...POLLER_DEFAULTS, recorder, hideFlagged: !cfg.showPiaLadd, nowMs })
  const root = resolve(cfg.staticDir)

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
    return { serverNowMs: nowMs(), samples: store.view(lat, lon, nm, since), status: poller.brief() }
  }

  function chase(q: URLSearchParams): ChaseResponse {
    const hex = (q.get('hex') ?? '').trim().toLowerCase()
    const since = num(q, 'since', 0)
    check(HEX.test(hex), 'hex must be 6 hex digits (optionally prefixed with ~)')
    check(since >= 0, 'since must be ≥ 0')
    poller.touchChase(hex)
    return { serverNowMs: nowMs(), samples: store.track(hex, since), status: poller.brief() }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/')
    if (req.method !== 'GET') {
      if (isApi) sendJson(res, 405, { error: 'only GET' })
      else sendText(res, 405, 'only GET\n')
      return
    }
    if (!isApi) return serveStatic(root, url.pathname, res)
    try {
      if (url.pathname === '/api/view') return sendJson(res, 200, view(url.searchParams))
      if (url.pathname === '/api/chase') return sendJson(res, 200, chase(url.searchParams))
      if (url.pathname === '/api/status') return sendJson(res, 200, poller.report())
      sendJson(res, 404, { error: `no such endpoint: ${url.pathname}` })
    } catch (e) {
      if (!(e instanceof BadRequest)) throw e
      sendJson(res, 400, { error: e.message })
    }
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error('server: request failed:', e)
      if (res.headersSent) res.destroy()
      else sendJson(res, 500, { error: 'internal error' })
    })
  })

  return {
    poller,
    listen(port: number): Promise<string> {
      return new Promise((done, fail) => {
        server.once('error', fail)
        server.listen(port, HOST, () => {
          server.off('error', fail)
          poller.start()
          done(`http://${HOST}:${(server.address() as AddressInfo).port}`)
        })
      })
    },
    close(): Promise<void> {
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
    console.log(`FlightHopper server on ${url} (source ${cfg.source})`)
  } catch (e) {
    console.error(`server: ${(e as Error).message}`)
    process.exit(1)
  }
}
