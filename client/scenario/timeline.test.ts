// client/scenario/timeline.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NO_DAMAGE, captionsAt, damageOf, damagePart, endingAt, eventStateAt, marks, storyAt, STORY_S } from './timeline.ts'
import type { EndingSpec, EventRow, Line } from './types.ts'

function ev(p: Partial<EventRow>): EventRow {
  return { t: 0, type: 'mark', value: '', label: '', src: null, ...p }
}

function line(p: Partial<Line>): Line {
  return { t: 0, dur: 2, speaker: 'CAP', to: null, channel: 'cockpit', lang: 'en', text: '', original: null, q: 'D', src: null, ...p }
}

// ---------- eventStateAt ----------

test('eventStateAt: gear toggles by value (1 down, 0 up)', () => {
  const events = [ev({ t: 10, type: 'gear', value: '1' }), ev({ t: 20, type: 'gear', value: '0' }), ev({ t: 30, type: 'gear', value: '1' })]
  assert.equal(eventStateAt(events, 5).gear, false)
  assert.equal(eventStateAt(events, 10).gear, true)
  assert.equal(eventStateAt(events, 15).gear, true)
  assert.equal(eventStateAt(events, 20).gear, false)
  assert.equal(eventStateAt(events, 30).gear, true)
})

test("damagePart: 'fin', or the rudder lost between two fractions of the fin's height; anything else null", () => {
  assert.deepEqual(damagePart('fin'), { fin: true })
  assert.deepEqual(damagePart('rudder:0.35-0.88'), { rudder: [0.35, 0.88] })
  assert.deepEqual(damagePart('rudder:0-1'), { rudder: [0, 1] })
  for (const v of ['', 'rudder', 'rudder:0.9-0.3', 'rudder:0.5-1.2', 'rudder:a-b', 'tail']) assert.equal(damagePart(v), null, v)
  assert.deepEqual(damageOf(new Set()), NO_DAMAGE)
  assert.deepEqual(damageOf(new Set(['rudder:0.35-0.88', 'fin'])), { fin: true, rudder: [0.35, 0.88] })
})

test('eventStateAt: damage accumulates part ids (never clears)', () => {
  const events = [ev({ t: 10, type: 'damage', value: 'fin' }), ev({ t: 20, type: 'damage', value: 'rudder' })]
  assert.deepEqual([...eventStateAt(events, 5).damage], [])
  assert.deepEqual([...eventStateAt(events, 10).damage], ['fin'])
  assert.deepEqual([...eventStateAt(events, 25).damage], ['fin', 'rudder'])
})

test('eventStateAt: phase is the label of the last phase event at or before t', () => {
  const events = [ev({ t: 0, type: 'phase', label: 'Departure' }), ev({ t: 100, type: 'phase', label: 'Climb' }), ev({ t: 200, type: 'phase', label: 'Cruise' })]
  assert.equal(eventStateAt(events, -1).phase, null)
  assert.equal(eventStateAt(events, 0).phase, 'Departure')
  assert.equal(eventStateAt(events, 150).phase, 'Climb')
  assert.equal(eventStateAt(events, 500).phase, 'Cruise')
})

test('eventStateAt: flaps is the numeric value of the last flaps event at or before t, else null', () => {
  const events = [ev({ t: 10, type: 'flaps', value: '5' }), ev({ t: 20, type: 'flaps', value: '20' })]
  assert.equal(eventStateAt(events, 5).flaps, null)
  assert.equal(eventStateAt(events, 10).flaps, 5)
  assert.equal(eventStateAt(events, 25).flaps, 20)
})

// ---------- marks ----------

test('marks: only type "mark" rows, in order, {t, label}', () => {
  const events = [ev({ t: 1, type: 'mark', label: 'A' }), ev({ t: 2, type: 'gear', value: '1' }), ev({ t: 3, type: 'mark', label: 'B' })]
  assert.deepEqual(marks(events), [{ t: 1, label: 'A' }, { t: 3, label: 'B' }])
})

// ---------- captionsAt ----------

test('captionsAt: only lines whose [t, t+dur) contains t, oldest first', () => {
  const lines = [line({ t: 0, dur: 2, text: 'a' }), line({ t: 1, dur: 2, text: 'b' }), line({ t: 10, dur: 2, text: 'c' })]
  const active = captionsAt(lines, 1.5)
  assert.deepEqual(active.map((l) => l.text), ['a', 'b']) // c is not active yet; a starts before b
})

test('captionsAt: a line is gone once t reaches t+dur', () => {
  const lines = [line({ t: 0, dur: 2, text: 'a' })]
  assert.deepEqual(captionsAt(lines, 1.999).map((l) => l.text), ['a'])
  assert.deepEqual(captionsAt(lines, 2).map((l) => l.text), [])
})

test('captionsAt: caps at max, keeping the newest, oldest first', () => {
  const lines = [0, 1, 2, 3, 4].map((i) => line({ t: i, dur: 10, text: `L${i}` }))
  assert.deepEqual(captionsAt(lines, 4, 3).map((l) => l.text), ['L2', 'L3', 'L4'])
})

test('captionsAt: default max is 3', () => {
  const lines = [0, 1, 2, 3].map((i) => line({ t: i, dur: 10, text: `L${i}` }))
  assert.equal(captionsAt(lines, 3).length, 3)
})

// ---------- endingAt ----------

const ENDING: EndingSpec = { fadeFrom: 100, darkAt: 110, cardAfterS: 5, card: { title: 'T', lines: [] } }

test('endingAt: fade is 0 before fadeFrom', () => {
  assert.deepEqual(endingAt(ENDING, 99), { fade: 0, card: false })
})

test('endingAt: fade is 0.5 at the smoothstep midpoint', () => {
  const r = endingAt(ENDING, 105)
  assert.equal(r.fade, 0.5)
  assert.equal(r.card, false)
})

test('endingAt: fade is 1 from darkAt on', () => {
  assert.deepEqual(endingAt(ENDING, 110), { fade: 1, card: false })
  assert.equal(endingAt(ENDING, 112).fade, 1) // still before the card, fade already pinned at 1
  assert.equal(endingAt(ENDING, 999).fade, 1) // long after the card too
})

test('endingAt: card is true once darkAt + cardAfterS is reached', () => {
  assert.equal(endingAt(ENDING, 114.99).card, false)
  assert.equal(endingAt(ENDING, 115).card, true)
})

test('endingAt: a null ending is always {fade: 0, card: false}', () => {
  assert.deepEqual(endingAt(null, 999), { fade: 0, card: false })
})

test('storyAt: the latest story at or before t while it lasts (its value in seconds, else STORY_S); other types ignored', () => {
  const events = [
    ev({ t: 100, type: 'story', label: 'Take-off' }),
    ev({ t: 105, type: 'mark', label: 'not a story' }),
    ev({ t: 130, type: 'story', value: '5', label: 'Bang' }),
  ]
  assert.equal(storyAt(events, 99), null)
  assert.deepEqual(storyAt(events, 100), { key: 's0', t: 100, text: 'Take-off' })
  assert.equal(storyAt(events, 100 + STORY_S - 0.01)?.text, 'Take-off')
  assert.equal(storyAt(events, 100 + STORY_S), null, 'gone after its seconds')
  assert.equal(storyAt(events, 134.9)?.text, 'Bang', 'its own 5 s')
  assert.equal(storyAt(events, 135), null)
})
