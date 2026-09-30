// client/scenario/run.test.ts
// The pure parts of a running scenario: the frame each step composes (clock → pose, data, events, captions, marks passed, ending),
// the seek detection, the keys, the caption views, the credits, the era layer options and the model dressing.
// ScenarioRun itself (DOM, viewer, audio) is checked in the browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import type { FlightData, ModelManifestEntry, RenderState } from '../types.ts'
import type { Livery } from '../scene/livery.ts'
import type { PoseData } from './pose.ts'

// run.ts mounts the play bar, captions and ending, which import their CSS for Vite: Node loads every .css as nothing.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { clockToS, parseScenario } = await import('./format.ts')
const { Dresser, JUMP_S, ScenarioPlayer, captionView, eraLayerOptions, scenarioKey, stopOf } = await import('./run.ts')

const T = clockToS

/** A tiny package: 10:00:00–10:01:00, an ending from 10:00:40 (dark 10:00:45, card 5 s later); events: more rows. */
function scenario(overrides: Record<string, unknown> = {}, events: string[] = []) {
  return parseScenario({
    base: '/s/tiny/',
    manifest: {
      format: 1, id: 'tiny', title: 'Tiny', subtitle: 'A to B', date: '2001-06-15', utcOffset: '+09:00', clockLabel: 'JST',
      start: '10:00:00', end: '10:01:00', note: 'Test.', summary: [], crew: [],
      aircraft: { registration: 'JA0000', type: 'Test', callsign: 'T1', operator: 'Test', model: 'b744' },
      speakers: { CAP: { name: 'Captain', kind: 'crew' }, TWR: { name: 'Tower', kind: 'atc' } },
      imagery: [{ url: 'https://tiles.test/{z}/{x}/{y}.jpg', rect: [139.7, 35.45, 139.9, 35.62], minZoom: 10, maxZoom: 17, credit: 'Old photos' }],
      ending: { fadeFrom: '10:00:40', darkAt: '10:00:45', cardAfterS: 5, card: { title: 'The end', lines: ['One.'] } },
      sources: [{ id: 'R', title: 'The report (1987)' }, { id: 'S', title: 'A study' }],
      ...overrides,
    },
    track: ['time,lat,lon,alt_ft,hdg,pitch,roll', '10:00:00,35.5,139.8,0,150,0,0', '10:01:00,35.4,139.9,5000,150,5,0'].join('\n'),
    events: ['time,type,value,label,src', '10:00:00,phase,,Roll,', '10:00:00,gear,1,,', '10:00:00,flaps,10,,', '10:00:20,gear,0,,', '10:00:30,damage,fin,,', ...events].join('\n'),
    transcript: [
      'time,dur,speaker,to,channel,lang,text,original,q,src',
      '10:00:05,4,TWR,CAP,radio,en,Cleared.,,D,',
      '10:00:10,3,CAP,,cockpit,ja,Gear up.,ギアアップ,T,',
      '10:00:12,3,CAP,,cockpit,ja,[unintelligible],,U,',
      '10:00:41,6,CAP,,cockpit,en,Late line.,,D,', // on screen to 10:00:47: past darkAt
    ].join('\n'),
    present: { body: false, finLogo: false, audio: false },
  })
}

/** A pose that reports t through lat and altFt, and records every t it is asked for. */
function fakePose() {
  const asked: number[] = []
  const state = (t: number): RenderState => ({
    hex: 'scn000', lat: t, lon: 139, hM: 100, headingDeg: 150, pitchDeg: 0, rollDeg: 0, gsKt: 150, trackDeg: 150, altBaroFt: t, vsFpm: 0,
    mode: 'interp', altSource: 'baro-qnh', onGround: false, ageS: 0, quality: 'adsb2', callsign: null, typeCode: null,
  })
  const data = (t: number): PoseData => ({
    altFt: t, vsFpm: 0, iasKt: 150, gsKt: 150, hdgDeg: 150, trackDeg: 150, pitchDeg: 0, rollDeg: 0, g: null, windFromDeg: null, windKt: null,
    epr: null, derived: new Set<keyof FlightData>(['trackDeg']),
  })
  return { asked, stateAt: (t: number) => (asked.push(t), state(t)), dataAt: (t: number) => data(t) }
}

test('stopOf: the last data second, or the ending card when it comes later', () => {
  const s = scenario()
  assert.equal(stopOf(s), T('10:01:00'))
  assert.equal(stopOf({ end: T('10:00:30'), ending: s.ending }), T('10:00:50'), 'darkAt 10:00:45 + 5 s')
  assert.equal(stopOf({ end: T('10:00:30'), ending: null }), T('10:00:30'))
})

