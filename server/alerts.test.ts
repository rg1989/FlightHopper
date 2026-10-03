// server/alerts.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ongoing, type AlertEvent } from '../shared/alerts.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { Alerts, ntfyPush } from './alerts.ts'
import { encodeHeatmap } from './heatmap.ts'

const T0 = Date.UTC(2026, 8, 30, 5, 31, 0)
const SLOT = Date.UTC(2026, 8, 30, 5, 0) // the 05:00 half hour
const DAY = 86_400_000
const at = (min: number, sec = 0): number => SLOT + (min * 60 + sec) * 1000 // 05:00 plus min:sec
const tmp = (): string => mkdtempSync(join(tmpdir(), 'fh-alerts-'))

function setup(o: {
  dir?: string
  on?: boolean
  codes?: string[]
  typeOf?: (hex: string) => { type: string | null; category: string | null }
  push?: (e: AlertEvent) => void
} = {}) {
  const clock = { t: T0 }
  const pushed: AlertEvent[] = []
  const dir = o.dir ?? tmp()
  const push = (e: AlertEvent): void => {
    pushed.push(structuredClone(e))
    o.push?.(e)
  }
  const a = new Alerts({ dir, nowMs: () => clock.t, sweep: true, push, codes: o.codes, typeOf: o.typeOf })
  if (o.on ?? true) a.setOn(true)
  return { a, clock, pushed, dir }
}

const ac = (o: Partial<ReadsbAircraft> = {}): ReadsbAircraft => ({
  hex: '89645a', flight: 'FDB1073 ', r: 'A6-FNC', t: 'B38M', category: 'A3', alt_baro: 30_000, lat: 29.95, lon: 38.12, squawk: '7700', ...o,
})

/** An event as the log holds it. */
const event = (o: Partial<AlertEvent> = {}): AlertEvent => ({
  id: `a00001-${T0}`, hex: 'a00001', kind: 'squawk', callsign: null, reg: null, type: null, squawk: '7700', emergency: null, drop: null,
  lat: null, lon: null, altFt: null, openedMs: T0, lastMs: T0, late: false, quiet: false, ...o,
})

/** The events written to a day file, in order (none when there is no file yet). */
function lines(dir: string, day = '2026-09-30'): AlertEvent[] {
  let text = ''
  try {
    text = readFileSync(join(dir, `${day}.jsonl`), 'utf8')
  } catch {
    // no file yet
  }
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as AlertEvent)
}

type Slices = Parameters<typeof encodeHeatmap>[0]
interface Plane {
  hex: string
  alt?: (s: number) => number | null // its altitude s seconds into the slot, null: no position then; default 31,000 ft
  lat?: number
  lon?: number
  idents?: { s: number; squawk: string }[]
}

/** A half-hour file of these aircraft: a position every 10 s while one has an altitude, and the ident records asked for. */
function heat(planes: Plane[], slot = SLOT): Uint8Array {
  const slices: Slices = []
  for (let s = 0; s < 1800; s += 10) {
    const records: Slices[number]['records'] = []
    for (const p of planes) {
      const ft = p.alt === undefined ? 31_000 : p.alt(s)
      if (ft !== null) records.push({ hex: p.hex, lat: p.lat ?? 40, lon: p.lon ?? -70, alt: ft, gs: 450 })
      for (const i of p.idents ?? []) if (i.s === s) records.push({ hex: p.hex, callsign: 'AAL1', squawk: i.squawk })
    }
    slices.push({ tMs: slot + s * 1000, records })
  }
  return encodeHeatmap(slices)
}

/** Level at `top`, then from atS 180 ft/s (10,800 fpm) until fallFt is lost: a fall that any retune of the rules still takes. */
const plunge = (top: number, atS: number, fallFt = 18_000) => (s: number): number => Math.max(top - fallFt, s < atS ? top : top - 180 * (s - atS))

/** Level, then 4,700 ft lost in the last 30 s (9,400 fpm) and no position after it: a dive then lost. */
const dive = (s: number): number | null => (s > 1300 ? null : s < 1270 ? 34_700 : 34_700 - ((s - 1270) / 30) * 4700)

test('a squawk counts once it is seen again 25 s or more after it was first seen; then one event opens and is pushed', () => {
  const { a, pushed } = setup()
  a.observe(ac(), T0)
  a.observe(ac(), T0 + 10_000)
  assert.equal(a.reply().events.length, 0)
  a.observe(ac(), T0 + 30_000)
  const [e] = a.reply().events
  assert.equal(a.reply().events.length, 1)
  assert.equal(e.id, `89645a-${T0}`)
  assert.deepEqual([e.kind, e.squawk, e.callsign, e.reg, e.type, e.openedMs, e.lastMs, e.late, e.quiet], ['squawk', '7700', 'FDB1073', 'A6-FNC', 'B38M', T0, T0 + 30_000, false, false])
  assert.deepEqual([e.lat, e.lon, e.altFt], [29.95, 38.12, 30_000])
  assert.equal(pushed.length, 1)
})

test('a first sighting not seen again within 2 min is forgotten', () => {
  const { a } = setup()
  a.observe(ac(), T0)
  a.observe(ac(), T0 + 130_000)
  a.observe(ac(), T0 + 140_000)
  assert.equal(a.reply().events.length, 0)
  a.observe(ac(), T0 + 160_000)
  assert.equal(a.reply().events[0].openedMs, T0 + 130_000)
})

