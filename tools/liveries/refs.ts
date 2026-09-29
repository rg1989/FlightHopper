// tools/liveries/refs.ts
// Fetches reference photos for an airline's livery into data/livery-refs/<CODE>/ (git-ignored: the photos are
// copyrighted and only used to draw the design) and lists them in its refs.json, which the livery lab reads:
// - the tracked airframes' photos from planespotters.net's public API (the source the app's card uses; its thumbnails,
//   reference only, credited), one request a second;
// - larger free photos from a Wikimedia Commons category (licence and author recorded).
// New entries get view "?": look at each photo and write what it shows ("left side", "3/4 front right", "tail", …) so
// the lab puts the model's same view beside it.
//
//   node tools/liveries/refs.ts --code WZZ [--hex 4d2531,4d2532] [--commons "Category:Wizz Air Airbus A321neo"] [--max 12]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const UA = 'FlightHopper livery research (+https://github.com/rg1989/FlightHopper)'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface Ref {
  file: string
  view: string // what the photo shows; "?" until someone looks
  registration?: string
  source: string // the photo's page
  author: string
  licence: string
  date?: string
}

/** refs.json with the new entries added; an existing entry (same file) is kept as it is (its view may be filled in). */
export function mergeRefs(old: Ref[], added: Ref[]): Ref[] {
  const have = new Set(old.map((r) => r.file))
  return [...old, ...added.filter((r) => !have.has(r.file))]
}

/** Commons extmetadata → [licence, author, date] as plain text. */
export function commonsMeta(meta: Record<string, { value?: string } | undefined>): [string, string, string] {
  const text = (k: string): string => (meta[k]?.value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  return [text('LicenseShortName') || 'unknown', text('Artist') || 'unknown', text('DateTimeOriginal').slice(0, 10)]
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_')

async function json(url: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}

async function download(url: string, path: string): Promise<void> {
  const r = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  writeFileSync(path, Buffer.from(await r.arrayBuffer()))
}

async function planespotters(hexes: string[], dir: string, max: number): Promise<Ref[]> {
  const out: Ref[] = []
  for (const hex of hexes.slice(0, max)) {
    await sleep(1000)
    try {
      const body = await json(`https://api.planespotters.net/pub/photos/hex/${hex.toUpperCase()}`)
      const p = body.photos?.[0]
      const src = p?.thumbnail_large?.src ?? p?.thumbnail?.src
      if (!src) continue
      const reg = typeof p.registration === 'string' ? p.registration : hex
      const file = `ps-${safe(reg)}-${safe(String(p.id ?? hex))}.jpg`
      if (!existsSync(join(dir, file))) await download(src, join(dir, file))
      out.push({ file, view: '?', registration: reg, source: p.link, author: p.photographer ?? 'unknown', licence: 'planespotters.net: reference only' })
    } catch (err) {
      console.warn(`${hex}: ${String(err)}`)
    }
  }
  return out
}

async function commons(category: string, dir: string, max: number): Promise<Ref[]> {
  const api = 'https://commons.wikimedia.org/w/api.php?format=json&action=query'
  const list = await json(`${api}&list=categorymembers&cmtype=file&cmlimit=${max}&cmsort=timestamp&cmdir=desc&cmtitle=${encodeURIComponent(category)}`)
  const out: Ref[] = []
  for (const m of list.query?.categorymembers ?? []) {
    try {
      const info = await json(`${api}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1600&titles=${encodeURIComponent(m.title)}`)
      const page = Object.values(info.query.pages)[0] as { imageinfo?: Array<{ thumburl?: string; url: string; descriptionurl: string; extmetadata: Record<string, { value?: string }> }> }
      const ii = page.imageinfo?.[0]
      if (!ii) continue
      const [licence, author, date] = commonsMeta(ii.extmetadata)
      const file = `commons-${safe(m.title.replace(/^File:/, '')).slice(0, 80)}`.replace(/\.(jpe?g|png|webp)$/i, '') + '.jpg'
      if (!existsSync(join(dir, file))) await download(ii.thumburl ?? ii.url, join(dir, file))
      out.push({ file, view: '?', source: ii.descriptionurl, author, licence, date })
      await sleep(300)
    } catch (err) {
      console.warn(`${m.title}: ${String(err)}`)
    }
  }
  return out
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { code: { type: 'string' }, hex: { type: 'string' }, commons: { type: 'string' }, max: { type: 'string', default: '12' }, out: { type: 'string', default: 'data/livery-refs' } } })
  if (!values.code) throw new Error('usage: node tools/liveries/refs.ts --code CODE [--hex a,b] [--commons "Category:…"] [--max 12]')
  const dir = join(values.out, values.code.toUpperCase())
  mkdirSync(dir, { recursive: true })
  const max = Number(values.max)
  const added = [
    ...(values.hex ? await planespotters(values.hex.split(','), dir, max) : []),
    ...(values.commons ? await commons(values.commons, dir, max) : []),
  ]
  const path = join(dir, 'refs.json')
  const old: Ref[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  writeFileSync(path, JSON.stringify(mergeRefs(old, added), null, 1))
  console.log(`${added.length} photos → ${dir} (refs.json: fill in each "?" view)`)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
