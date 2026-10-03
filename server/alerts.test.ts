// server/alerts.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ongoing, type AlertDrop, type AlertEvent } from '../shared/alerts.ts'
import { SLOT_MS } from '../shared/history.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { Alerts, ntfyPush } from './alerts.ts'
import { encodeHeatmap } from './heatmap.ts'
import { SWEEP_PERIOD_MS, SWEEP_SHARE } from './poller.ts'

const T0 = Date.UTC(2026, 8, 30, 5, 31, 0)
const SLOT = Date.UTC(2026, 8, 30, 5, 0) // the 05:00 half hour
const DAY = 86_400_000
const at = (min: number, sec = 0): number => SLOT + (min * 60 + sec) * 1000 // 05:00 plus min:sec
const tmp = (): string => mkdtempSync(join(tmpdir(), 'fh-alerts-'))

type TypeOf = (hex: string) => { type: string | null; category: string | null; military?: boolean }
const LINER: TypeOf = () => ({ type: 'B738', category: 'A3' })
const NO_TYPE: TypeOf = () => ({ type: null, category: null }) // no airliner: D1_OTHER (20,000 ft) and D2_OTHER

function setup(o: {
  dir?: string
  on?: boolean
  codes?: string[]
  typeOf?: TypeOf
  push?: (e: AlertEvent) => void
  append?: (path: string, text: string) => void
} = {}) {
  const clock = { t: T0 }
  const pushed: AlertEvent[] = []
  const dir = o.dir ?? tmp()
  const push = (e: AlertEvent): void => {
    pushed.push(structuredClone(e))
    o.push?.(e)
  }
  // An airliner unless a test says otherwise: its rules (descent.ts D1, D2, D3) are the ones most tests here are about.
  const a = new Alerts({ dir, nowMs: () => clock.t, sweep: true, push, codes: o.codes, typeOf: o.typeOf ?? LINER, append: o.append })
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

test('a squawk counts once it is seen again 20 s or more after it was first seen; then one event opens and is pushed', () => {
  const { a, pushed } = setup()
  a.observe(ac(), T0)
  assert.deepEqual([a.reply().events.length, pushed.length], [0, 0], 'one sighting: a glitch, never an event by itself')
  a.observe(ac(), T0 + 10_000)
  assert.equal(a.reply().events.length, 0)
  a.observe(ac(), T0 + 30_000)
  const [e] = a.reply().events
  assert.equal(a.reply().events.length, 1)
  assert.equal(e.id, `89645a-${T0}`)
  assert.deepEqual([e.kind, e.squawk, e.callsign, e.reg, e.type, e.openedMs, e.lastMs, e.late, e.quiet], ['squawk', '7700', 'FDB1073', 'A6-FNC', 'B38M', T0, T0 + 30_000, false, false])
  assert.deepEqual([e.lat, e.lon, e.altFt], [29.95, 38.12, 30_000])
  assert.equal(pushed.length, 1)
  // The edge: 1 ms short of 20 s is a glitch still, 20 s is not.
  const edge = setup()
  edge.a.observe(ac(), T0)
  edge.a.observe(ac(), T0 + 19_999)
  assert.equal(edge.a.reply().events.length, 0, '19.999 s')
  edge.a.observe(ac(), T0 + 20_000)
  assert.equal(edge.a.reply().events.length, 1, '20 s')
  assert.equal(edge.pushed.length, 1)
})

test('a first sighting not seen again within 10 min is forgotten', () => {
  const { a } = setup()
  a.observe(ac(), T0)
  a.observe(ac(), T0 + 600_001) // 10 min and 1 ms on: a first sighting afresh
  a.observe(ac(), T0 + 610_000)
  assert.equal(a.reply().events.length, 0)
  a.observe(ac(), T0 + 630_001)
  assert.equal(a.reply().events[0].openedMs, T0 + 600_001)
  const b = setup()
  b.a.observe(ac(), T0)
  b.a.observe(ac(), T0 + 600_000) // 10 min on: still waiting for it
  assert.equal(b.a.reply().events.length, 1)
})

test('a sweep-only emergency confirms at the slowest sweep: sightings one round apart (213 s) open an event, two rounds apart too', () => {
  // adsb.fi's 0.9 req/s after three 429s: a sweep request every 1 / (0.1125 × SWEEP_SHARE) s, so each of 3 codes every 213 s
  // (poller.ts #sweepCode). Two rounds: an answer that failed skips its code for one.
  const roundMs = 3 * Math.max(SWEEP_PERIOD_MS / 3, 1000 / ((0.9 / 8) * SWEEP_SHARE))
  assert.equal(Math.round(roundMs / 1000), 213)
  for (const apart of [roundMs, 2 * roundMs]) {
    const { a, pushed } = setup()
    a.observe(ac(), T0)
    a.observe(ac(), T0 + apart)
    assert.equal(a.reply().events.length, 1, `${apart / 1000} s apart`)
    assert.equal(pushed.length, 1)
  }
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
  const fall = (t: number): number => (t < 50 ? 35_000 : Math.max(19_000, 35_000 - 140 * (t - 50)))
  const s = samples(fall, 200)
  for (let i = 0; i < s.length; i++) a.sample(s[i], () => s.slice(0, i + 1))
  const [e] = a.reply().events
  assert.equal(e.kind, 'descent')
  assert.equal(e.drop!.fromFt, 35_000)
  assert.ok(e.drop!.fromFt - e.drop!.toFt >= 15_000)
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
    // an emergency descent: 17,000 ft in 110 s from FL360 at 200 s, then level
    records.push({ hex: 'a00003', lat: 42, lon: -72, alt: s < 200 ? 36_000 : Math.max(19_000, 36_000 - ((s - 200) / 110) * 17_000), gs: 450 })
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

// 9. The late path's quiet uses the type table's category; its fall test does not

test('scanSlot: a late 7600 of a type the table calls light (a C172 is A1) is quiet: listed, not pushed; its 7700 is not quiet', () => {
  const { a, pushed } = setup({ typeOf: () => ({ type: 'C172', category: 'A1' }) })
  a.scanSlot(heat([
    { hex: 'a00001', idents: [{ s: 600, squawk: '7600' }, { s: 660, squawk: '7600' }] },
    { hex: 'a00002', idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }] },
  ]), SLOT)
  const by = (hex: string): AlertEvent | undefined => a.reply().events.find((e) => e.hex === hex)
  assert.deepEqual([by('a00001')?.squawk, by('a00001')?.type, by('a00001')?.quiet], ['7600', 'C172', true])
  assert.deepEqual([by('a00002')?.squawk, by('a00002')?.quiet], ['7700', false])
  assert.deepEqual(pushed.map((e) => e.hex), ['a00002'])
})

test('scanSlot: a late 7600 of an ATR 72 is quiet too (the table gives turboprop airliners A1): the accepted cost, as radio failures are the least urgent cause', () => {
  const { a, pushed } = setup({ typeOf: () => ({ type: 'AT76', category: 'A1' }) })
  a.scanSlot(heat([{ hex: 'a00001', idents: [{ s: 600, squawk: '7600' }, { s: 660, squawk: '7600' }] }]), SLOT)
  const [e] = a.reply().events
  assert.deepEqual([e.kind, e.squawk, e.type, e.quiet], ['squawk', '7600', 'AT76', true])
  assert.equal(pushed.length, 0)
  const loud = setup({ typeOf: () => ({ type: 'A320', category: 'A3' }) })
  loud.a.scanSlot(heat([{ hex: 'a00001', idents: [{ s: 600, squawk: '7600' }, { s: 660, squawk: '7600' }] }]), SLOT)
  assert.deepEqual([loud.a.reply().events[0].quiet, loud.pushed.length], [false, 1], 'an A3 type is not light')
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

test('scanSlot: the type table is not asked for a placeholder or a non-ICAO address: nothing is read of one', () => {
  const asked: string[] = []
  const both = { idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }], alt: plunge(36_000, 1000) } // two idents and a fall
  const { a } = setup({
    typeOf: (hex) => {
      asked.push(hex)
      return { type: null, category: null }
    },
  })
  a.scanSlot(heat([{ hex: '000000', ...both }, { hex: '000001', ...both }, { hex: '~abc123', ...both }, { hex: 'a00001', ...both }]), SLOT)
  assert.deepEqual(asked, ['a00001'])
  assert.deepEqual(a.reply().events.map((e) => e.hex), ['a00001'])
})

// ---- Task 3b: no falls for military aircraft and fighter and trainer types; an older worse code un-quiets ----

/** A polled aircraft's samples fed one at a time, each with the track so far. */
function feed(a: Alerts, s: Sample[], dbFlags = 0): void {
  for (let i = 0; i < s.length; i++) a.sample(s[i], () => s.slice(0, i + 1), dbFlags)
}

// The fighter and trainer types with no fall events (ICAO type designators), as the brief lists them.
const FAST_JETS = (
  'A4 A10 AJET AMX AV8B BT7 EUFI F1 F4 F5 F14 F15 F16 F18 F18H F18S F22 F35 F104 F117 GRIF HAWK HUNT J8 JF17 K8 KFIR L39 L59 L159 LCA ' +
  'M339 M345 M346 MG29 MG31 MIR2 MRF1 RFAL S211 SU24 SU25 SU27 SU30 SU34 SU35 SU57 T2 T38 T4 T45 T50 TEX2 TOR PC7 PC9 PC21 TUCA'
).split(' ')

test('sample: no descent event for a fighter or trainer type (F5, T38 and the others listed), however it falls; an airliner\'s same fall is one', () => {
  const run = (typeCode: string | null): number => {
    const { a } = setup()
    feed(a, samples(plunge(36_000, 50, 24_000), 200, { typeCode })) // 21,600 ft in 120 s and still falling: a fall by D1_OTHER too
    return a.reply().events.length
  }
  assert.equal(FAST_JETS.length, 58)
  assert.equal(run('B738'), 1)
  assert.equal(run('F15X'), 1, 'a type that is not listed')
  assert.equal(run(null), 1, 'no type is no exclusion')
  for (const type of FAST_JETS) assert.equal(run(type), 0, type)
})

test('sample: no descent event for an aircraft the type table calls military, whatever dbFlags says; a missing military is false', () => {
  const run = (typeOf: TypeOf): number => {
    const { a } = setup({ typeOf })
    feed(a, samples(plunge(36_000, 50), 200))
    return a.reply().events.length
  }
  assert.equal(run(() => ({ type: 'B738', category: 'A3', military: true })), 0)
  assert.equal(run(() => ({ type: 'B738', category: 'A3', military: false })), 1)
  assert.equal(run(() => ({ type: 'B738', category: 'A3' })), 1)
})

test('sample: the type table is asked only for a sample whose track is checked, and a lookup that throws counts as no type', (t) => {
  const err = t.mock.method(console, 'error', () => {})
  const asked: string[] = []
  const { a } = setup({
    typeOf: (hex) => {
      asked.push(hex)
      throw new Error('no table')
    },
  })
  const [s] = samples(() => 35_000, 0)
  a.sample({ ...s, baroRateFpm: -2000 }, () => [s])
  assert.deepEqual(asked, [], 'not steep enough')
  feed(a, samples(plunge(36_000, 50), 200))
  assert.ok(asked.length > 0)
  assert.equal(a.reply().events.length, 1, 'the fall is found')
  assert.equal(err.mock.callCount(), 1)
  assert.equal(err.mock.calls[0].arguments[0], 'alerts: type lookup failed:')
})

test('sample: the type table is asked last: not for a military dbFlags or a fast-jet type code, which decide without it', () => {
  const asked: string[] = []
  const typeOf: TypeOf = (hex) => {
    asked.push(hex)
    return { type: null, category: null }
  }
  feed(setup({ typeOf }).a, samples(plunge(36_000, 50), 200), 1)
  feed(setup({ typeOf }).a, samples(plunge(36_000, 50), 200, { typeCode: 'F5' }))
  assert.deepEqual(asked, [])
  feed(setup({ typeOf }).a, samples(plunge(36_000, 50), 200))
  assert.ok(asked.length > 0, 'an airliner is asked')
})

/** Level, then 5,400 ft lost in the last 30 s (10,800 fpm) and no position after it: a dive then lost by D2_OTHER too. */
const steepDive = (s: number): number | null => (s > 1300 ? null : s < 1270 ? 34_700 : 34_700 - 180 * (s - 1270))
/** Three aircraft in one half hour: a descent, a dive then lost, and a descent after 7700 sent twice. Falls that the rules of both kinds take. */
const fallers = (): Uint8Array =>
  heat([
    { hex: 'a00001', alt: plunge(36_000, 1000, 22_000) },
    { hex: 'a00002', lat: 41, alt: steepDive },
    { hex: 'a00003', lat: 42, alt: plunge(36_000, 1000, 22_000), idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }] },
  ])