test('not read: off, on the ground, a surface vehicle, a placeholder or non-ICAO address, lifeguard, reserved, other codes', () => {
  const off = setup({ on: false })
  for (const t of [T0, T0 + 30_000]) off.a.observe(ac(), t)
  assert.equal(off.a.reply().events.length, 0)
  const { a } = setup()
  const no: Partial<ReadsbAircraft>[] = [
    { alt_baro: 'ground' }, { category: 'C2' }, { hex: '000001' }, { hex: '~89645a' },
    { squawk: '1000', emergency: 'lifeguard' }, { squawk: '1000', emergency: 'reserved' }, { squawk: '2000' },
  ]
  for (const o of no) for (const t of [T0, T0 + 30_000]) a.observe(ac(o), t)
  assert.equal(a.reply().events.length, 0)
})

test('an ADS-B emergency status without a code is an event; a light aircraft\'s radio failure is quiet (not pushed)', () => {
  const { a, pushed } = setup()
  for (const t of [T0, T0 + 30_000]) a.observe(ac({ squawk: '1000', emergency: 'minfuel' }), t)
  assert.equal(a.reply().events[0].kind, 'status')
  assert.equal(a.reply().events[0].emergency, 'minfuel')
  for (const t of [T0, T0 + 30_000]) a.observe(ac({ hex: '4c1234', squawk: '7600', category: 'A1' }), t)
  const quiet = a.reply().events.find((e) => e.hex === '4c1234')!
  assert.equal(quiet.quiet, true)
  assert.equal(pushed.length, 1, 'the minfuel event only')
})

test('one event per episode: a new cause updates it and is pushed; 30 min without a cause, a new one opens', () => {
  const { a, pushed } = setup()
  for (const t of [T0, T0 + 30_000]) a.observe(ac(), t)
  a.observe(ac({ emergency: 'unlawful', squawk: '7700' }), T0 + 60_000)
  a.observe(ac({ emergency: 'unlawful', squawk: '7500' }), T0 + 90_000)
  assert.equal(a.reply().events.length, 1)
  const e = a.reply().events[0]
  assert.deepEqual([e.squawk, e.emergency, e.lastMs], ['7500', 'unlawful', T0 + 90_000])
  assert.equal(pushed.length, 3, 'opened, unlawful, 7500')
  a.observe(ac(), T0 + 90_000 + 31 * 60_000)
  a.observe(ac(), T0 + 90_000 + 32 * 60_000)
  assert.equal(a.reply().events.length, 2)
})

test('the rev changes with the switch, an opening, a new cause, and otherwise 30 s at most after it last changed', () => {
  const { a, clock } = setup()
  const r0 = a.rev
  for (const t of [T0, T0 + 30_000]) {
    clock.t = t
    a.observe(ac(), t)
  }
  const r1 = a.rev
  assert.ok(r1 > r0)
  clock.t = T0 + 40_000
  a.observe(ac(), clock.t)
  assert.equal(a.rev, r1, '10 s after it last changed')
  clock.t = T0 + 60_000
  a.observe(ac(), clock.t)
  assert.ok(a.rev > r1, '30 s after it last changed')
  const r2 = a.rev
  a.setOn(false)
  assert.ok(a.rev > r2)
})

test('the log: the switch and the events come back after a restart; a torn line is skipped', () => {
  const dir = tmp()
  const one = setup({ dir })
  for (const t of [T0, T0 + 30_000]) one.a.observe(ac(), t)
  writeFileSync(join(dir, '2026-09-30.jsonl'), readFileSync(join(dir, '2026-09-30.jsonl'), 'utf8') + '{"id": "torn\n')
  const two = new Alerts({ dir, nowMs: () => T0 + 60_000, sweep: true })
  assert.equal(two.on, true)
  assert.deepEqual(two.reply().events.map((e) => e.id), [`89645a-${T0}`])
  two.observe(ac(), T0 + 90_000) // its event of the last 30 min takes it in
  assert.equal(two.reply().events.length, 1)
  assert.deepEqual(readdirSync(dir).sort(), ['2026-09-30.jsonl', 'state.json'])
})

test('squawks(): the codes while on, none while off', () => {
  const { a } = setup({ codes: ['7700', '2000'] })
  assert.deepEqual(a.squawks(), ['7700', '2000'])
  a.setOn(false)
  assert.deepEqual(a.squawks(), [])
})

/** A polled aircraft's samples every 10 s: altitude f(t), t in s from T0. */
function samples(f: (t: number) => number, toS: number, o: Partial<Sample> = {}): Sample[] {
  const out: Sample[] = []
  for (let t = 0; t <= toS; t += 10) {
    const ft = f(t)
    const next = f(t + 10)
    out.push({
      hex: '738a10', tMs: T0 + t * 1000, rxMs: T0 + t * 1000, lat: 32, lon: 35, onGround: false, altBaroFt: ft, altGeomFt: null,
      gsKt: 450, trackDeg: 90, trueHeadingDeg: null, rollDeg: null, baroRateFpm: (next - ft) * 6, geomRateFpm: null, navQnhHpa: null,
      version: 2, nic: 8, quality: 'adsb2', nM: 0, callsign: 'ELY1', typeCode: 'B738', reg: '4X-EKA', category: 'A3', ...o,
    })
  }
  return out
}

