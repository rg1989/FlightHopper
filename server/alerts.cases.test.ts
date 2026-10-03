// server/alerts.cases.test.ts
// Known emergencies, replayed as this server would receive them, through the real Poller and Alerts. The figures of each case
// (squawks, barometric altitudes, the last message) are the published ones: server/alerts.cases.ts. Three ways to find one:
//   sweep  nobody looks at the aircraft: adsb.fi's /v2/sqk answers, asked at the poller's own pace (0.9 req/s, burst 1)
//   late   adsb.lol's half-hour files of the flight (encodeHeatmap), read by Alerts.scanSlot once each is published
//   onMap  the aircraft is inside a 130 nm view that a client keeps asking for (not selected)
// The upstream is a model, not a recording: an aircraft is in an answer for 60 s after its last message, as readsb serves it;
// a half-hour file has its position every 10 s while its altitude changes and every 20 s while it is level, and an ident
// each minute and at each new squawk (what FZ1073's real file shows: descent.test.ts FZ1073_FILE). It assumes a receiver of
// the open networks hears every message up to the case's last one, except in its `deaf` spans.
//   CASES=1 node --test server/alerts.cases.test.ts   prints the table
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AlertEvent } from '../shared/alerts.ts'
import { PUBLISH_DELAY_MS, SLOT_MS, slotOf } from '../shared/history.ts'
import type { ReadsbAircraft } from '../shared/types.ts'
import { Alerts } from './alerts.ts'
import { CASES, type Case as Told } from './alerts.cases.ts'
import { TokenBucket } from './budget.ts'
import { encodeHeatmap } from './heatmap.ts'
import { POLLER_DEFAULTS, Poller } from './poller.ts'
import type { FetchResult, Source } from './sources/types.ts'
import { SampleStore } from './store.ts'

/** A case in seconds of its UTC day (Told has clock times). */
interface Case extends Omit<Told, 'alt' | 'end' | 'sqk' | 'deaf'> {
  at: string // 00:00 UTC of its day
  from: number // s: where the replay starts, 2 min before its first point or squawk
  alt: [number, number][]
  end: number
  sqk: [number, string][]
  deaf: [number, number][]
}
/** 'HH:MM:SS' as seconds; an hour of 24 or more is the next day. */
const sec = (hms: string): number => hms.split(':').reduce((s, x) => s * 60 + Number(x), 0)
function timed(c: Told): Case {
  const alt = c.alt.map(([t, ft]): [number, number] => [sec(t), ft])
  const sqk = (c.sqk ?? []).map(([t, code]): [number, string] => [sec(t), code])
  const deaf = (c.deaf ?? []).map(([a, b]): [number, number] => [sec(a), sec(b)])
  return { ...c, at: `${c.day}T00:00:00Z`, from: Math.min(alt[0][0], sqk[0]?.[0] ?? Infinity) - 120, alt, end: sec(c.end), sqk, deaf }
}

const HEX = 'a0c0de'
const SERVED_S = 60 // readsb serves an aircraft this long after its last message
const VIEW_NM = 130 // the default regional view
const HISTORY_TICK_MS = 60_000 // main.ts: how often the newest half hour is looked for

/** Its barometric altitude at s: straight lines between the published points, level before the first and after the last. */
function altAt(c: Case, s: number): number {
  const p = c.alt
  if (s <= p[0][0]) return p[0][1]
  for (let i = 1; i < p.length; i++) {
    if (s <= p[i][0]) return p[i - 1][1] + ((p[i][1] - p[i - 1][1]) * (s - p[i - 1][0])) / (p[i][0] - p[i - 1][0])
  }
  return p[p.length - 1][1]
}

/** The squawk it sends at s: the newest of c.sqk, else an ordinary one. */
function sqkAt(c: Case, s: number): string {
  let code = '2000'
  for (const [from, x] of c.sqk) if (s >= from) code = x
  return code
}

/** Where it is at s: east along 30° N at 450 kt from 10° E (the place is nothing to the rules). */
const lonAt = (c: Case, s: number): number => 10 + (s - c.from) * 0.0025