/** What a late scan finds with this type table: [hex, kind, has a fall]. */
function found(typeOf: TypeOf): [string, string, boolean][] {
  const { a } = setup({ typeOf })
  a.scanSlot(fallers(), SLOT)
  return a.reply().events.map((e): [string, string, boolean] => [e.hex, e.kind, e.drop !== null]).sort()
}

test('scanSlot: no descent or dive event for an aircraft the type table calls military; its 7700 is still an event, and no fall is added to it', () => {
  assert.deepEqual(found(() => ({ type: 'B738', category: 'A3' })), [['a00001', 'descent', true], ['a00002', 'dive', true], ['a00003', 'squawk', true]], 'an airliner: all three')
  assert.deepEqual(found(() => ({ type: 'B738', category: 'A3', military: true })), [['a00003', 'squawk', false]])
})

test('scanSlot: no descent or dive event for a fast-jet type: a T38, the others listed; their 7700s are still events', () => {
  assert.deepEqual(found(() => ({ type: 'T38', category: 'A3' })), [['a00003', 'squawk', false]])
  for (const type of FAST_JETS) assert.deepEqual(found(() => ({ type, category: 'A3' })), [['a00003', 'squawk', false]], type)
  assert.deepEqual(found(() => ({ type: null, category: 'A3' })).map((e) => e[0]), ['a00001', 'a00002', 'a00003'], 'no type is no exclusion')
})