test('sample: a live emergency descent opens a descent event (pushed); a military or light aircraft, or a slow one, does not', () => {
  const { a, pushed } = setup()
  const fall = (t: number): number => (t < 50 ? 35_000 : Math.max(22_000, 35_000 - 110 * (t - 50)))
  const s = samples(fall, 200)
  for (let i = 0; i < s.length; i++) a.sample(s[i], () => s.slice(0, i + 1))
  const [e] = a.reply().events
  assert.equal(e.kind, 'descent')
  assert.equal(e.drop!.fromFt, 35_000)
  assert.ok(e.drop!.fromFt - e.drop!.toFt >= 10_000)
  assert.equal(e.openedMs, T0 + 50_000)
  assert.equal(pushed.length, 1)
  const b = setup()
  const light = samples(fall, 200, { category: 'A1' })
  for (let i = 0; i < light.length; i++) b.a.sample(light[i], () => light.slice(0, i + 1))
  const military = samples(fall, 200, { hex: '738a11' })
  for (let i = 0; i < military.length; i++) b.a.sample(military[i], () => military.slice(0, i + 1), 1)
  const slow = samples((t) => 35_000 - 40 * t, 300, { hex: '738a12' })
  for (let i = 0; i < slow.length; i++) b.a.sample(slow[i], () => slow.slice(0, i + 1))
  assert.equal(b.a.reply().events.length, 0)
})

test('sample: the track is asked for only at a baro_rate of -3,000 fpm or steeper', () => {
  const { a } = setup()
  let asked = 0
  const [s] = samples(() => 35_000, 0)
  a.sample({ ...s, baroRateFpm: -2000 }, () => (asked++, [s]))
  a.sample({ ...s, baroRateFpm: null }, () => (asked++, [s]))
  assert.equal(asked, 0)
  a.sample({ ...s, baroRateFpm: -3000 }, () => (asked++, [s]))
  assert.equal(asked, 1)
})

test('scanSlot: late events for two emergency idents, an emergency descent and a dive then lost; each half hour once', () => {
  const slot = Date.UTC(2026, 8, 30, 5, 0)
  const slices: Parameters<typeof encodeHeatmap>[0] = []
  for (let s = 0; s < 1800; s += 10) {
    const records: Parameters<typeof encodeHeatmap>[0][number]['records'] = []
    // 7700 sent at 600 s and 660 s, airborne
    records.push({ hex: 'a00001', lat: 40, lon: -70, alt: 31_000, gs: 450 })
    if (s === 600 || s === 660) records.push({ hex: 'a00001', callsign: 'AAL1', squawk: '7700' })
    // a dive from 34,700 ft to 30,000 ft in 30 s, at 1300 s, then nothing
    if (s <= 1300) records.push({ hex: 'a00002', lat: 41, lon: -71, alt: s < 1270 ? 34_700 : 34_700 - ((s - 1270) / 30) * 4700, gs: 450 })
    // an emergency descent: 12,000 ft in 110 s from FL360 at 200 s, then level
    records.push({ hex: 'a00003', lat: 42, lon: -72, alt: s < 200 ? 36_000 : Math.max(24_000, 36_000 - ((s - 200) / 110) * 12_000), gs: 450 })
    // a light aircraft falling the same way from 14,000 ft: none, as it never reaches FL150 (its table category is not used)
    records.push({ hex: 'a00004', lat: 43, lon: -73, alt: s < 200 ? 14_000 : Math.max(2_000, 14_000 - ((s - 200) / 110) * 12_000), gs: 100 })
    slices.push({ tMs: slot + s * 1000, records })
  }
  const { a, pushed } = setup({ typeOf: (hex) => (hex === 'a00004' ? { type: 'C208', category: 'A1' } : { type: 'B738', category: 'A3' }) })
  a.scanSlot(encodeHeatmap(slices), slot)
  const events = a.reply().events
  const by = (hex: string): AlertEvent | undefined => events.find((e) => e.hex === hex)
  assert.deepEqual([by('a00001')?.kind, by('a00001')?.squawk, by('a00001')?.late, by('a00001')?.openedMs], ['squawk', '7700', true, slot + 600_000])
  assert.equal(by('a00002')?.kind, 'dive')
  assert.equal(by('a00002')?.drop?.lost, true)
  assert.equal(by('a00003')?.kind, 'descent')
  assert.equal(by('a00003')?.drop?.lost, false)
  assert.equal(by('a00003')?.type, 'B738')
  assert.equal(by('a00004'), undefined)
  assert.equal(pushed.length, 3)
  a.scanSlot(encodeHeatmap(slices), slot)
  assert.equal(a.reply().events.length, 3)
})

test('scanSlot: a late finding for an aircraft with an event within 30 min joins that event', () => {
  const slot = Date.UTC(2026, 8, 30, 5, 0)
  const { a } = setup()
  const hex = 'a00001'
  for (const t of [slot + 500_000, slot + 530_000]) a.observe(ac({ hex }), t)
  const slices: Parameters<typeof encodeHeatmap>[0] = []
  for (let s = 0; s < 1800; s += 10) {
    const records: Parameters<typeof encodeHeatmap>[0][number]['records'] = [{ hex, lat: 40, lon: -70, alt: 31_000, gs: 450 }]
    if (s === 600 || s === 660) records.push({ hex, callsign: 'AAL1', squawk: '7700' })
    slices.push({ tMs: slot + s * 1000, records })
  }
  a.scanSlot(encodeHeatmap(slices), slot)
  assert.equal(a.reply().events.length, 1)
  assert.equal(a.reply().events[0].late, false)
})