test('ScenarioPlayer: starts paused at t (clamped to the timeline), else at start; a paused step keeps t', () => {
  const s = scenario()
  const at = new ScenarioPlayer(s, fakePose(), T('10:00:20'))
  assert.equal(at.clock.playing, false)
  assert.equal(at.step(0.5).t, T('10:00:20'))
  assert.equal(at.step(0.5).t, T('10:00:20'))
  assert.equal(new ScenarioPlayer(s, fakePose()).step(0).t, s.start)
  assert.equal(new ScenarioPlayer(s, fakePose(), 1e9).step(0).t, stopOf(s))
  assert.equal(new ScenarioPlayer(s, fakePose(), Number.NaN).step(0).t, s.start, 'a junk t starts at the start')
})

test('ScenarioPlayer: the frame at t: the pose, its UTC instant, the data with gear and flaps, the events', () => {
  const s = scenario()
  const pose = fakePose()
  const f = new ScenarioPlayer(s, pose, T('10:00:10')).step(0)
  assert.equal(f.state.lat, T('10:00:10'))
  assert.equal(pose.asked.at(-1), T('10:00:10'))
  assert.equal(f.tUtcMs, Date.UTC(2001, 5, 15, 1, 0, 10), '10:00:10 JST')
  assert.equal(f.data.altFt, T('10:00:10'))
  assert.equal(f.data.gear, 'down')
  assert.equal(f.data.flaps, 10)
  assert.equal(f.data.aglFt, null, 'the app knows the ground')
  assert.ok(f.data.derived.has('trackDeg') && f.data.derived.has('aglFt'), 'the height above the modern terrain is an estimate')
  assert.equal(f.event.phase, 'Roll')
  assert.equal(f.event.damage.has('fin'), false)
  const later = new ScenarioPlayer(s, fakePose(), T('10:00:31')).step(0)
  assert.equal(later.data.gear, 'up')
  assert.equal(later.event.gear, false)
  assert.equal(later.event.damage.has('fin'), true)
})

test('ScenarioPlayer: toggle plays at the clock rate and pauses; a step never passes the stop', () => {
  const s = scenario()
  const p = new ScenarioPlayer(s, fakePose(), T('10:00:00'))
  p.toggle()
  assert.equal(p.step(1).t, T('10:00:01'))
  p.clock.nextRate() // 2×
  assert.equal(p.step(1).t, T('10:00:03'))
  p.toggle()
  assert.equal(p.step(1).t, T('10:00:03'))
  p.seek(stopOf(s) - 0.5)
  p.toggle()
  assert.equal(p.step(1).t, stopOf(s))
  assert.equal(p.clock.playing, false, 'stops at the end')
})

test('ScenarioPlayer: jumped marks a seek of more than JUMP_S between steps, not play at any rate', () => {
  const s = scenario()
  const p = new ScenarioPlayer(s, fakePose(), T('10:00:00'))
  assert.equal(p.step(0).jumped, false, 'the first frame')
  p.toggle()
  for (let i = 0; i < 4; i++) p.clock.nextRate() // 16×
  assert.equal(p.step(1).jumped, false, '16 s of play in one frame')
  p.seek(p.clock.t + JUMP_S + 0.1)
  assert.equal(p.step(0.016).jumped, true)
  assert.equal(p.step(0.016).jumped, false, 'once')
  p.seekBy(-1) // a slow drag: small steps
  assert.equal(p.step(0.016).jumped, false)
  p.seekBy(-10)
  assert.equal(p.step(0.016).jumped, true)
})

test('ScenarioPlayer: mark is the one play passed in the step (the latest of several), never one a seek jumped over', () => {
  const s = scenario({}, ['10:00:31,mark,,A,', '10:00:33,mark,,B,', '10:00:38,mark,,C,'])
  const p = new ScenarioPlayer(s, fakePose(), T('10:00:30'))
  assert.equal(p.step(1).mark, null, 'paused')
  p.toggle()
  assert.equal(p.step(0.5).mark, null, 'not there yet')
  assert.deepEqual(p.step(1).mark, { key: 'm5', t: T('10:00:31'), label: 'A' })
  assert.equal(p.step(1).mark, null, 'once')
  p.seek(T('10:00:39')) // over B and C
  assert.equal(p.step(0.5).mark, null, 'a seek passes none')
  p.seek(T('10:00:33')) // a click on its tick
  assert.equal(p.step(0.5).mark?.label, 'B', 'playing on from a mark')
  p.seek(T('10:00:30'))
  for (let i = 0; i < 4; i++) p.clock.nextRate() // 16×: 10:00:30 → 10:00:38 in one step
  assert.equal(p.step(0.5).mark?.label, 'C', 'the latest')
})

test('ScenarioPlayer: Play at the stop starts again from the start (a jump)', () => {
  const s = scenario()
  const p = new ScenarioPlayer(s, fakePose(), stopOf(s))
  p.step(0)
  p.toggle()
  const f = p.step(0)
  assert.equal(f.t, s.start)
  assert.equal(f.jumped, true)
})