test('a fighter\'s 7700 and a military aircraft\'s ADS-B status are still events, and a live fall is not added to either', () => {
  // a00001 is a fighter by its type code, a00002 military by the type table: neither has dbFlags.
  const { a, clock, pushed } = setup({ typeOf: (hex) => ({ type: hex === 'a00002' ? 'B738' : 'F5', category: 'A3', military: hex === 'a00002' }) })
  for (const t of [T0, T0 + 30_000]) {
    clock.t = t
    a.observe(ac({ hex: 'a00001', t: 'F5' }), t) // 7700
    a.observe(ac({ hex: 'a00002', squawk: '1000', emergency: 'general' }), t)
  }
  assert.deepEqual(a.reply().events.map((e) => [e.hex, e.kind]).sort(), [['a00001', 'squawk'], ['a00002', 'status']])
  assert.equal(pushed.length, 2)
  feed(a, samples(plunge(36_000, 50), 200, { hex: 'a00001', typeCode: 'F5' }))
  feed(a, samples(plunge(36_000, 50), 200, { hex: 'a00002', typeCode: 'B738' }))
  assert.deepEqual(a.reply().events.map((e) => e.drop), [null, null])
  assert.equal(pushed.length, 2, 'no push for a fall')
})

// An older sighting of a worse cause on a quiet event

