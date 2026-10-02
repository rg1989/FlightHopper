// client/history/bar.test.ts
// The time bar's pure helpers (the DOM parts are checked in the browser). They work in this machine's time zone, so
// every expectation is built from new Date(y, m, d, …) in that zone too: the tests pass in any zone (TZ=… to try one).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { SLOT_MS, slotOf } from '../../shared/history.ts'

// bar.ts imports its CSS (and the play bar's) for Vite. Node cannot load CSS: this test process loads every .css as an
// empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { localDay, hourScale, quickTimes, parseLocal, daySegments, inputDate, inputTime, localClock, dayMs } = await import('./bar.ts')

const H = 3_600_000
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number => new Date(y, m, d, h, min, s, ms).getTime()

test('localDay: local midnight to the next midnight, labelled like "Tue 22 Sep"', () => {
  const day = localDay(at(2026, 8, 22, 17, 43, 55))
  assert.equal(day.startMs, at(2026, 8, 22))
  assert.equal(day.endMs, at(2026, 8, 23))
  assert.equal(day.label, 'Tue 22 Sep')
  assert.equal(localDay(at(2026, 0, 1, 0, 0, 0)).label, 'Thu 1 Jan')
  assert.equal(localDay(at(2026, 11, 31, 23, 59, 59)).label, 'Thu 31 Dec')
})

test('localDay: a normal day is 86,400 s (15 June: no zone changes its clocks that day)', () => {
  const day = localDay(at(2026, 5, 15, 12))
  assert.equal((day.endMs - day.startMs) / 1000, 86_400)
})

test('localDay: its first millisecond belongs to it, its end to the next day', () => {
  const day = localDay(at(2026, 5, 15, 12))
  assert.deepEqual(localDay(day.startMs), day)
  assert.deepEqual(localDay(day.endMs - 1), day)
  assert.equal(localDay(day.endMs).startMs, day.endMs)
  assert.equal(localDay(day.endMs).label, 'Tue 16 Jun')
})

/** The days of 2026 whose length is not 24 h in this zone (none in UTC). */
function clockChangeDays(): { y: number; m: number; d: number; lenS: number }[] {
  const out: { y: number; m: number; d: number; lenS: number }[] = []
  for (let i = 0; i < 365; i++) {
    const lenS = (at(2026, 0, 2 + i) - at(2026, 0, 1 + i)) / 1000
    if (lenS !== 86_400) {
      const noon = new Date(2026, 0, 1 + i, 12)
      out.push({ y: noon.getFullYear(), m: noon.getMonth(), d: noon.getDate(), lenS })
    }
  }
  return out
}