test('scanSlot: a late finding from over 30 min before the aircraft\'s newest event is an event of its own; the live episode stays one event', () => {
  const slot = Date.UTC(2026, 8, 30, 5, 30)
  const hex = 'a00001'
  const { a, clock, pushed } = setup()
  for (const t of [slot + 40 * 60_000, slot + 40.5 * 60_000]) {
    clock.t = t
    a.observe(ac({ hex }), t) // live, from 06:10
  }
  const slices: Parameters<typeof encodeHeatmap>[0] = []
  for (let s = 0; s < 1800; s += 10) {
    const records: Parameters<typeof encodeHeatmap>[0][number]['records'] = [{ hex, lat: 40, lon: -70, alt: 31_000, gs: 450 }]
    if (s === 300 || s === 360) records.push({ hex, callsign: 'AAL1', squawk: '7700' }) // 05:35 and 05:36
    slices.push({ tMs: slot + s * 1000, records })
  }
  a.scanSlot(encodeHeatmap(slices), slot)
  assert.equal(a.reply().events.length, 2, 'the live event and the late one')
  for (const t of [slot + 41 * 60_000, slot + 41.5 * 60_000]) {
    clock.t = t
    a.observe(ac({ hex }), t) // still squawking
  }
  assert.equal(a.reply().events.length, 2, 'no third event for the live episode')
  assert.equal(pushed.length, 2)
})

test('ntfyPush: one POST with an ASCII title, an urgent or high priority, and the text', async () => {
  const asked: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init: init! })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const push = ntfyPush('https://ntfy.sh/fh-test-topic', fetchFn)
  const e: AlertEvent = {
    id: 'x', hex: '89645a', kind: 'squawk', callsign: 'FDB1073', reg: null, type: 'B38M', squawk: '7700', emergency: null, drop: null,
    lat: 29.95, lon: 38.12, altFt: 30_000, openedMs: T0, lastMs: T0, late: false, quiet: false,
  }
  push(e)
  push({ ...e, squawk: '7600' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(asked.length, 2)
  assert.equal(asked[0].url, 'https://ntfy.sh/fh-test-topic')
  assert.equal(asked[0].init.method, 'POST')
  const h = new Headers(asked[0].init.headers)
  assert.equal(h.get('Title'), 'Emergency - 7700: FDB1073 - B38M')
  assert.equal(h.get('Priority'), 'urgent')
  assert.equal(new Headers(asked[1].init.headers).get('Priority'), 'high')
  assert.equal(asked[0].init.body, 'FL300 at 29.95 N 38.12 E, 05:31 UTC')
})

// ---- fix round 1 ----

// 1. A late finding or any sighting joins the event of its aircraft that its whole span is near

test('late: a finding that began over 30 min before a live event opened, and ended within 30 min of it, joins that event', () => {
  const hex = 'a00001'
  const { a, clock, pushed } = setup()
  for (const t of [at(50), at(50, 30)]) {
    clock.t = t
    a.observe(ac({ hex }), t) // live from 05:50
  }
  a.scanSlot(heat([{ hex, idents: [{ s: 0, squawk: '7700' }, { s: 1700, squawk: '7700' }] }]), SLOT) // 7700 from 05:00:00 to 05:28:20
  assert.equal(a.reply().events.length, 1)
  assert.equal(a.reply().events[0].late, false)
  assert.equal(pushed.length, 1, 'no second push')
})

test('late: of an aircraft\'s two events over 30 min apart, a finding joins the one its span is near, not the newest', () => {
  const hex = 'a00001'
  const { a, clock, pushed } = setup()
  for (const t of [at(10), at(10, 30), at(75), at(75, 30)]) {
    clock.t = t
    a.observe(ac({ hex }), t) // live at 05:10 and at 06:15
  }
  assert.equal(a.reply().events.length, 2)
  a.scanSlot(heat([{ hex, idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }] }]), SLOT) // 7700 at 05:10 and 05:11
  assert.equal(a.reply().events.length, 2)
  assert.equal(pushed.length, 2, 'no push for the finding')
  assert.equal(a.reply().events.find((e) => e.openedMs === at(10))?.lastMs, at(11), 'the first event took it in')
})

test('late: an older episode found in two half hours stays one event while a newer live event of the aircraft exists', () => {
  const hex = 'a00001'
  const { a, clock, pushed } = setup()
  for (const t of [at(75), at(75, 30)]) {
    clock.t = t
    a.observe(ac({ hex }), t) // live at 06:15
  }
  a.scanSlot(heat([{ hex, idents: [{ s: 1200, squawk: '7700' }, { s: 1500, squawk: '7700' }] }]), SLOT) // 7700 from 05:20 to 05:25
  assert.equal(a.reply().events.length, 2)
  const next = SLOT + 30 * 60_000
  a.scanSlot(heat([{ hex, idents: [{ s: 60, squawk: '7700' }, { s: 180, squawk: '7700' }] }], next), next) // and from 05:31 to 05:33
  assert.equal(a.reply().events.length, 2, 'the second half hour joined the older event')
  assert.equal(a.reply().events.find((e) => e.late)?.lastMs, at(33))
  assert.equal(pushed.length, 2, 'the live event and the late one')
})