test('an older code that is worse un-quiets a quiet event: pushed once, and its newer squawk is not overwritten', () => {
  const hex = 'a00001'
  const { a, clock, pushed, dir } = setup()
  for (const t of [at(15), at(16)]) {
    clock.t = t
    a.observe(ac({ hex, category: 'A1', squawk: '7600' }), t) // a light aircraft's radio failure: quiet, newest at 05:16
  }
  assert.deepEqual([a.reply().events[0].quiet, pushed.length], [true, 0])
  const rev = a.rev
  a.scanSlot(heat([{ hex, idents: [{ s: 600, squawk: '7700' }, { s: 660, squawk: '7700' }] }]), SLOT) // 7700 at 05:10 and 05:11: older
  const [e] = a.reply().events
  assert.equal(a.reply().events.length, 1)
  assert.deepEqual([e.squawk, e.quiet, e.lastMs], ['7600', false, at(16)], 'the newer 7600 stays; no longer quiet')
  assert.deepEqual(pushed.map((x) => x.hex), [hex], 'pushed once')
  assert.ok(a.rev > rev)
  assert.equal(lines(dir).at(-1)?.quiet, false)
  a.observe(ac({ hex, category: 'A1', squawk: '7700' }), at(15, 30)) // another older 7700: not quiet any more, nothing new
  assert.equal(pushed.length, 1)
})

