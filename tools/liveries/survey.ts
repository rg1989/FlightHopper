// tools/liveries/survey.ts
// Which aircraft to paint next: ranks type × operator combinations seen in the recordings (data/recordings/*.jsonl,
// the recorder's point queries), by distinct airframes and by flights (distinct callsign per day), and says which
// model draws each type and whether its operator has a design yet. Also lists each combination's airframes (hex,
// registration) for tools/liveries/refs.ts to fetch photos of.
//
//   node tools/liveries/survey.ts [--near 32.0114,34.8867] [--top 25] [--json out.json]
//     --near lat,lon   only the recorder's queries centred there (default: Ben Gurion); 'all' for every query
import { createReadStream, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { ModelPicker } from '../../client/scene/modelFor.ts'
import type { ModelManifest } from '../../client/types.ts'
import { DESIGNS } from '../../client/livery/designs/index.ts'
import table from '../../client/scene/liveries.json' with { type: 'json' }

export interface Seen {
  hex: string
  reg: string | null
  type: string
  op: string | null // ICAO airline prefix of the callsign, null for none (private, military…)
  flights: Set<string> // day + callsign
}

export interface Combo {
  type: string
  op: string | null
  airframes: number
  flights: number
  frames: Array<{ hex: string; reg: string | null; flights: number }>
}

/** An aircraft object of a readsb response into the tally (by hex; the first type and operator seen stay). */
export function tally(seen: Map<string, Seen>, a: { hex?: string; t?: string; r?: string; flight?: string }, day: string): void {
  if (!a.hex || !a.t) return
  const cs = (a.flight ?? '').trim()
  const op = /^[A-Z]{3}\d/.test(cs) ? cs.slice(0, 3) : null
  let s = seen.get(a.hex)
  if (s === undefined) seen.set(a.hex, (s = { hex: a.hex, reg: a.r ?? null, type: a.t, op, flights: new Set() }))
  if (s.op === null && op !== null) s.op = op
  if (cs) s.flights.add(`${day} ${cs}`)
}

/** The combinations, most flights first. */
export function combos(seen: Map<string, Seen>): Combo[] {
  const by = new Map<string, Combo>()
  for (const s of seen.values()) {
    const key = `${s.type} ${s.op ?? '-'}`
    let c = by.get(key)
    if (c === undefined) by.set(key, (c = { type: s.type, op: s.op, airframes: 0, flights: 0, frames: [] }))
    c.airframes++
    c.flights += s.flights.size
    c.frames.push({ hex: s.hex, reg: s.reg, flights: s.flights.size })
  }
  for (const c of by.values()) c.frames.sort((a, b) => b.flights - a.flights)
  return [...by.values()].sort((a, b) => b.flights - a.flights || b.airframes - a.airframes)
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { near: { type: 'string', default: '32.0114,34.8867' }, top: { type: 'string', default: '25' }, json: { type: 'string' }, dir: { type: 'string', default: 'data/recordings' } } })
  const near = values.near === 'all' ? null : `/${values.near.replace(',', '/')}/`
  const seen = new Map<string, Seen>()
  for (const f of readdirSync(values.dir).filter((n) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(n)).sort()) {
    for await (const line of createInterface({ input: createReadStream(`${values.dir}/${f}`) })) {
      if (near !== null && !line.includes(near)) continue
      try {
        const rec = JSON.parse(line)
        if (rec.status !== 200) continue
        for (const a of JSON.parse(rec.body).ac ?? []) tally(seen, a, f.slice(0, 10))
      } catch { /* a torn line */ }
    }
  }
  const man: ModelManifest = JSON.parse(readFileSync('public/models/manifest.json', 'utf8'))
  const pick = new ModelPicker(man)
  const t = table as { aliases: Record<string, string>; liveries: Record<string, unknown> }
  const all = combos(seen)
  console.log(`${seen.size} airframes`)
  console.log('type  operator  airframes  flights  model     livery')
  for (const c of all.slice(0, Number(values.top))) {
    const code = c.op === null ? null : (t.aliases[c.op] ?? c.op)
    const livery = code === null ? '-' : code in DESIGNS ? `${code} design` : code in t.liveries ? `${code} colours` : 'none'
    console.log(`${c.type.padEnd(5)} ${(c.op ?? '-').padEnd(9)} ${String(c.airframes).padStart(9)} ${String(c.flights).padStart(8)}  ${pick.for(c.type, null).id.padEnd(9)} ${livery}`)
  }
  if (values.json) writeFileSync(values.json, JSON.stringify(all, null, 1))
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
