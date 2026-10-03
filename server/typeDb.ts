// server/typeDb.ts
// Aircraft types for the past. adsb.lol's half-hour files carry an address and no type, so History drew every aircraft
// as the generic arrow. This is the Mictronics aircraft database (github.com/Mictronics/aircraft-database, ODC-By 1.0:
// "Contains information from the Mictronics aircraft database, made available under the ODC Attribution License"; the
// README credits it), one zip of 4.3 MB, rebuilt weekly, holding
//   aircrafts.json  { "4A0481": { "r": "YR-ADA", "t": "A320", "f": "00", "d": "…" }, … }  452,000 addresses, upper-case hex
//                   (f is two flag characters, the first '1' for military: 17,038 of 451,759 entries on 2026-10-03)
//   types.json      { "A320": { "desc": "L2J", "wtc": "M" }, … }                        2,788 types
// A type's desc is its ICAO Doc 8643 description: kind (L landplane, S seaplane, A amphibian, H helicopter, G gyrocopter;
// this table writes R for a tiltrotor, V a surface vehicle, D a drone, B a balloon or airship), engine count, engine kind
// (P piston, T turboprop, J jet, E electric). wtc is the wake category (L, M, H; J super).
// Downloaded when the server starts and checked once a day after (a conditional GET: the zip changes weekly), read with
// Node's own zlib, held in memory only and compact: the addresses sorted in a Uint32Array, a type index and a military flag
// per address, a category per type (about 3 MB). Never written to disk. Not tar1090-db or ADS-B Exchange's database: their licences
// are unclear.
import { promisify } from 'node:util'
import { crc32, deflateRawSync, inflateRaw } from 'node:zlib'

const inflateRawAsync = promisify(inflateRaw) // off the event loop: aircrafts.json is 26 MB unzipped

export const TYPE_DB_URL = 'https://raw.githubusercontent.com/Mictronics/aircraft-database/main/indexedDB_old.zip'
const TIMEOUT_MS = 60_000
const REFRESH_MS = 24 * 3_600_000 // the zip changes weekly; a day keeps a new week's types a day late at most
const RETRY_MS = 10 * 60_000 // after a failed download
const ADDRESS = /^[0-9a-f]{6}$/i // an ICAO address; a '~' (non-ICAO) one is in no register
const DESIGNATOR = /^[A-Z0-9]{2,4}$/ // an ICAO type designator
const NO_DESIGNATOR = 'ZZZZ' // ICAO's "no designator assigned": no type

// ---- zip ----

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const DESCRIPTOR = 0x08074b50
const ZIP64 = 0xffffffff // a size or offset in the zip64 record instead

/**
 * The entries of a zip archive, by name: each one stored (method 0) or deflated (method 8), checked against its size and
 * CRC-32. `want` names the entries to read; the others are skipped unread. Throws on anything else: no end record, a
 * broken directory, zip64, another method, an entry cut short, a wrong size or CRC, a deflated entry that inflates past
 * its size (it stops there).
 * The end record is found from the back: the one whose comment (up to 64 KB) runs exactly to the file's end, so the
 * signature inside a comment is not taken for it. The sizes come from the central directory, which has them even where a
 * local header defers them to a data descriptor (flag bit 3: zeros there).
 * ponytail: no zip64 (an archive over 4 GB or 65,535 entries, refused) and no encryption. Add them if a source ever needs.
 */
export async function readZip(zip: Uint8Array, want?: ReadonlySet<string>): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let end = zip.byteLength - 22
  const farthest = Math.max(0, end - 0xffff)
  while (end >= farthest && !(dv.getUint32(end, true) === END && end + 22 + dv.getUint16(end + 20, true) === zip.byteLength)) end--
  if (end < farthest) throw new Error('not a zip: no end of central directory')
  const count = dv.getUint16(end + 10, true)
  let o = dv.getUint32(end + 16, true)
  if (count === 0xffff || o === ZIP64) throw new Error('zip: zip64 is not read')
  const out = new Map<string, Uint8Array>()
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(o, true) !== CENTRAL) throw new Error(`zip: no central directory entry at ${o}`)
    const method = dv.getUint16(o + 10, true)
    const crc = dv.getUint32(o + 16, true)
    const size = dv.getUint32(o + 20, true)
    const plainSize = dv.getUint32(o + 24, true)
    const nameLength = dv.getUint16(o + 28, true)
    const local = dv.getUint32(o + 42, true)
    const name = new TextDecoder().decode(zip.subarray(o + 46, o + 46 + nameLength))
    o += 46 + nameLength + dv.getUint16(o + 30, true) + dv.getUint16(o + 32, true) // name, extra field, comment
    if (want !== undefined && !want.has(name)) continue
    if (size === ZIP64 || plainSize === ZIP64 || local === ZIP64) throw new Error(`zip: ${name} is zip64, not read`)
    if (dv.getUint32(local, true) !== LOCAL) throw new Error(`zip: no local header for ${name}`)
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true) // its own name and extra lengths
    const data = zip.subarray(start, start + size)
    if (data.length !== size) throw new Error(`zip: ${name} is cut short`)
    if (method !== 0 && method !== 8) throw new Error(`zip: ${name} uses method ${method}`)
    // Inflated no further than its size (at least 1: zlib's floor): a bomb stops there and fails the size check.
    const plain: Uint8Array = method === 0 ? data : await inflateRawAsync(data, { maxOutputLength: Math.max(1, plainSize) })
    if (plain.length !== plainSize || crc32(plain) !== crc) throw new Error(`zip: ${name} does not match its size or CRC`)
    out.set(name, plain)
  }
  return out
}