test('late: a finding that is near two events of its aircraft joins the one seen last', () => {
  const hex = 'a00001'
  const { a, clock, pushed } = setup()
  for (const t of [at(10), at(10, 30), at(55), at(55, 30)]) {
    clock.t = t
    a.observe(ac({ hex, squawk: '1000', emergency: 'minfuel' }), t) // live, a status only, at 05:10 and at 05:55
  }
  const next = SLOT + 30 * 60_000
  a.scanSlot(heat([{ hex, idents: [{ s: 300, squawk: '7700' }, { s: 900, squawk: '7700' }] }], next), next) // 7700 from 05:35 to 05:45
  const squawkOf = (openedMs: number): string | null | undefined => a.reply().events.find((e) => e.openedMs === openedMs)?.squawk
  assert.equal(a.reply().events.length, 2)
  assert.deepEqual([squawkOf(at(10)), squawkOf(at(55))], [null, '7700'])
  assert.equal(pushed.length, 3, 'two openings and the new cause')
})

test('late: after a restart, a rescan of the same half hour joins the events read from the log (no new event, no push)', () => {
  const dir = tmp()
  const file = heat([
    { hex: 'a00001', idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }] },
    { hex: 'a00002', lat: 41, alt: plunge(36_000, 1000) },
    { hex: 'a00003', lat: 42, alt: dive },
  ])
  const one = setup({ dir })
  one.a.scanSlot(file, SLOT)
  assert.equal(one.pushed.length, 3)
  const two = setup({ dir })
  assert.equal(two.a.reply().events.length, 3)
  two.a.scanSlot(file, SLOT)
  assert.equal(two.a.reply().events.length, 3)
  assert.equal(two.pushed.length, 0)
})

// 2. A late merge never overwrites a newer squawk or status with an older one

test('an older code is not a new cause: a late 7600 from before a live 7700\'s newest sighting changes nothing (no rev, no write, no push)', () => {
  const hex = 'a00001'
  const { a, clock, pushed, dir } = setup()
  for (const t of [at(15), at(16)]) {
    clock.t = t
    a.observe(ac({ hex }), t) // live 7700, newest at 05:16
  }
  const rev = a.rev
  const written = lines(dir).length
  a.scanSlot(heat([{ hex, idents: [{ s: 600, squawk: '7600' }, { s: 660, squawk: '7600' }] }]), SLOT) // 7600 at 05:10 and 05:11
  const [e] = a.reply().events
  assert.equal(a.reply().events.length, 1)
  assert.deepEqual([e.squawk, e.lastMs], ['7700', at(16)])
  assert.equal(pushed.length, 1)
  assert.equal(lines(dir).length, written)
  assert.equal(a.rev, rev)
})

test('an older status does not overwrite a newer one either', () => {
  const { a, clock, pushed } = setup()
  for (const t of [at(15), at(16)]) {
    clock.t = t
    a.observe(ac({ squawk: '1000', emergency: 'general' }), t)
  }
  a.observe(ac({ squawk: '1000', emergency: 'unlawful' }), at(15, 30)) // an answer from before its newest sighting
  assert.equal(a.reply().events[0].emergency, 'general')
  assert.equal(pushed.length, 1)
})

test('an older code still fills a squawk or status the event has none of: a new cause, pushed', () => {
  const hex = 'a00001'
  const { a, clock, pushed } = setup()
  for (const t of [at(15), at(16)]) {
    clock.t = t
    a.observe(ac({ hex, squawk: '1000', emergency: 'minfuel' }), t) // a status only
  }
  a.scanSlot(heat([{ hex, idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }] }]), SLOT) // 7700 at 05:10 and 05:11
  const [e] = a.reply().events
  assert.deepEqual([e.squawk, e.emergency, e.lastMs], ['7700', 'minfuel', at(16)])
  assert.equal(pushed.length, 2)
})

// 3. A bigger fall is written promptly

test('a fall that keeps growing is written within 30 s of each growth (new rev, no push): a restart reads it at its final size', () => {
  const dir = tmp()
  const { a, clock, pushed } = setup({ dir })
  const s = samples(plunge(36_000, 50, 27_000), 260) // 27,000 ft lost over 150 s
  let overS = 0
  let grown = 0
  for (let i = 0; i < s.length; i++) {
    clock.t = s[i].tMs
    const rev = a.rev
    a.sample(s[i], () => s.slice(0, i + 1))
    const now = a.reply().events[0]?.drop?.overS ?? 0
    if (overS > 0 && now > overS) {
      grown++
      assert.ok(a.rev > rev, `the rev changes when the fall grows (at ${(s[i].tMs - T0) / 1000} s)`)
    }
    overS = now
  }
  assert.ok(grown >= 3, 'the fall kept growing')
  assert.equal(pushed.length, 1, 'only the opening is pushed')
  const final = a.reply().events[0].drop!
  const read = new Alerts({ dir, nowMs: () => clock.t, sweep: true }).reply().events[0].drop!
  assert.ok(final.overS - read.overS < 30, `the log is ${final.overS - read.overS} s short of the fall`)
})

// 4. A torn last line cannot swallow the next one

test('the log: a last line cut short, with no newline, does not swallow the next line written', () => {
  const dir = tmp()
  const one = setup({ dir })
  for (const t of [T0, T0 + 30_000]) one.a.observe(ac(), t)
  const file = join(dir, '2026-09-30.jsonl')
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"id": "torn`) // a write cut short: no newline
  const two = setup({ dir })
  assert.deepEqual(two.a.reply().events.map((e) => e.hex), ['89645a'])
  for (const t of [T0, T0 + 30_000]) two.a.observe(ac({ hex: '4c1234' }), t)
  const three = setup({ dir })
  assert.deepEqual(three.a.reply().events.map((e) => e.hex).sort(), ['4c1234', '89645a'])
})