test('ScenarioPlayer: the ending fades from fadeFrom, is dark at darkAt, the card comes cardAfterS later; no captions once dark', () => {
  const s = scenario()
  const at = (c: string) => new ScenarioPlayer(s, fakePose(), T(c)).step(0)
  assert.equal(at('10:00:39').fade, 0)
  const mid = at('10:00:42.5')
  assert.ok(mid.fade > 0.4 && mid.fade < 0.6, `${mid.fade}`)
  assert.deepEqual(mid.lines.map((l) => l.text), ['Late line.'], 'captions while it fades')
  const dark = at('10:00:45')
  assert.equal(dark.fade, 1)
  assert.equal(dark.card, false)
  assert.deepEqual(dark.lines, [], 'dark: no captions')
  assert.equal(at('10:00:50').card, true)
})

test('ScenarioPlayer: the lines on screen at t, oldest first', () => {
  const p = new ScenarioPlayer(scenario(), fakePose(), T('10:00:12.5'))
  assert.deepEqual(p.step(0).lines.map((l) => l.text), ['Gear up.', '[unintelligible]'])
})

test('scenarioKey: Space plays or pauses, ←/→ step 10 s, with Shift 60 s, M mutes; nothing else', () => {
  const k = (key: string, o: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat: boolean; target: unknown }> = {}) =>
    scenarioKey({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, repeat: false, target: null, ...o })
  assert.deepEqual(k(' '), { toggle: true })
  assert.deepEqual(k('ArrowLeft'), { stepS: -10 })
  assert.deepEqual(k('ArrowRight'), { stepS: 10 })
  assert.deepEqual(k('ArrowLeft', { shiftKey: true }), { stepS: -60 })
  assert.deepEqual(k('ArrowRight', { shiftKey: true }), { stepS: 60 })
  assert.deepEqual(k('m'), { mute: true })
  assert.deepEqual(k('M', { shiftKey: true }), { mute: true })
  for (const key of ['a', 'Enter', 'ArrowUp', 'Escape', 't']) assert.equal(k(key), null, key)
})

test('scenarioKey: not with Cmd, Ctrl or Alt, on auto-repeat, while typing, or Space on a button (it presses the button)', () => {
  const k = (key: string, o: object) => scenarioKey({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, repeat: false, target: null, ...o })
  assert.equal(k(' ', { metaKey: true }), null)
  assert.equal(k('ArrowLeft', { ctrlKey: true }), null)
  assert.equal(k('ArrowRight', { altKey: true }), null)
  assert.equal(k(' ', { repeat: true }), null)
  assert.equal(k('ArrowLeft', { repeat: true }), null)
  assert.equal(k(' ', { target: { tagName: 'INPUT' } }), null, 'the scrubber owns its keys')
  assert.equal(k('ArrowLeft', { target: { tagName: 'TEXTAREA' } }), null)
  assert.equal(k(' ', { target: { tagName: 'DIV', isContentEditable: true } }), null)
  assert.equal(k(' ', { target: { tagName: 'BUTTON' } }), null)
  assert.equal(k('m', { target: { tagName: 'INPUT' } }), null)
  assert.deepEqual(k('ArrowLeft', { target: { tagName: 'BUTTON' } }), { stepS: -10 }, 'an arrow is not a button key')
})

test('captionView: speaker names from the scenario, the record quality as marks, a stable key', () => {
  const s = scenario()
  const [cleared, gear, unint] = s.lines
  assert.deepEqual(captionView(cleared, 0, s.speakers), {
    key: 'l0', who: 'Tower', to: 'Captain', channel: 'radio', translated: false, unintelligible: false, text: 'Cleared.', original: null,
  })
  const g = captionView(gear, 1, s.speakers)
  assert.equal(g.to, null, 'to anyone listening')
  assert.equal(g.translated, true)
  assert.equal(g.original, 'ギアアップ')
  const u = captionView(unint, 2, s.speakers)
  assert.equal(u.unintelligible, true)
  assert.equal(u.text, '[unintelligible]')
  assert.equal(captionView({ ...cleared, speaker: 'XX' }, 0, s.speakers).who, 'XX', 'an unknown code shows as itself')
})