test('an older status that is worse un-quiets too; an older minor squawk and status change nothing', () => {
  const hex = 'a00001'
  const { a, clock, pushed } = setup()
  const light = (emergency: string): ReadsbAircraft => ac({ hex, category: 'A1', squawk: '7600', emergency })
  for (const t of [at(15), at(16)]) {
    clock.t = t
    a.observe(light('nordo'), t) // quiet: a radio failure, no radio
  }
  const rev = a.rev
  a.observe(light('minfuel'), at(15, 30)) // older, minor
  assert.deepEqual([a.reply().events[0].quiet, a.reply().events[0].emergency, pushed.length, a.rev], [true, 'nordo', 0, rev])
  a.observe(light('general'), at(15, 40)) // older, worse
  const [e] = a.reply().events
  assert.deepEqual([e.quiet, e.squawk, e.emergency, e.lastMs, pushed.length], [false, '7600', 'nordo', at(16), 1])
  assert.ok(a.rev > rev)
})

test('scanSlot: a late fall of an aircraft with a quiet event (a Dash 8 that sent 7600) turns it loud: pushed once', () => {
  const { a, pushed } = setup({ typeOf: () => ({ type: 'DH8D', category: 'A1' }) })
  a.scanSlot(heat([{ hex: 'a00001', idents: [{ s: 600, squawk: '7600' }, { s: 660, squawk: '7600' }], alt: plunge(36_000, 1000) }]), SLOT)
  const [e] = a.reply().events
  assert.equal(a.reply().events.length, 1)
  assert.deepEqual([e.kind, e.squawk, e.drop !== null, e.quiet], ['squawk', '7600', true, false])
  assert.equal(pushed.length, 1)
})

test('scanSlot: the late check reaches the limits of D2: an airliner\'s dive of exactly 2,000 ft at 6,000 fpm is found at any level; another aircraft\'s of 3,000 ft from exactly 15,000 ft at 10,000 fpm; 25 ft less is not', () => {
  // A file's altitudes are in 25 ft steps. Level, then 10 s points down over `s` seconds, then no position: the file's last slice is far after it.
  const dive = (top: number, fall: number, over: number) => (s: number): number | null => (s > 1300 ? null : s < 1300 - over ? top : top - ((s - (1300 - over)) / over) * fall)
  const kinds = (top: number, fall: number, over: number, typeOf: TypeOf = LINER): (string | undefined)[] => {
    const { a } = setup({ typeOf })
    a.scanSlot(heat([{ hex: 'a00001', alt: dive(top, fall, over) }, { hex: 'a00002', lat: 41 }]), SLOT) // a00002 cruises to the last slice
    return a.reply().events.map((e) => e.kind)
  }
  assert.deepEqual(kinds(15_000, 2_000, 20), ['dive'])
  assert.deepEqual(kinds(6_000, 2_000, 20), ['dive'], 'an airliner: from 6,000 ft too')
  assert.deepEqual(kinds(15_000, 1_950, 20), [], '50 ft short, and so 5,850 fpm')
  assert.deepEqual(kinds(15_000, 2_950, 30), [], '5,900 fpm')
  assert.deepEqual(kinds(15_000, 5_000, 30, NO_TYPE), ['dive'], 'no airliner: 10,000 fpm from FL150')
  assert.deepEqual(kinds(14_975, 5_000, 30, NO_TYPE), [], 'a top 25 ft under FL150')
  assert.deepEqual(kinds(15_000, 4_950, 30, NO_TYPE), [], '9,900 fpm')
  assert.deepEqual(kinds(15_000, 4_950, 30, () => ({ type: 'GALX', category: 'A3' })), [], 'a business jet is no airliner')
})