// 5. A failed write is retried at the next change

test('the log: a write that failed is tried again at the next sighting, not after the 5 min between writes', (t) => {
  const err = t.mock.method(console, 'error', () => {})
  const { a, clock, dir } = setup()
  const day = join(dir, '2026-09-30.jsonl')
  mkdirSync(day) // a directory where the file belongs: the append fails
  for (const x of [T0, T0 + 30_000]) {
    clock.t = x
    a.observe(ac(), x) // opens: its write fails
  }
  assert.equal(err.mock.callCount(), 1)
  assert.equal(err.mock.calls[0].arguments[0], 'alerts: write failed:')
  assert.equal(a.reply().events.length, 1, 'the event stays in memory')
  rmSync(day, { recursive: true })
  clock.t = T0 + 40_000
  a.observe(ac(), clock.t) // 10 s on, nothing new: but nothing was written yet
  assert.deepEqual(lines(dir).map((e) => e.lastMs), [T0 + 40_000])
})

// 6. The ignore list applies to every path

test('sample: not read for 000000 and 000001 or a surface vehicle (C1 to C3), as observe does', () => {
  const fall = plunge(36_000, 50)
  const fed = (o: Partial<Sample>): number => {
    const { a } = setup()
    const s = samples(fall, 200, o)
    for (let i = 0; i < s.length; i++) a.sample(s[i], () => s.slice(0, i + 1))
    return a.reply().events.length
  }
  assert.equal(fed({}), 1, 'the same fall of an ordinary aircraft is an event')
  for (const o of [{ hex: '000001' }, { hex: '000000' }, { category: 'C1' }, { category: 'C2' }, { category: 'C3' }]) assert.equal(fed(o), 0, JSON.stringify(o))
})

test('scanSlot: an aircraft the type table calls a surface vehicle is not read, nor are the placeholder addresses', () => {
  const both = { idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }], alt: plunge(36_000, 1000) }
  const { a } = setup({ typeOf: (hex) => ({ type: null, category: hex === 'a00001' ? 'C2' : 'A3' }) })
  a.scanSlot(heat([{ hex: 'a00001', ...both }, { hex: '000001', ...both }, { hex: 'a00002', ...both }]), SLOT)
  assert.deepEqual(a.reply().events.map((e) => e.hex), ['a00002'])
})

// 7. Callbacks cannot break the caller

test('a push that throws costs the event nothing and is logged once a minute', (t) => {
  const err = t.mock.method(console, 'error', () => {})
  const { a, clock, dir } = setup({
    push: () => {
      throw new Error('ntfy is down')
    },
  })
  for (const hex of ['a00001', 'a00002']) {
    for (const x of [T0, T0 + 30_000]) {
      clock.t = x
      a.observe(ac({ hex }), x)
    }
  }
  assert.deepEqual(a.reply().events.map((e) => e.hex).sort(), ['a00001', 'a00002'])
  assert.equal(lines(dir).length, 2, 'both are in the log')
  assert.equal(err.mock.callCount(), 1)
  assert.equal(err.mock.calls[0].arguments[0], 'alerts: push failed:')
  assert.match(String(err.mock.calls[0].arguments[1]), /ntfy is down/)
  for (const x of [T0 + 100_000, T0 + 130_000]) {
    clock.t = x
    a.observe(ac({ hex: 'a00003' }), x)
  }
  assert.equal(err.mock.callCount(), 2, 'a minute on, it is logged again')
})

test('scanSlot: a type lookup that throws counts as no type for that aircraft; the others are still found', (t) => {
  const err = t.mock.method(console, 'error', () => {})
  const file = heat([
    { hex: 'a00001', idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }] },
    { hex: 'a00002', lat: 41, alt: plunge(36_000, 1000) },
  ])
  const { a } = setup({
    typeOf: (hex) => {
      if (hex === 'a00001') throw new Error('no table')
      return { type: 'B738', category: 'A3' }
    },
  })
  a.scanSlot(file, SLOT)
  const by = (hex: string): AlertEvent | undefined => a.reply().events.find((e) => e.hex === hex)
  assert.deepEqual([by('a00001')?.kind, by('a00001')?.type], ['squawk', null])
  assert.deepEqual([by('a00002')?.kind, by('a00002')?.type], ['descent', 'B738'])
  assert.equal(err.mock.callCount(), 1)
})

test('the log: a line that parses but is not an event is skipped', () => {
  const dir = tmp()
  const drop = { fromFt: 36_000, toFt: 18_000, overS: 100, lost: false }
  const good = [event({ id: 'a00001-1', hex: 'a00001' }), event({ id: 'a00002-1', hex: 'a00002', kind: 'descent', drop })]
  const defects: Record<string, unknown>[] = [
    { kind: 7 }, { kind: undefined }, { id: 5 }, { hex: null }, { openedMs: '1' }, { lastMs: undefined }, { late: 'no' }, { quiet: 0 },
    { drop: undefined }, { drop: 'fell' }, { drop: { ...drop, toFt: 'low' } }, { drop: { ...drop, overS: undefined } }, { callsign: 7 }, { lat: '1' },
  ]
  const bad: unknown[] = [...defects.map((d, i) => ({ ...event({ id: `bad-${i}` }), ...d })), null, [], 7, 'x'] // each has its own id
  writeFileSync(join(dir, '2026-09-30.jsonl'), [...bad, ...good].map((e) => `${JSON.stringify(e)}\n`).join(''))
  assert.deepEqual(new Alerts({ dir, nowMs: () => T0, sweep: true }).reply().events.map((e) => e.id).sort(), ['a00001-1', 'a00002-1'])
})