/** Whether a receiver hears it at s: up to its last message, and not in a deaf span. */
const heard = (c: Case, s: number): boolean => s <= c.end && !c.deaf.some(([a, b]) => s >= a && s < b)

/** The second of its newest message heard at or before s, or null when that is over 60 s old (readsb has dropped it). */
function lastHeard(c: Case, s: number): number | null {
  for (let x = Math.floor(s); x >= s - SERVED_S; x--) if (heard(c, x)) return x
  return null
}

/** The aircraft object an upstream answer holds at s, or null when it holds none. */
function served(c: Case, s: number): ReadsbAircraft | null {
  const m = lastHeard(c, s)
  if (m === null) return null
  const age = s - m
  return {
    hex: HEX, type: 'adsb_icao', version: 2, flight: c.callsign.padEnd(8), t: c.type, category: c.cat ?? 'A3',
    alt_baro: Math.round(altAt(c, m) / 25) * 25, baro_rate: Math.round(((altAt(c, m) - altAt(c, m - 4)) * 15) / 64) * 64,
    lat: 30, lon: lonAt(c, m), gs: 450, track: 90, squawk: sqkAt(c, m), seen: age, seen_pos: age,
  }
}

interface Found {
  kind: string // the event's kind and what it holds: 'squawk 7700', 'descent', 'dive'
  afterS: number // from its cause (the squawk set, the top of the fall) to the push
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'fh-cases-'))
const typeOf = (c: Case) => () => ({ type: c.type, category: c.cat ?? 'A3', military: false })
const label = (e: AlertEvent): string => (e.drop !== null ? (e.drop.lost ? 'dive' : 'descent') : `squawk ${e.squawk}`)
/** When the cause of an event began: the first second a receiver heard its squawk, or the top of the fall. */
function causeMs(c: Case, e: AlertEvent, t0: number): number {
  if (e.drop !== null) return e.openedMs
  const first = c.sqk.find(([, code]) => code === e.squawk)
  if (first === undefined) return e.openedMs
  let s = first[0]
  while (s < c.end && !heard(c, s)) s++
  return t0 + s * 1000
}

/** The live server over the case: the sweep alone, or with the aircraft inside a view a client keeps asking for. */
async function live(c: Case, onMap: boolean, phaseMs: number): Promise<Found | null> {
  const t0 = Date.parse(c.at)
  const clock = { t: t0 + c.from * 1000 + phaseMs }
  const answer = (ac: ReadsbAircraft | null): FetchResult => ({
    url: 'sim', status: 200, tSendMs: clock.t, tRecvMs: clock.t, bytes: 0, body: '', retryAfterS: null,
    snapshot: { nowMs: clock.t, aircraft: ac === null ? [] : [ac] },
  })
  const now = (): ReadsbAircraft | null => served(c, (clock.t - t0) / 1000)
  const source: Source = {
    caps: { kind: 'adsbfi', fullSnapshot: false, maxRps: 1, burst: 1, coverage: null, attribution: '' },
    circle: async () => answer(onMap ? now() : null),
    hexes: async () => answer(null),
    squawk: async (code) => answer(now()?.squawk === code ? now() : null),
    all: async () => Promise.reject(new Error('unsupported')),
  }
  let found: Found | null = null
  const store = new SampleStore()
  const alerts = new Alerts({
    dir: tmp(), nowMs: () => clock.t, sweep: true, typeOf: typeOf(c),
    push: (e) => (found ??= { kind: label(e), afterS: Math.round((clock.t - causeMs(c, e, t0)) / 1000) }),
  })
  alerts.setOn(true)
  const poller = new Poller(source, store, new TokenBucket(0.9, () => clock.t, () => 0, 1), {
    ...POLLER_DEFAULTS, recorder: null, hideFlagged: true, nowMs: () => clock.t,
    onSample: (s) => alerts.sample(s, () => store.track(s.hex, s.rxMs - 150_000), 0), // as main.ts wires it
    squawks: () => alerts.squawks(),
    onAircraft: (ac, rxMs) => alerts.observe(ac, rxMs),
  })
  const endMs = t0 + (c.end + 180) * 1000
  for (; clock.t < endMs && found === null; clock.t += 100) {
    if (onMap && clock.t % 1000 === 0) poller.touchView(30, 10, VIEW_NM)
    await poller.tick()
  }
  return found
}