test('an airliner\'s plunge (D3), 8,000 ft in 60 s at any level, is a descent event, live and late; no event for the same fall of another aircraft', () => {
  // Sriwijaya 182's kind, from a level below FL150: 11,000 ft lost at 9,000 fpm; then level, so it is no dive then lost.
  const fall = (s: number): number => (s < 1000 ? 12_900 : Math.max(1900, 12_900 - 150 * (s - 1000)))
  const late = (typeOf: TypeOf): (AlertDrop | null)[] => {
    const { a } = setup({ typeOf })
    a.scanSlot(heat([{ hex: 'a00001', alt: fall }]), SLOT)
    return a.reply().events.map((e) => e.drop)
  }
  assert.deepEqual(late(LINER), [{ fromFt: 12_900, toFt: 1900, overS: 80, lost: false }])
  assert.deepEqual(late(NO_TYPE), [])
  assert.deepEqual(late(() => ({ type: 'C208', category: 'A1' })), [], 'a jump plane dives like that every load')
  assert.deepEqual(late(() => ({ type: 'A310', category: 'A5' })), [], 'the A310 flies parabolas: it is not on the list')
  const live = (typeCode: string | null): number => {
    const { a } = setup()
    feed(a, samples((t) => fall(t + 950), 200, { typeCode }))
    return a.reply().events.length
  }
  assert.deepEqual([live('B735'), live('AT76'), live('C208'), live('GLF6'), live('B722'), live(null)], [1, 1, 0, 0, 0, 0])
})

