// server/alerts.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AlertEvent } from '../shared/alerts.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { Alerts, ntfyPush } from './alerts.ts'
import { encodeHeatmap } from './heatmap.ts'

const T0 = Date.UTC(2026, 8, 30, 5, 31, 0)
const tmp = (): string => mkdtempSync(join(tmpdir(), 'fh-alerts-'))

function setup(o: { dir?: string; on?: boolean; codes?: string[]; typeOf?: (hex: string) => { type: string | null; category: string | null } } = {}) {
  const clock = { t: T0 }
  const pushed: AlertEvent[] = []
  const dir = o.dir ?? tmp()
  const a = new Alerts({ dir, nowMs: () => clock.t, sweep: true, push: (e) => pushed.push(structuredClone(e)), codes: o.codes, typeOf: o.typeOf })
  if (o.on ?? true) a.setOn(true)
  return { a, clock, pushed, dir }
}

const ac = (o: Partial<ReadsbAircraft> = {}): ReadsbAircraft => ({
  hex: '89645a', flight: 'FDB1073 ', r: 'A6-FNC', t: 'B38M', category: 'A3', alt_baro: 30_000, lat: 29.95, lon: 38.12, squawk: '7700', ...o,
})

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
    // a light aircraft falling the same way: none
    records.push({ hex: 'a00004', lat: 43, lon: -73, alt: s < 200 ? 36_000 : Math.max(24_000, 36_000 - ((s - 200) / 110) * 12_000), gs: 100 })
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