// 8. A live sighting of a late event clears late

test('late: a live sighting of a late event clears late, is written and is not pushed; a later late finding does not set it again', () => {
  const hex = 'a00001'
  const { a, clock, pushed, dir } = setup()
  clock.t = at(31)
  a.scanSlot(heat([{ hex, idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }] }]), SLOT) // found late: 05:10 to 05:11
  assert.equal(a.reply().events[0].late, true)
  assert.equal(ongoing(a.reply().events[0], clock.t), false)
  const rev = a.rev
  clock.t = at(31, 10)
  a.observe(ac({ hex }), clock.t) // heard live, on 7700
  const [e] = a.reply().events
  assert.equal(a.reply().events.length, 1)
  assert.equal(e.late, false)
  assert.equal(ongoing(e, clock.t), true)
  assert.ok(a.rev > rev)
  assert.equal(lines(dir).at(-1)?.late, false)
  assert.equal(pushed.length, 1, 'no second push')
  const next = SLOT + 30 * 60_000
  clock.t = at(33)
  a.scanSlot(heat([{ hex, idents: [{ s: 60, squawk: '7700' }, { s: 120, squawk: '7700' }] }], next), next) // 7700 at 05:31 and 05:32, found late
  assert.equal(a.reply().events.length, 1)
  assert.equal(a.reply().events[0].late, false)
})

test('late: a live fall of an aircraft with a late event clears late too, and is a new cause (pushed)', () => {
  const hex = 'a00001'
  const { a, clock, pushed } = setup()
  a.scanSlot(heat([{ hex, idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }] }]), SLOT) // found late: 05:10 to 05:11
  assert.equal(a.reply().events[0].late, true)
  const s = samples(plunge(36_000, 50), 200, { hex })
  for (let i = 0; i < s.length; i++) {
    clock.t = s[i].tMs
    a.sample(s[i], () => s.slice(0, i + 1))
  }
  const [e] = a.reply().events
  assert.equal(a.reply().events.length, 1)
  assert.deepEqual([e.late, e.drop !== null], [false, true])
  assert.equal(pushed.length, 2, 'the late squawk, then the fall')
})

// 9. The late path does not trust the type table's category for "light"

test('scanSlot: a late 7600 of a type the table calls light (the ATR 72 is A1 there) is not quiet, and is pushed', () => {
  const { a, pushed } = setup({ typeOf: () => ({ type: 'AT76', category: 'A1' }) })
  a.scanSlot(heat([{ hex: 'a00001', idents: [{ s: 600, squawk: '7600' }, { s: 660, squawk: '7600' }] }]), SLOT)
  const [e] = a.reply().events
  assert.deepEqual([e.kind, e.squawk, e.type, e.quiet], ['squawk', '7600', 'AT76', false])
  assert.equal(pushed.length, 1)
})

test('scanSlot: a late fall of a type the table calls light (the Dash 8 is A1 there) is found', () => {
  const { a, pushed } = setup({ typeOf: () => ({ type: 'DH8D', category: 'A1' }) })
  a.scanSlot(heat([{ hex: 'a00001', alt: plunge(36_000, 600) }]), SLOT)
  assert.equal(a.reply().events.length, 1)
  const [e] = a.reply().events
  assert.deepEqual([e.kind, e.type, e.drop?.lost], ['descent', 'DH8D', false])
  assert.equal(pushed.length, 1)
})

// 10. The cheap test first in scanSlot

test('scanSlot: the type table is asked only for an aircraft with two idents or a fall that its altitudes may hold', () => {
  const asked: string[] = []
  const file = heat([
    { hex: 'a00001' }, // cruising, no idents
    { hex: 'a00002', idents: [{ s: 600, squawk: '7700' }] }, // one ident
    { hex: 'a00003', idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }] },
    { hex: 'a00004', alt: plunge(36_000, 1000) },
  ])
  const { a } = setup({
    typeOf: (hex) => {
      asked.push(hex)
      return { type: null, category: null }
    },
  })
  a.scanSlot(file, SLOT)
  assert.deepEqual(asked.sort(), ['a00003', 'a00004'])
})

// Coverage

test('the log: a sighting with nothing new is written 5 min or more after the last write', () => {
  const { a, clock, dir } = setup()
  for (const t of [T0, T0 + 30_000]) {
    clock.t = t
    a.observe(ac(), t)
  }
  assert.equal(lines(dir).length, 1, 'the opening')
  for (const t of [T0 + 60_000, T0 + 120_000, T0 + 30_000 + 299_000]) {
    clock.t = t
    a.observe(ac(), t)
  }
  assert.equal(lines(dir).length, 1, 'under 5 min after it')
  clock.t = T0 + 30_000 + 300_000
  a.observe(ac(), clock.t)
  assert.deepEqual(lines(dir).map((e) => e.lastMs), [T0 + 30_000, T0 + 330_000])
  clock.t += 60_000
  a.observe(ac(), clock.t)
  assert.equal(lines(dir).length, 2, 'the 5 min count from that write')
})