test('scanSlot: a dive then lost needs silence: an aircraft heard after the fall, on the ground or with no altitude, is not lost', () => {
  // A B738 on approach whose last altitude off the ground is wrong: 2,700, 2,400, 300 ft. Then `after` in every slice to the file's end.
  const file = (after: 'g' | null | undefined): Uint8Array => {
    const slices: Slices = []
    for (let s = 0; s < 1800; s += 10) {
      const ft = s < 1000 ? 3000 : s === 1000 ? 2700 : s === 1010 ? 2400 : s === 1020 ? 300 : after
      const records: Slices[number]['records'] = [{ hex: 'a00002', lat: 41, lon: -70, alt: 31_000, gs: 450 }] // another cruises to the last slice
      if (ft !== undefined) records.push({ hex: 'a00001', lat: 40, lon: -70, alt: ft, gs: ft === 'g' ? 20 : 140 })
      slices.push({ tMs: SLOT + s * 1000, records })
    }
    return encodeHeatmap(slices)
  }
  const drops = (after: 'g' | null | undefined): (AlertDrop | null)[] => {
    const { a } = setup()
    a.scanSlot(file(after), SLOT)
    return a.reply().events.map((e) => e.drop)
  }
  assert.deepEqual(drops(undefined), [{ fromFt: 2700, toFt: 300, overS: 20, lost: true }], 'nothing after it')
  assert.deepEqual(drops('g'), [], 'on the ground after it: it landed')
  assert.deepEqual(drops(null), [], 'heard with no altitude after it')
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

// ---- final fix round ----

test('confirmation goes by the time of each message (receipt − seen), not of the answer: one message re-served by two sweeps confirms nothing', () => {
  const { a } = setup()
  a.observe(ac({ seen: 5 }), T0) // its last message 5 s before this answer
  a.observe(ac({ seen: 35 }), T0 + 30_000) // the same message, 30 s on (readsb keeps a squawk 60 s after it)
  assert.equal(a.reply().events.length, 0)
  a.observe(ac({ seen: 1 }), T0 + 60_000) // a new message, 64 s after the first
  assert.deepEqual(a.reply().events.map((e) => [e.openedMs, e.lastMs]), [[T0 - 5_000, T0 + 59_000]])
  a.observe(ac({ seen: 40 }), T0 + 90_000) // a message older than the newest
  assert.equal(a.reply().events[0].lastMs, T0 + 59_000)
  a.observe(ac({ seen: 2 }), T0 + 120_000)
  assert.equal(a.reply().events[0].lastMs, T0 + 118_000, 'its newest message')
})

test('confirmation: two sweeps 30 s apart confirm on the second even when its newest message is 8 s old (22 s after the first); 10 s old still does, 11 s waits for the third', () => {
  for (const seen of [8, 10]) {
    const { a, pushed } = setup()
    a.observe(ac({ seen: 0 }), T0) // the first sweep: a message just now
    a.observe(ac({ seen }), T0 + 30_000) // the second, 30 s on: its newest message `seen` s old, so 30 − seen s after the first
    assert.deepEqual(a.reply().events.map((e) => [e.openedMs, e.lastMs]), [[T0, T0 + 30_000 - seen * 1000]], `${seen} s old`)
    assert.equal(pushed.length, 1)
  }
  const { a, pushed } = setup()
  a.observe(ac({ seen: 0 }), T0)
  a.observe(ac({ seen: 11 }), T0 + 30_000) // 19 s after the first message: not yet
  assert.equal(a.reply().events.length, 0)
  a.observe(ac({ seen: 0 }), T0 + 60_000) // the third sweep
  assert.deepEqual(a.reply().events.map((e) => [e.openedMs, e.lastMs]), [[T0, T0 + 60_000]])
  assert.equal(pushed.length, 1)
})

test('the rev starts at the server clock (whole ms): a restarted server\'s rev is above any its last run gave', () => {
  const dir = tmp()
  const one = setup({ dir })
  for (const hex of ['a00001', 'a00002', 'a00003']) for (const t of [T0, T0 + 30_000]) one.a.observe(ac({ hex }), t)
  const last = one.a.rev
  assert.ok(last > T0, `${last}`)
  const two = new Alerts({ dir, nowMs: () => T0 + 60_000.7, sweep: true })
  assert.equal(two.rev, T0 + 60_000)
  assert.ok(two.rev > last)
})

test('the log: after a write cut short (a full disk), the next line starts on a line of its own; the cut one is skipped', (t) => {
  const err = t.mock.method(console, 'error', () => {})
  const dir = tmp()
  let cut = 1
  const append = (path: string, text: string): void => {
    if (cut-- > 0) {
      appendFileSync(path, text.slice(0, 25)) // the disk filled in the middle of the line
      throw new Error('ENOSPC: no space left on device, write')
    }
    appendFileSync(path, text)
  }
  const { a, clock } = setup({ dir, append })
  for (const hex of ['a00001', 'a00002', 'a00003']) {
    for (const x of [T0, T0 + 30_000]) {
      clock.t = x
      a.observe(ac({ hex }), x)
    }
  }
  assert.equal(err.mock.callCount(), 1)
  const text = readFileSync(join(dir, '2026-09-30.jsonl'), 'utf8')
  assert.equal(text.split('\n').length, 4, `the cut line, a00002, a00003 and the end; no empty line once a write went well: ${text}`)
  const read = new Alerts({ dir, nowMs: () => clock.t, sweep: true }).reply().events.map((e) => e.hex).sort()
  assert.deepEqual(read, ['a00002', 'a00003'], 'only the cut line is lost')
})

// A fall across the boundary of two half hours: the late check carries the end of each half hour into the next.

const NEXT = SLOT + SLOT_MS // the 05:30 half hour
/** Half hour n after 05:00, stamped as half hour `as` (n by default), its planes' altitudes given in s since 05:00. */
function half(n: number, planes: Plane[], as = n): Uint8Array {
  return heat(planes.map((p) => (p.alt === undefined ? p : { ...p, alt: (s: number) => p.alt!(s + n * 1800) })), SLOT + as * SLOT_MS)
}
/** FZ1073's shape: level at 34,000 ft, then 6,000 ft lost in the 50 s to lastS (in s since 05:00), then no position. */
const diveTo = (lastS: number) => (s: number): number | null => (s > lastS ? null : s < lastS - 50 ? 34_000 : 34_000 - ((s - (lastS - 50)) / 50) * 6000)
/** From FL370 at startS (in s since 05:00), 10,000 fpm down to 17,000 ft (2 min), then level. */
const descentAt = (startS: number) => (s: number): number => (s < startS ? 37_000 : Math.max(17_000, 37_000 - ((s - startS) / 60) * 10_000))
const falls = (a: Alerts): unknown[] => a.reply().events.map((e) => [e.hex, e.kind, e.drop?.fromFt, e.drop?.toFt, e.openedMs]).sort()

test('late, across a boundary: a dive in the last 50 s of a half hour, the aircraft gone from the next, is found once the next is read', () => {
  const plane = { hex: 'a00001', alt: diveTo(1790) } // its last point at 05:29:50, the half hour's last slice
  const { a, pushed } = setup()
  a.scanSlot(half(0, [plane]), SLOT)
  assert.equal(a.reply().events.length, 0, 'its own half hour ends as it falls')
  a.scanSlot(half(1, [plane]), NEXT)
  const [e] = a.reply().events
  assert.equal(a.reply().events.length, 1)
  assert.deepEqual([e.kind, e.drop, e.openedMs, e.lastMs, e.late], ['dive', { fromFt: 34_000, toFt: 28_000, overS: 50, lost: true }, at(29), at(29, 50), true])
  assert.deepEqual([e.lat, e.lon, e.altFt], [40, -70, 28_000], 'where it was last heard')
  assert.equal(pushed.length, 1)
})

test('late, across a boundary: a 20,000 ft descent split by it is found once the next half hour is read; each half hour carries its own end', () => {
  const first = { hex: 'a00001', alt: descentAt(1740) } // 05:29:00 to 05:31:00
  const second = { hex: 'a00002', lat: 41, alt: descentAt(3540) } // 05:59:00 to 06:01:00
  const { a, pushed } = setup({ typeOf: NO_TYPE }) // D1_OTHER: an airliner's D3 would find the fall's start in its own half hour
  a.scanSlot(half(0, [first, second]), SLOT)
  assert.deepEqual(falls(a), [])
  a.scanSlot(half(1, [first, second]), NEXT)
  assert.deepEqual(falls(a), [['a00001', 'descent', 37_000, 17_000, at(29)]])
  a.scanSlot(half(2, [first, second]), SLOT + 2 * SLOT_MS)
  assert.deepEqual(falls(a), [['a00001', 'descent', 37_000, 17_000, at(29)], ['a00002', 'descent', 37_000, 17_000, at(59)]])
  assert.equal(pushed.length, 2)
})

test('late, across a boundary: a fall found in a half hour is not found twice, nor pushed again, when the next one carries its end', () => {
  const descent = { hex: 'a00001', alt: descentAt(1640) } // 05:27:20 to 05:29:20: within the half hour's last 150 s
  const dive = { hex: 'a00002', lat: 41, alt: diveTo(1700) } // lost at 05:28:20, 90 s before the half hour ends
  const { a, pushed } = setup()
  a.scanSlot(half(0, [descent, dive]), SLOT)
  const found = structuredClone(a.reply().events)
  assert.deepEqual(found.map((e) => e.kind).sort(), ['descent', 'dive'])
  a.scanSlot(half(1, [descent, dive]), NEXT)
  assert.deepEqual(a.reply().events, found)
  assert.equal(pushed.length, 2)
})

test('late, across a boundary: nothing is carried into a half hour read without the one before it (the first read, after a gap)', () => {
  const plane = { hex: 'a00001', alt: descentAt(1740) } // split by the 05:30 boundary, as above
  const alone = setup({ typeOf: NO_TYPE })
  alone.a.scanSlot(half(1, [plane]), NEXT)
  assert.equal(alone.a.reply().events.length, 0, 'the first read')
  const gap = setup({ typeOf: NO_TYPE })
  gap.a.scanSlot(half(0, [plane]), SLOT)
  gap.a.scanSlot(half(1, [plane], 2), SLOT + 2 * SLOT_MS) // what 05:30 held, as the 06:00 half hour: 05:00's end is not before it
  assert.equal(gap.a.reply().events.length, 0, 'after a gap')
})

test('late, across a boundary: an older half hour read after a newer one (its download failed once) does not take the newer one\'s end', () => {
  const plane = { hex: 'a00001', alt: descentAt(3540) } // 05:59:00 to 06:01:00: split by the 06:00 boundary, between half hours 1 and 2
  const { a, pushed } = setup({ typeOf: NO_TYPE })
  a.scanSlot(half(1, [plane]), NEXT)
  a.scanSlot(half(0, [plane]), SLOT) // half hour 0 only now: out of order
  assert.deepEqual(falls(a), [], 'neither of the two holds the fall')
  a.scanSlot(half(2, [plane]), SLOT + 2 * SLOT_MS)
  assert.deepEqual(falls(a), [['a00001', 'descent', 37_000, 17_000, at(59)]], 'half hour 2 still follows the end of half hour 1')
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