test('eraLayerOptions: the template, its rectangle in radians, the zoom levels and the credit', () => {
  const o = eraLayerOptions(scenario().imagery[0])
  assert.equal(o.url, 'https://tiles.test/{z}/{x}/{y}.jpg')
  const r = o.rectangle!
  const deg = (rad: number): number => Math.round((rad * 180) / Math.PI * 1e6) / 1e6
  assert.deepEqual([deg(r.west), deg(r.south), deg(r.east), deg(r.north)], [139.7, 35.45, 139.9, 35.62])
  assert.equal(o.minimumLevel, 10)
  assert.equal(o.maximumLevel, 17)
  assert.equal(o.credit, 'Old photos')
  const bare = eraLayerOptions({ url: 'u/{z}/{x}/{y}', rect: [0, 0, 1, 1], credit: 'c' })
  assert.equal(bare.minimumLevel, undefined)
  assert.equal(bare.maximumLevel, undefined)
})

/** A ChaseModel stand-in: its model loads after `loadAfter` use() calls. */
function fakeModel(start: ModelManifestEntry, loadAfter: number) {
  const log: string[] = []
  let asks = 0
  const m = {
    entry: start,
    log,
    use(e: ModelManifestEntry): boolean {
      if (e === m.entry) return false
      if (++asks <= loadAfter) return false
      m.entry = e
      log.push(`use ${e.id}`)
      return true
    },
    paintLivery: (l: Livery) => log.push(`paint ${l.code} on ${m.entry.id}`),
    setShape: (h: number | null) => log.push(`shape ${h} on ${m.entry.id}`),
    setDamage: (on: boolean) => log.push(`damage ${on}`),
    setGear: (on: boolean) => log.push(`gear ${on}`),
  }
  return m
}
const entry = (id: string) => ({ id }) as ModelManifestEntry
const LIVERY = { code: 'scenario:tiny' } as Livery

test('Dresser: asks for the scenario model every frame until it is drawn, dressing whatever is drawn', () => {
  const b744 = entry('b744')
  const m = fakeModel(entry('a320'), 2)
  const d = new Dresser(b744, LIVERY, 29.8)
  assert.equal(d.apply(m, false, true), false)
  assert.deepEqual(m.log.splice(0), ['paint scenario:tiny on a320', 'shape 29.8 on a320', 'damage false', 'gear true'])
  assert.equal(d.apply(m, false, true), false)
  assert.deepEqual(m.log.splice(0), ['damage false', 'gear true'], 'dressed already: nothing again')
  assert.equal(d.apply(m, true, false), true, 'loaded: switched (the Sun re-attaches its light)')
  assert.deepEqual(m.log.splice(0), ['use b744', 'paint scenario:tiny on b744', 'shape 29.8 on b744', 'damage true', 'gear false'])
  assert.equal(d.apply(m, true, false), false)
  assert.deepEqual(m.log.splice(0), ['damage true', 'gear false'])
})

test('Dresser: already on the scenario model it dresses at once; no livery or model: only shape, damage and gear', () => {
  const b744 = entry('b744')
  const m = fakeModel(b744, 0)
  new Dresser(b744, LIVERY, null).apply(m, false, false)
  assert.deepEqual(m.log, ['paint scenario:tiny on b744', 'shape null on b744', 'damage false', 'gear false'])
  const bare = fakeModel(b744, 0)
  new Dresser(null, null, null).apply(bare, false, false)
  assert.deepEqual(bare.log, ['shape null on b744', 'damage false', 'gear false'])
})

test('Dresser.undress: leaves the model as the live chase wants it', () => {
  const m = fakeModel(entry('b744'), 0)
  Dresser.undress(m)
  assert.deepEqual(m.log, ['shape null on b744', 'damage false', 'gear false'])
})

test('the demo package (harness/fixtures/scenarios/demo) passes the loader and has what the smoke run needs', () => {
  const dir = new URL('../../harness/fixtures/scenarios/demo/', import.meta.url)
  const read = (f: string): string => readFileSync(new URL(f, dir), 'utf8')
  const s = parseScenario({
    base: '/harness/fixtures/scenarios/demo/', manifest: JSON.parse(read('scenario.json')), track: read('track.csv'),
    events: read('events.csv'), transcript: read('transcript.csv'), present: { body: false, finLogo: false, audio: false },
  })
  assert.equal(s.id, 'demo')
  assert.equal(s.track.length, 181, '3 min at 1 Hz')
  assert.ok(s.track.some((r) => r.gnd) && s.track.some((r) => !r.gnd), 'a take-off roll, then flight')
  assert.ok(s.track.some((r) => Math.abs(r.roll) > 20), 'a banked turn')
  const types = new Set(s.events.map((e) => e.type))
  for (const t of ['phase', 'mark', 'gear', 'flaps', 'damage'] as const) assert.ok(types.has(t), t)
  assert.ok(s.lines.length >= 8 && s.lines.length <= 10)
  assert.ok(s.lines.some((l) => l.q === 'U') && s.lines.some((l) => l.q === 'T'))
  assert.ok(s.ending !== null && s.ending.darkAt + s.ending.cardAfterS <= s.end)
  assert.equal(s.imagery.length, 1)
})