test('events older than 8 days are dropped when a new one opens; the reply shows 7 days, memory keeps 8', () => {
  const { a, clock } = setup()
  const open = (hex: string, t: number): void => {
    for (const x of [t, t + 30_000]) {
      clock.t = x
      a.observe(ac({ hex }), x)
    }
  }
  const hexes = (): string[] => a.reply().events.map((e) => e.hex).sort()
  open('a00001', T0) // its newest sighting: T0 + 30 s
  open('a00002', T0 + 8 * DAY - 60_000) // it is 30 s short of 8 days old: kept
  clock.t = T0 + 60_000 // back, to read what memory holds
  assert.deepEqual(hexes(), ['a00001', 'a00002'])
  open('a00003', T0 + 8 * DAY + 60_000) // now over 8 days old: dropped
  clock.t = T0 + 60_000
  assert.deepEqual(hexes(), ['a00002', 'a00003'])
  open('a00001', T0 + 60_000) // the dropped event no longer takes its aircraft's sightings in
  assert.deepEqual(hexes(), ['a00001', 'a00002', 'a00003'])
})

test('at start, the day files of the last 8 days are read, and older ones are not', () => {
  const dir = tmp()
  const put = (day: string, hex: string): void => {
    const ms = Date.parse(`${day}T12:00:00Z`)
    writeFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(event({ id: `${hex}-${ms}`, hex, openedMs: ms, lastMs: ms }))}\n`)
  }
  put('2026-09-21', 'a00001') // 8 days and 17 h before T0
  put('2026-09-22', 'a00002')
  let now = T0
  const a = new Alerts({ dir, nowMs: () => now, sweep: true })
  now = Date.parse('2026-09-22T13:00:00Z') // back, to see what was read
  assert.deepEqual(a.reply().events.map((e) => e.hex), ['a00002'])
})

test('reply: the last 7 days only, at most 300 events, newest first', () => {
  const dir = tmp()
  const put = (events: AlertEvent[]): void => writeFileSync(join(dir, '2026-09-30.jsonl'), events.map((e) => `${JSON.stringify(e)}\n`).join(''))
  const read = (): AlertEvent[] => new Alerts({ dir, nowMs: () => T0, sweep: true }).reply().events
  put([
    event({ id: 'a00001-1', hex: 'a00001', openedMs: T0 - 7 * DAY - 5_000, lastMs: T0 - 7 * DAY }),
    event({ id: 'a00002-1', hex: 'a00002', openedMs: T0 - 7 * DAY - 5_000, lastMs: T0 - 7 * DAY - 1 }),
  ])
  assert.deepEqual(read().map((e) => e.hex), ['a00001'], 'kept to the millisecond')
  const many: AlertEvent[] = []
  for (let i = 309; i >= 0; i--) { // 310 events, the oldest written first
    const hex = (0xb00000 + i).toString(16)
    many.push(event({ id: `${hex}-${T0 - i * 1000}`, hex, openedMs: T0 - i * 1000, lastMs: T0 - i * 1000 + 500 }))
  }
  put(many)
  assert.deepEqual(read().map((e) => e.openedMs), Array.from({ length: 300 }, (_, i) => T0 - i * 1000), 'newest first, the oldest 10 cut')
})

test('the switch: off with no state.json, and off when it does not read or does not say true', () => {
  const none = new Alerts({ dir: tmp(), sweep: true })
  assert.equal(none.on, false)
  assert.deepEqual(none.squawks(), [])
  for (const text of ['', 'not json', '{"on":', '{"on":"yes"}', '{"on":1}', '[]', 'null', '{}']) {
    const dir = tmp()
    writeFileSync(join(dir, 'state.json'), text)
    assert.equal(new Alerts({ dir, sweep: true }).on, false, text)
  }
  const dir = tmp()
  writeFileSync(join(dir, 'state.json'), '{"on":true}')
  assert.equal(new Alerts({ dir, sweep: true }).on, true)
})

test('a quiet event turns loud on a 7700 and is pushed once; the next 7700 sighting is not pushed again', () => {
  const { a, clock, pushed } = setup()
  const light = (squawk: string): ReadsbAircraft => ac({ hex: '4c1234', category: 'A1', squawk })
  for (const t of [T0, T0 + 30_000]) {
    clock.t = t
    a.observe(light('7600'), t)
  }
  assert.equal(a.reply().events[0].quiet, true)
  assert.equal(pushed.length, 0)
  clock.t = T0 + 60_000
  a.observe(light('7700'), clock.t)
  assert.deepEqual([a.reply().events[0].quiet, a.reply().events[0].squawk], [false, '7700'])
  assert.deepEqual(pushed.map((e) => e.squawk), ['7700'])
  clock.t = T0 + 90_000
  a.observe(light('7700'), clock.t)
  assert.equal(pushed.length, 1)
})

test('ntfyPush: an answer that is not OK and a fetch that fails are logged; nothing is thrown or left unhandled', async (t) => {
  const err = t.mock.method(console, 'error', () => {})
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    ntfyPush('https://ntfy.sh/fh-test-topic', async () => new Response('slow down', { status: 429 }))(event())
    ntfyPush('https://ntfy.sh/fh-test-topic', () => Promise.reject(new Error('network down')))(event())
    await new Promise((r) => setTimeout(r, 20))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  assert.deepEqual(err.mock.calls.map((c) => c.arguments.join(' ')), ['alerts: ntfy answered 429', 'alerts: ntfy failed: network down'])
  assert.deepEqual(unhandled, [])
})