/**
 * Test helper: a zip archive of the given entries, stored (0) or deflated (8), with an optional archive comment.
 * localExtra writes that many bytes of extra field into an entry's local header only, as some zip tools do. descriptor
 * writes an entry as a streaming zip tool does: flag bit 3, zeros for its CRC and sizes in its local header, and a data
 * descriptor holding them after its data (the central directory has them too).
 */
export function encodeZip(entries: { name: string; data: Uint8Array; method: 0 | 8; localExtra?: number; descriptor?: boolean }[], comment = ''): Uint8Array<ArrayBuffer> {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const extra = Buffer.alloc(e.localExtra ?? 0)
    const body = e.method === 8 ? deflateRawSync(e.data) : Buffer.from(e.data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(LOCAL, 0)
    head.writeUInt16LE(20, 4) // version needed: 2.0
    head.writeUInt16LE(e.method, 8)
    head.writeUInt32LE(crc32(e.data), 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(e.data.length, 22)
    head.writeUInt16LE(name.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(CENTRAL, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    head.copy(dir, 10, 8, 28) // method, time, date, CRC, sizes and name length: the same fields
    dir.writeUInt32LE(offset, 42)
    head.writeUInt16LE(extra.length, 28)
    const after = Buffer.alloc(e.descriptor === true ? 16 : 0)
    if (e.descriptor === true) {
      head.writeUInt16LE(8, 6) // flag bit 3: the CRC and sizes follow the data
      dir.writeUInt16LE(8, 8)
      head.fill(0, 14, 26)
      after.writeUInt32LE(DESCRIPTOR, 0)
      after.writeUInt32LE(crc32(e.data), 4)
      after.writeUInt32LE(body.length, 8)
      after.writeUInt32LE(e.data.length, 12)
    }
    parts.push(head, name, extra, body, after)
    central.push(dir, name)
    offset += head.length + name.length + extra.length + body.length + after.length
  }
  const dirBytes = Buffer.concat(central)
  const tail = Buffer.alloc(22)
  tail.writeUInt32LE(END, 0)
  tail.writeUInt16LE(entries.length, 8)
  tail.writeUInt16LE(entries.length, 10)
  tail.writeUInt32LE(dirBytes.length, 12)
  tail.writeUInt32LE(offset, 16)
  tail.writeUInt16LE(Buffer.byteLength(comment), 20)
  return new Uint8Array(Buffer.concat([...parts, dirBytes, tail, Buffer.from(comment)]))
}

// ---- the table ----

/** Types that are no powered aeroplane, by name: surface vehicles, a tower, gliders, lighter-than-air, ultralights. */
const BY_TYPE = new Map<string, string>([
  ['GND', 'C2'], // surface vehicle, service
  ['SERV', 'C2'],
  ['EMER', 'C1'], // surface vehicle, emergency
  ['TWR', 'C3'], // point obstacle
  ['GLID', 'B1'], // glider
  ['GLIM', 'B1'], // motor glider
  ['BALL', 'B2'], // balloon: lighter than air
  ['SHIP', 'B2'], // airship
  ['ULAC', 'B4'], // ultralight
  ['PARA', 'B4'], // paraglider, paramotor
])

/**
 * The ADS-B emitter category (DO-260B) a type implies, for the client's iconFor: the silhouette live mode draws from
 * the broadcast category. From the type's name for the few above, else from its ICAO description and wake category:
 * a surface vehicle C2 and a balloon or airship B2 (the kinds of those named, for one that is not); helicopter,
 * gyrocopter or tiltrotor A7; drone B6; heavy or super wake A5; piston, turboprop or electric A1; any other A3.
 */
export function categoryOf(type: string, desc: string, wtc: string): string {
  const named = BY_TYPE.get(type)
  if (named !== undefined) return named
  if (desc.startsWith('V')) return 'C2'
  if (desc.startsWith('B')) return 'B2'
  if (/^[HGTR]/.test(desc)) return 'A7'
  if (desc.startsWith('D')) return 'B6'
  if (wtc === 'H' || wtc === 'J') return 'A5'
  if (/^..[PTE]/.test(desc)) return 'A1'
  return 'A3'
}

const CATEGORIES: readonly (string | null)[] = [null, 'A1', 'A3', 'A5', 'A7', 'B1', 'B2', 'B4', 'B6', 'C1', 'C2', 'C3']
const NOT_TYPED = Object.freeze({ type: null, category: null, military: false })

/** The addresses that have a type, sorted, each with its type's index and its military flag; per type, its designator and category. */
export interface TypeTable {
  addrs: Uint32Array
  typeOf: Uint16Array // index into codes, per address
  mil: Uint8Array // 1 for a military address (Mictronics' flag: the first character of f is '1'), per address
  codes: string[]
  cats: Uint8Array // index into CATEGORIES, per type (0: none)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The table from aircrafts.json and types.json as parsed. An address is kept when it is 6 hex digits with a type
 * designator (not ZZZZ), with its military flag (the first character of its f is '1'); a type types.json does not describe
 * gets no category. Nothing of the parsed JSON is kept.
 * ponytail: a military-flagged address with no type designator is not kept, so lookup does not call it military: 241 of the
 * 17,038 on 2026-10-03 (checked), and a late fall of one of those is not left out.
 */
export function buildTypeTable(aircraft: unknown, types: unknown): TypeTable {
  const described = isRecord(types) ? types : {}
  const index = new Map<string, number>()
  const codes: string[] = []
  const cats: number[] = []
  const keys = isRecord(aircraft) ? Object.keys(aircraft) : []
  // Address × 131,072 + military × 65,536 + type index: 41 bits, exact in a double, so one numeric sort orders the columns together.
  const packed = new Float64Array(keys.length)
  let n = 0
  for (const key of keys) {
    const entry = (aircraft as Record<string, unknown>)[key]
    const t = isRecord(entry) ? entry.t : undefined
    if (!ADDRESS.test(key) || typeof t !== 'string' || !DESIGNATOR.test(t) || t === NO_DESIGNATOR) continue
    let ix = index.get(t)
    if (ix === undefined) {
      if (codes.length > 0xffff) continue // never: ICAO has a few thousand designators, not 65,536
      ix = codes.length
      index.set(t, ix)
      codes.push(t)
      const d = described[t]
      const desc = isRecord(d) && typeof d.desc === 'string' ? d.desc : null
      const wtc = isRecord(d) && typeof d.wtc === 'string' ? d.wtc : ''
      cats.push(desc === null ? 0 : CATEGORIES.indexOf(categoryOf(t, desc, wtc)))
    }
    const f = (entry as Record<string, unknown>).f
    const military = typeof f === 'string' && f.startsWith('1') ? 1 : 0
    packed[n++] = parseInt(key, 16) * 131072 + military * 65536 + ix
  }
  const sorted = packed.subarray(0, n).sort()
  const addrs = new Uint32Array(n)
  const typeOf = new Uint16Array(n)
  const mil = new Uint8Array(n)
  let m = 0
  for (const v of sorted) {
    const addr = Math.floor(v / 131072)
    if (m > 0 && addrs[m - 1] === addr) continue // the same address twice (in upper and lower case): one is kept
    const rest = v % 131072
    addrs[m] = addr
    mil[m] = rest >= 65536 ? 1 : 0
    typeOf[m++] = rest % 65536
  }
  return { addrs: addrs.slice(0, m), typeOf: typeOf.slice(0, m), mil: mil.slice(0, m), codes, cats: Uint8Array.from(cats) }
}

// ---- the store ----

export interface TypeDbOpts {
  url?: string // default TYPE_DB_URL
  userAgent: string
  fetchFn?: typeof fetch
  nowMs?: () => number
  table?: TypeTable // a table to start with (tests); load() replaces it
}

/**
 * The type table and its download. lookup() answers from the table in memory; ready() waits for the first one. tick()
 * loads when it is due (call it every minute): at once, a day after a good load, 10 min after a failed one. A failure
 * keeps the table there was. Nothing here runs a timer.
 */
export class TypeDb {
  #url: string
  #userAgent: string
  #fetch: typeof fetch
  #now: () => number
  #table: TypeTable | null
  #etag: string | null = null
  #nextMs = 0 // when tick() loads again
  #loading: Promise<boolean> | null = null
  #failed = false // the last load failed with no table in: none is coming before the next try, 10 min on
  #waiting = new Set<(ok: boolean) => void>() // ready() calls waiting for the first table
  #stop = new AbortController() // close() aborts the download under way

  constructor(o: TypeDbOpts) {
    this.#url = o.url ?? TYPE_DB_URL
    this.#userAgent = o.userAgent
    this.#fetch = o.fetchFn ?? ((input, init) => fetch(input, init))
    this.#now = o.nowMs ?? Date.now
    this.#table = o.table ?? null
  }

  /**
   * An address's ICAO type designator, the emitter category it implies (categoryOf) and Mictronics' military flag, from one
   * search of the table. type null: none known, or a '~' address; category null as well, or for a type with no description;
   * military false when none is known.
   */
  lookup(hex: string): { type: string | null; category: string | null; military: boolean } {
    const i = this.#find(hex)
    if (i < 0) return NOT_TYPED
    const t = this.#table!
    const ix = t.typeOf[i]
    return { type: t.codes[ix], category: CATEGORIES[t.cats[ix]] ?? null, military: t.mil[i] === 1 }
  }

  /**
   * True once a table is in (at once if one is); false after ms without one, and at once when a load has failed with no
   * table in and none is under way (none is coming before the next try): the first ask after a failed start does not wait.
   * Never rejects.
   */
  ready(ms: number): Promise<boolean> {
    if (this.#table !== null) return Promise.resolve(true)
    if (this.#failed && this.#loading === null) return Promise.resolve(false)
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer)
        resolve(ok)
      }
      const timer = setTimeout(() => {
        this.#waiting.delete(done)
        resolve(false)
      }, ms)
      timer.unref() // a server closing does not wait for it
      this.#waiting.add(done)
    })
  }

  /**
   * One download, conditional (If-None-Match) once a table is in; a new table is swapped in whole when the zip reads.
   * true: a table is in after it (a new one, or the old one on a 304). A failure (network, timeout, a status that is not
   * 200 or 304, a zip or JSON that does not read, no address with a type) keeps the old table and is false. Never throws.
   * Calls during a download share it.
   */
  load(): Promise<boolean> {
    this.#loading ??= this.#load().finally(() => (this.#loading = null))
    return this.#loading
  }

  /** load() when it is due: at the first call, a day after the last good load, 10 min after a failed one. */
  async tick(): Promise<void> {
    if (this.#loading === null && this.#now() >= this.#nextMs) await this.load()
  }

  /** Aborts the download under way (it fails, the table stays); none starts after it. A server calls it when it closes. */
  close(): void {
    this.#stop.abort()
  }

  async #load(): Promise<boolean> {
    let ok = false
    try {
      if (this.#stop.signal.aborted) return false
      const headers: Record<string, string> = { 'user-agent': this.#userAgent }
      if (this.#table !== null && this.#etag !== null) headers['if-none-match'] = this.#etag
      const res = await this.#fetch(this.#url, { headers, signal: AbortSignal.any([this.#stop.signal, AbortSignal.timeout(TIMEOUT_MS)]) })
      if (res.status === 304 && this.#table !== null) {
        void res.body?.cancel().catch(() => {})
        ok = true
        return true
      }
      if (res.status !== 200) {
        void res.body?.cancel().catch(() => {}) // not read: let the connection go
        return false
      }
      const files = await readZip(new Uint8Array(await res.arrayBuffer()), new Set(['aircrafts.json', 'types.json']))
      const json = (name: string): unknown => {
        const bytes = files.get(name)
        if (bytes === undefined) throw new Error(`the zip has no ${name}`)
        return JSON.parse(new TextDecoder().decode(bytes))
      }
      // ponytail: JSON.parse of the 26 MB aircrafts.json and the build hold the event loop ~0.85 s (0.56 s + 0.29 s measured
      // on the real zip, an Apple M2), when the server starts and when the weekly zip changes; a 304 costs nothing, and
      // ~250 MB of heap come and go. Upgrade: both in a worker thread (node:worker_threads), the typed arrays handed back.
      const table = buildTypeTable(json('aircrafts.json'), json('types.json'))
      if (table.addrs.length === 0) return false // a file with no type in it is no table
      this.#table = table
      this.#etag = res.headers.get('etag')
      ok = true
      return true
    } catch {
      return false
    } finally {
      this.#nextMs = this.#now() + (ok ? REFRESH_MS : RETRY_MS)
      this.#failed = this.#table === null
      // A table in: the waiting have it. None (this load failed): none is coming before the next try, they wait no more.
      for (const done of this.#waiting) done(this.#table !== null)
      this.#waiting.clear()
    }
  }

  /** The address's row in the table, or -1. */
  #find(hex: string): number {
    const t = this.#table
    if (t === null || !ADDRESS.test(hex)) return -1
    const addr = parseInt(hex, 16)
    let lo = 0
    let hi = t.addrs.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const v = t.addrs[mid]
      if (v < addr) lo = mid + 1
      else if (v > addr) hi = mid - 1
      else return mid
    }
    return -1
  }
}
