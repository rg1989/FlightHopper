// server/config.ts
// Server settings from environment variables. `npm run server` loads .env.local; .env.example lists them all.
import { globSync } from 'node:fs'
import type { SourceKind } from '../shared/types.ts'

export interface ServerConfig {
  source: SourceKind // ADSB_SOURCE, default replay
  contact: string | null // CONTACT, required for adsblol (it goes into the User-Agent)
  maxRps: number // MAX_RPS, default 1; never above 1 for adsblol
  readsbUrl: string // READSB_URL, default http://127.0.0.1:8042
  readsbCoverage: { lat: number; lon: number; radiusNm: number } | null // READSB_COVERAGE "lat,lon,nm", required for readsb
  replayFiles: string[] // REPLAY_FILES expanded to files (replay only), default data/fixtures/*.jsonl
  replaySpeed: number // REPLAY_SPEED, default 1
  recordDir: string | null // RECORD_DIR; unset or empty = no recording (replay is never recorded)
  port: number // PORT, default 8787
  showPiaLadd: boolean // SHOW_PIA_LADD=1 serves PIA/LADD-flagged aircraft
  routes: boolean // ROUTES=1 looks up flight routes on adsb.lol (only used with ADSB_SOURCE=adsblol); default off
  staticDir: string // the built client (`npm run build` → dist/)
}

type Env = Record<string, string | undefined>

const SOURCES: readonly string[] = ['adsblol', 'readsb', 'replay'] satisfies SourceKind[]
const DEFAULT_REPLAY_FILES = 'data/fixtures/*.jsonl'
const DEFAULT_READSB_URL = 'http://127.0.0.1:8042'

/** Trimmed value; unset and empty mean the same. */
const str = (env: Env, name: string): string => env[name]?.trim() ?? ''

function num(env: Env, name: string, def: number, ok: (v: number) => boolean, rule: string): number {
  const raw = str(env, name)
  if (raw === '') return def
  const v = Number(raw)
  if (!Number.isFinite(v) || !ok(v)) throw new Error(`${name} must be ${rule}, got "${raw}"`)
  return v
}

/** An unset/empty, 0 or 1 switch; anything else throws. */
function flag(env: Env, name: string): boolean {
  const v = str(env, name)
  if (v !== '' && v !== '0' && v !== '1') throw new Error(`${name} must be 0 or 1, got "${v}"`)
  return v === '1'
}

function coverage(raw: string): { lat: number; lon: number; radiusNm: number } {
  if (raw === '') throw new Error('READSB_COVERAGE is required for ADSB_SOURCE=readsb: "lat,lon,nm" around your receiver, e.g. 32.01,34.88,200')
  const p = raw.split(',').map((x) => (x.trim() === '' ? NaN : Number(x)))
  const [lat, lon, radiusNm] = p
  if (p.length !== 3 || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || !(radiusNm > 0) || !Number.isFinite(radiusNm)) {
    throw new Error(`READSB_COVERAGE must be "lat,lon,nm" with |lat| ≤ 90, |lon| ≤ 180, nm > 0, got "${raw}"`)
  }
  return { lat, lon, radiusNm }
}

/** Comma-separated paths and globs → existing files. Each pattern's matches are sorted; the first occurrence wins. */
function expand(patterns: string): string[] {
  const files = patterns
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .flatMap((p) => globSync(p).sort())
  return [...new Set(files)]
}

/** Reads and checks every setting; throws an Error naming the variable when one is invalid. */
export function readServerConfig(env: Env): ServerConfig {
  const source = str(env, 'ADSB_SOURCE') || 'replay'
  if (!SOURCES.includes(source)) throw new Error(`ADSB_SOURCE must be one of ${SOURCES.join(', ')}, got "${source}"`)
  const kind = source as SourceKind

  const contact = str(env, 'CONTACT') || null
  if (kind === 'adsblol' && contact === null) {
    throw new Error('CONTACT is required for ADSB_SOURCE=adsblol: adsb.lol asks every client for a contact (email or URL) in its User-Agent')
  }
  const maxRps = num(env, 'MAX_RPS', 1, (v) => v > 0, 'a number > 0')

  const readsbUrl = str(env, 'READSB_URL') || DEFAULT_READSB_URL
  let readsbCoverage: ServerConfig['readsbCoverage'] = null
  if (kind === 'readsb') {
    if (!/^https?:\/\//.test(readsbUrl) || !URL.canParse(readsbUrl)) throw new Error(`READSB_URL must be an http(s) URL, got "${readsbUrl}"`)
    readsbCoverage = coverage(str(env, 'READSB_COVERAGE'))
  }

  const patterns = str(env, 'REPLAY_FILES') || DEFAULT_REPLAY_FILES
  const replayFiles = kind === 'replay' ? expand(patterns) : []
  if (kind === 'replay' && replayFiles.length === 0) throw new Error(`REPLAY_FILES matched no files: ${patterns}`)

  return {
    source: kind,
    contact,
    maxRps: kind === 'adsblol' ? Math.min(1, maxRps) : maxRps,
    readsbUrl,
    readsbCoverage,
    replayFiles,
    replaySpeed: num(env, 'REPLAY_SPEED', 1, (v) => v > 0, 'a number > 0'),
    recordDir: str(env, 'RECORD_DIR') || null,
    port: num(env, 'PORT', 8787, (v) => Number.isInteger(v) && v >= 0 && v <= 65535, 'an integer 0..65535'),
    showPiaLadd: flag(env, 'SHOW_PIA_LADD'),
    routes: flag(env, 'ROUTES'),
    staticDir: 'dist',
  }
}