test('localDay and hourScale on the days the clocks change (23 h, 25 h; Lord Howe 23.5/24.5 h)', (t) => {
  const days = clockChangeDays()
  if (days.length === 0) return t.skip(`no clock changes in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
  for (const { y, m, d, lenS } of days) {
    const day = localDay(at(y, m, d, 12))
    assert.equal(day.startMs, at(y, m, d))
    assert.equal(day.endMs, at(y, m, d + 1))
    assert.equal((day.endMs - day.startMs) / 1000, lenS)
    assert.notEqual(lenS, 86_400)
    const scale = hourScale(day, 3)
    assert.deepEqual(scale.map((s) => s.label), ['00', '03', '06', '09', '12', '15', '18', '21', '24'])
    assert.equal(scale[0].t, 0)
    assert.equal(scale.at(-1)!.t, lenS, 'the last label at the day\'s real end')
    for (let i = 1; i < scale.length; i++) assert.ok(scale[i].t > scale[i - 1].t, `${scale[i].label} after ${scale[i - 1].label}`)
    // At that hour on the clock, or (an hour the change skips, as 03:00 in Athens) where the clock jumps past it.
    for (const s of scale.slice(1, -1)) {
      const c = new Date(day.startMs + s.t * 1000)
      const min = c.getHours() * 60 + c.getMinutes() - Number(s.label) * 60
      assert.ok(min >= 0 && min <= 60, `${s.label} shows ${c.getHours()}:${c.getMinutes()}`)
    }
  }
})

test('hourScale(day, 3): nine labels, "00" to "24", at the seconds after the day starts', () => {
  const scale = hourScale(localDay(at(2026, 5, 15, 12)), 3)
  assert.deepEqual(scale, [
    { t: 0, label: '00' }, { t: 10_800, label: '03' }, { t: 21_600, label: '06' }, { t: 32_400, label: '09' },
    { t: 43_200, label: '12' }, { t: 54_000, label: '15' }, { t: 64_800, label: '18' }, { t: 75_600, label: '21' },
    { t: 86_400, label: '24' },
  ])
})

test('hourScale: other spacings, and none for a step that is not positive', () => {
  const day = localDay(at(2026, 5, 15, 12))
  assert.deepEqual(hourScale(day, 6).map((s) => s.label), ['00', '06', '12', '18', '24'])
  assert.deepEqual(hourScale(day, 5).map((s) => s.label), ['00', '05', '10', '15', '20'])
  assert.deepEqual(hourScale(day, 0), [])
  assert.deepEqual(hourScale(day, -3), [])
})

test('quickTimes: 1 h ago, 6 h ago, Yesterday (24 h), A week ago (7 × 24 h)', () => {
  const now = at(2026, 8, 22, 17, 43, 55, 250)
  const q = quickTimes(now)
  assert.deepEqual(q.map((x) => x.label), ['1 h ago', '6 h ago', 'Yesterday', 'A week ago'])
  assert.deepEqual(q.map((x) => now - x.tMs), [H, 6 * H, 24 * H, 7 * 24 * H])
})

test('parseLocal: the date and time inputs\' values to local ms', () => {
  assert.equal(parseLocal('2026-09-22', '17:43'), at(2026, 8, 22, 17, 43))
  assert.equal(parseLocal('2026-01-01', '00:00'), at(2026, 0, 1))
  assert.equal(parseLocal('2026-12-31', '23:59'), at(2026, 11, 31, 23, 59))
  assert.equal(parseLocal('2026-09-22', '17:43:20'), at(2026, 8, 22, 17, 43, 20), 'a time input may add seconds')
  assert.equal(parseLocal('2028-02-29', '12:00'), at(2028, 1, 29, 12), 'a leap day')
})

test('parseLocal: empty or malformed → null', () => {
  for (const [date, time] of [
    ['', ''], ['2026-09-22', ''], ['', '17:43'], ['22/09/2026', '17:43'], ['2026-9-22', '17:43'], ['2026-09-22', '5:43 PM'],
    ['2026-13-01', '12:00'], ['2026-00-10', '12:00'], ['2026-02-30', '12:00'], ['2027-02-29', '12:00'], ['2026-09-00', '12:00'],
    ['2026-09-22', '24:00'], ['2026-09-22', '12:60'], ['2026-09-22', '12:00:60'], [' 2026-09-22', '17:43'], ['2026-09-22', '17:43 '],
  ]) assert.equal(parseLocal(date, time), null, `${JSON.stringify(date)} ${JSON.stringify(time)}`)
})

test('inputDate, inputTime, localClock: local fields, zero-padded; parseLocal reads the inputs back to the minute', () => {
  const t = at(2026, 8, 2, 7, 3, 5, 900)
  assert.equal(inputDate(t), '2026-09-02')
  assert.equal(inputTime(t), '07:03')
  assert.equal(localClock(t), '07:03:05', 'seconds floored')
  assert.equal(localClock(at(2026, 8, 2, 23, 59, 59, 999)), '23:59:59')
  assert.equal(parseLocal(inputDate(t), inputTime(t)), at(2026, 8, 2, 7, 3))
})

test('daySegments: the half hours in the day as spans of seconds after its start, clipped, merged by state', () => {
  const day = localDay(at(2026, 5, 15, 12))
  const lenS = (day.endMs - day.startMs) / 1000
  const s0 = slotOf(day.startMs) // the half hour holding the day's first second (UTC half hours: before it in a :45 zone)
  const off = (s0 - day.startMs) / 1000 // 0, or up to 30 min before the day starts
  const slot = (k: number): number => s0 + k * SLOT_MS
  const kEnd = (slotOf(day.endMs - 1) - s0) / SLOT_MS // the day's last half hour
  const segs = daySegments(day, [
    { slotMs: slot(7), state: 'ready' },
    { slotMs: slot(-1), state: 'ready' }, // ends as the day starts: not in it
    { slotMs: slot(0), state: 'ready' },
    { slotMs: slot(1), state: 'ready' },
    { slotMs: slot(2), state: 'ready' },
    { slotMs: slot(3), state: 'missing' },
    { slotMs: slot(4), state: 'ready' }, // the client is loading it: striped
    { slotMs: slot(kEnd), state: 'ready' },
    { slotMs: slot(kEnd + 1), state: 'ready' }, // the next day
  ], [slot(4), slot(5)])
  assert.deepEqual(segs, [
    { from: 0, to: off + 5400, state: 'ready' },
    { from: off + 5400, to: off + 7200, state: 'missing' },
    { from: off + 7200, to: off + 10_800, state: 'loading' },
    { from: off + 12_600, to: off + 14_400, state: 'ready' },
    { from: off + kEnd * 1800, to: lenS, state: 'ready' },
  ])
  assert.deepEqual(daySegments(day, [], []), [])
})

test('dayMs: the scrubber\'s seconds to ms in the day, whole; its right edge is the day\'s last ms, not the next midnight', () => {
  const day = localDay(at(2026, 5, 15, 12))
  const lenS = (day.endMs - day.startMs) / 1000
  assert.equal(dayMs(day, 0), day.startMs)
  assert.equal(dayMs(day, 3600), day.startMs + H)
  assert.equal(dayMs(day, 63_000.1), day.startMs + 63_000_100, 'whole ms (the scrubber steps 0.1 s)')
  assert.equal(dayMs(day, lenS), day.endMs - 1, 'End, or a drag to the edge')
  assert.equal(dayMs(day, lenS + 60), day.endMs - 1)
  assert.equal(dayMs(day, -5), day.startMs)
  assert.deepEqual(localDay(dayMs(day, lenS)), day, 'still this day: the bar is not mounted again under the finger')
  assert.equal(localClock(dayMs(day, lenS)), '23:59:59')
})

test('dayMs on the days the clocks change: the edge is still the day\'s last ms', (t) => {
  const days = clockChangeDays()
  if (days.length === 0) return t.skip(`no clock changes in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
  for (const { y, m, d, lenS } of days) {
    const day = localDay(at(y, m, d, 12))
    assert.equal(dayMs(day, lenS), day.endMs - 1)
    assert.deepEqual(localDay(dayMs(day, lenS)), day)
  }
})