/** The half-hour files of the case, each read when the server would have it; minS: the least time between two of its positions. */
function late(c: Case, minS = 10): Found | null {
  const t0 = Date.parse(c.at)
  const clock = { t: t0 }
  let found: Found | null = null
  const alerts = new Alerts({
    dir: tmp(), nowMs: () => clock.t, sweep: true, typeOf: typeOf(c),
    push: (e) => (found ??= { kind: label(e), afterS: Math.round((clock.t - causeMs(c, e, t0)) / 1000) }),
  })
  alerts.setOn(true)
  let wrote = -Infinity // the second of its last position in a file
  let wroteFt = NaN
  let ident = -Infinity
  let identSqk = ''
  for (let slot = slotOf(t0 + c.from * 1000); slot <= slotOf(t0 + c.end * 1000) + SLOT_MS; slot += SLOT_MS) {
    const slices: Parameters<typeof encodeHeatmap>[0] = []
    for (let sec = 0; sec < 1800; sec += 10) {
      const s = (slot + sec * 1000 - t0) / 1000
      const records: (typeof slices)[number]['records'] = []
      if (heard(c, s)) {
        const ft = Math.round(altAt(c, s) / 25) * 25
        const due = s - wrote >= (Math.abs(ft - wroteFt) >= 100 ? 10 : 20)
        if (due && s - wrote >= minS) {
          records.push({ hex: HEX, lat: 30, lon: lonAt(c, s), alt: ft, gs: 450 })
          wrote = s
          wroteFt = ft
        }
        if (s - ident >= 60 || sqkAt(c, s) !== identSqk) {
          ident = s
          identSqk = sqkAt(c, s)
          records.push({ hex: HEX, callsign: c.callsign, squawk: identSqk })
        }
      }
      slices.push({ tMs: slot + sec * 1000, records })
    }
    // Published 20 s after its end; the server looks each minute: on average half a minute later.
    clock.t = slot + SLOT_MS + PUBLISH_DELAY_MS + HISTORY_TICK_MS / 2
    alerts.scanSlot(encodeHeatmap(slices), slot)
    if (found !== null) break
  }
  return found
}

interface Row {
  c: Told
  sweep: Found | null // the slowest of three phases of the sweep; null when one of them misses it
  late: Found | null
  thin: Found | null // the files with a position every 30 s at most (one far receiver)
  onMap: Found | null
}

async function replay(told: Told): Promise<Row> {
  const c = timed(told)
  let sweep: Found | null = null
  for (const phase of [0, 10_000, 20_000]) {
    const f = await live(c, false, phase)
    if (f === null) {
      sweep = null
      break
    }
    if (sweep === null || f.afterS > sweep.afterS) sweep = f
  }
  return { c: told, sweep, late: late(c), thin: late(c, 30), onMap: await live(c, true, 0) }
}

const span = (s: number): string => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`)
const cell = (f: Found | null): string => (f === null ? 'no' : `${f.kind}, ${span(f.afterS)}`)

const rows: Row[] = []
for (const c of CASES) {
  test(`${c.name}: ${c.what}`, async () => {
    const r = await replay(c)
    rows.push(r)
    assert.deepEqual(
      { sweep: r.sweep?.kind ?? null, late: r.late?.kind ?? null, onMap: r.onMap?.kind ?? null },
      { sweep: c.want.sweep, late: c.want.late, onMap: c.want.onMap },
    )
  })
}

test('the table (CASES=1 prints it)', { skip: process.env.CASES !== '1' }, () => {
  const out = ['| Case | What | Sweep, live | Half-hour file | File, thin | On your map |', '|---|---|---|---|---|---|']
  for (const r of rows) out.push(`| ${r.c.name} | ${r.c.what} | ${cell(r.sweep)} | ${cell(r.late)} | ${cell(r.thin)} | ${cell(r.onMap)} |`)
  console.log(out.join('\n'))
})
