// client/history/bar.test.ts
// The time bar's pure helpers: the day, the rail's spans, what exists (bounds), the day arrows, the Go to form (the DOM
// parts are checked in the browser). They work in this machine's time zone, so every expectation is built from
// new Date(y, m, d, …) in that zone too: the tests pass in any zone (TZ=… to try one).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { SLOT_MS, slotOf } from '../../shared/history.ts'

// bar.ts imports its CSS (and the play bar's) for Vite. Node cannot load CSS: this test process loads every .css as an
// empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const {
  localDay, hourScale, quickTimes, parseLocal, daySegments, dayReach, clampMs, inBounds, dayStep, quickJumps, timeLimits, goMoment,
  inputDate, inputTime, localClock, dayMs,
} = await import('./bar.ts')

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

test('daySegments: the half hours upstream lacks, in the day, as spans of seconds after its start, clipped, touching ones merged', () => {
  const day = localDay(at(2026, 5, 15, 12))
  const lenS = (day.endMs - day.startMs) / 1000
  const s0 = slotOf(day.startMs) // the half hour holding the day's first second (UTC half hours: before it in a :45 zone)
  const off = (s0 - day.startMs) / 1000 // 0, or up to 30 min before the day starts
  const slot = (k: number): number => s0 + k * SLOT_MS
  const kEnd = (slotOf(day.endMs - 1) - s0) / SLOT_MS // the day's last half hour
  const segs = daySegments(day, [], [
    slot(7),
    slot(-1), // ends as the day starts: not in it
    slot(0),
    slot(1),
    slot(2),
    slot(4),
    slot(4), // twice: once
    slot(kEnd),
    slot(kEnd + 1), // the next day
  ])
  assert.deepEqual(segs, [
    { from: 0, to: off + 5400, state: 'missing' }, // half hours 0, 1 and 2 touch: one span, cut at the day's start
    { from: off + 7200, to: off + 9000, state: 'missing' },
    { from: off + 12_600, to: off + 14_400, state: 'missing' },
    { from: off + kEnd * 1800, to: lenS, state: 'missing' }, // cut at the day's end
  ])
  assert.deepEqual(daySegments(day, [], []), [])
})

test('daySegments: the legs of the followed aircraft, clipped to the day; overlapping or touching ones merge', () => {
  const day = localDay(at(2026, 5, 15, 12))
  const lenS = (day.endMs - day.startMs) / 1000
  const ms = (s: number): number => day.startMs + s * 1000
  assert.deepEqual(daySegments(day, [
    { fromMs: ms(54_000), toMs: ms(57_000) }, // out of order, and two that overlap…
    { fromMs: ms(36_000), toMs: ms(43_200) }, // a flight of its own
    { fromMs: ms(56_000), toMs: ms(60_000) },
    { fromMs: ms(60_000), toMs: ms(61_000) }, // …and one that touches: one span
    { fromMs: ms(-7200), toMs: ms(1800) }, // began the evening before: from the day's start
    { fromMs: ms(lenS - 600), toMs: ms(lenS + 7200) }, // goes on past midnight: to the day's end
    { fromMs: ms(-9000), toMs: ms(-1) }, // the day before only: none
    { fromMs: ms(lenS), toMs: ms(lenS + 100) }, // the day after only: none
    { fromMs: ms(50_000), toMs: ms(50_000) }, // one instant: none
    { fromMs: Number.NaN, toMs: ms(70_000) }, // no time: none
  ], []), [
    { from: 0, to: 1800, state: 'leg' },
    { from: 36_000, to: 43_200, state: 'leg' },
    { from: 54_000, to: 61_000, state: 'leg' },
    { from: lenS - 600, to: lenS, state: 'leg' },
  ])
})

test('daySegments: the missing half hours first, the legs after them (drawn over): a flight through a gap shows both', () => {
  const day = localDay(at(2026, 5, 15, 12))
  const ms = (s: number): number => day.startMs + s * 1000
  const gap = slotOf(ms(43_200))
  const from = (gap - day.startMs) / 1000
  assert.deepEqual(daySegments(day, [{ fromMs: ms(40_000), toMs: ms(50_000) }], [gap]), [
    { from, to: from + 1800, state: 'missing' },
    { from: 40_000, to: 50_000, state: 'leg' },
  ])
})

// What exists: the oldest and the newest moment (the app says them through setBounds), here four days and a bit apart.
const oldest = at(2026, 8, 20, 14, 7, 31) // Sun 20 Sep 14:07:31
const newest = at(2026, 8, 24, 12, 30) // Thu 24 Sep 12:30

test('dayReach: the oldest day is hatched before the oldest moment, the newest day after the newest; the days between neither', () => {
  const reach = (d: number) => dayReach(localDay(at(2026, 8, d, 12)), oldest, newest)
  assert.deepEqual(reach(20), { floorS: 50_851, limitS: null }) // 14:07:31
  assert.deepEqual(reach(21), { floorS: null, limitS: null })
  assert.deepEqual(reach(22), { floorS: null, limitS: null })
  assert.deepEqual(reach(23), { floorS: null, limitS: null })
  assert.deepEqual(reach(24), { floorS: null, limitS: 45_000 }) // 12:30
})

test('dayReach: a day holding both ends has both; a day wholly outside is all hatch; the day\'s own edges are no hatch', () => {
  const day = localDay(at(2026, 8, 22, 12))
  assert.deepEqual(dayReach(day, at(2026, 8, 22, 8), at(2026, 8, 22, 20)), { floorS: 28_800, limitS: 72_000 })
  assert.deepEqual(dayReach(localDay(at(2026, 8, 19, 12)), oldest, newest), { floorS: 86_400, limitS: null }, 'before the oldest: all floor')
  assert.deepEqual(dayReach(localDay(at(2026, 8, 25, 12)), oldest, newest), { floorS: null, limitS: 0 }, 'after the newest: all limit')
  assert.deepEqual(dayReach(day, day.startMs, day.endMs), { floorS: null, limitS: null }, 'the oldest moment at its start, the newest at its end')
  assert.deepEqual(dayReach(day, day.startMs + 1000, day.endMs - 1000), { floorS: 1, limitS: 86_399 })
})

test('clampMs and inBounds: a moment exists from the oldest to the newest, both ends included', () => {
  const mid = at(2026, 8, 22)
  assert.deepEqual([oldest - 1, oldest, mid, newest, newest + 1].map((t) => clampMs(t, oldest, newest)), [oldest, oldest, mid, newest, newest])
  assert.deepEqual([oldest - 1, oldest, mid, newest, newest + 1].map((t) => inBounds(t, oldest, newest)), [false, true, true, true, false])
  assert.equal(inBounds(Number.NaN, oldest, newest), false)
})

test('dayStep: in between, the day before and the day after at the same clock time, to the second', () => {
  const t = at(2026, 8, 22, 17, 43, 55, 250)
  assert.equal(dayStep(t, -1, oldest, newest), at(2026, 8, 21, 17, 43, 55))
  assert.equal(dayStep(t, 1, oldest, newest), at(2026, 8, 23, 17, 43, 55))
})

test('dayStep: on the oldest day the arrow back is off (null), wherever in it; the arrow on goes to the same clock time', () => {
  for (const t of [at(2026, 8, 20), at(2026, 8, 20, 18), at(2026, 8, 20, 23, 59, 59)]) assert.equal(dayStep(t, -1, oldest, newest), null)
  assert.equal(dayStep(at(2026, 8, 20, 18), 1, oldest, newest), at(2026, 8, 21, 18))
})

test('dayStep: on the newest day (today) the arrow on is off (null), wherever in it; the arrow back goes to the same clock time', () => {
  for (const t of [at(2026, 8, 24), at(2026, 8, 24, 9, 15), at(2026, 8, 24, 23, 59, 59)]) assert.equal(dayStep(t, 1, oldest, newest), null)
  assert.equal(dayStep(at(2026, 8, 24, 9, 15), -1, oldest, newest), at(2026, 8, 23, 9, 15))
})

test('dayStep: a target past either end is held at it', () => {
  assert.equal(dayStep(at(2026, 8, 21, 9), -1, oldest, newest), oldest, '09:00 on the oldest day is before its oldest moment')
  assert.equal(dayStep(at(2026, 8, 21, 18), -1, oldest, newest), at(2026, 8, 20, 18), '18:00 is after it: as it is')
  assert.equal(dayStep(at(2026, 8, 23, 18), 1, oldest, newest), newest, '18:00 today is past the newest moment')
  assert.equal(dayStep(at(2026, 8, 23, 9), 1, oldest, newest), at(2026, 8, 24, 9), '09:00 is before it: as it is')
})

test('dayStep: a range inside one day has no arrows', () => {
  const [min, max] = [at(2026, 8, 22, 8), at(2026, 8, 22, 20)]
  for (const dir of [-1, 1] as const) assert.equal(dayStep(at(2026, 8, 22, 12), dir, min, max), null)
})

test('dayStep: over the end of a month and of a year', () => {
  const [min, max] = [at(2026, 8, 1), at(2026, 9, 5)]
  assert.equal(dayStep(at(2026, 9, 1, 10, 15, 30), -1, min, max), at(2026, 8, 30, 10, 15, 30))
  assert.equal(dayStep(at(2026, 8, 30, 10, 15, 30), 1, min, max), at(2026, 9, 1, 10, 15, 30))
  const [from, to] = [at(2026, 11, 1), at(2027, 0, 10)]
  assert.equal(dayStep(at(2026, 11, 31, 23, 59, 59), 1, from, to), at(2027, 0, 1, 23, 59, 59))
  assert.equal(dayStep(at(2027, 0, 1, 0, 0, 1), -1, from, to), at(2026, 11, 31, 0, 0, 1))
})

test('dayStep: the same time on the wall across the days the clocks change, not 24 h on', (t) => {
  const days = clockChangeDays()
  if (days.length === 0) return t.skip(`no clock changes in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
  for (const { y, m, d } of days) {
    const [lo, hi] = [at(y, m, d - 5), at(y, m, d + 5)]
    assert.equal(dayStep(at(y, m, d - 1, 12), 1, lo, hi), at(y, m, d, 12), 'into the day of the change')
    assert.equal(dayStep(at(y, m, d, 12), 1, lo, hi), at(y, m, d + 1, 12), 'and out of it')
    assert.equal(dayStep(at(y, m, d, 12), -1, lo, hi), at(y, m, d - 1, 12))
    assert.equal(dayStep(at(y, m, d + 1, 12), -1, lo, hi), at(y, m, d, 12))
  }
})

test('quickJumps: each chip is on only while its moment exists (inside the bounds, both ends included)', () => {
  const now = at(2026, 8, 22, 17, 43, 55)
  const on = (min: number, max: number): boolean[] => quickJumps(now, min, max).map((q) => q.enabled)
  assert.deepEqual(quickJumps(now, 0, now).map(({ label, tMs }) => ({ label, tMs })), quickTimes(now), 'the same chips as quickTimes')
  assert.deepEqual(on(now - 30 * 24 * H, now - 600_000), [true, true, true, true])
  assert.deepEqual(on(now - 3 * 24 * H, now - 600_000), [true, true, true, false], 'the oldest moment is three days back: not a week')
  assert.deepEqual(on(now - 12 * H, now - 600_000), [true, true, false, false])
  assert.deepEqual(on(now - 6 * H, now - H), [true, true, false, false], 'both ends included: 6 h ago the oldest, 1 h ago the newest')
  assert.deepEqual(on(now - 30 * 24 * H, now - 2 * H), [false, true, true, true], 'the newest moment is two hours old: 1 h ago is past it')
  assert.deepEqual(on(now - 30 * 24 * H, now - 7 * H), [false, false, true, true])
})

test('timeLimits and the date field: the first and last day hold the time field to the first and last whole minute that exists; days between none', () => {
  assert.equal(inputDate(oldest), '2026-09-20', 'the date field\'s min: the local day of the oldest moment')
  assert.equal(inputDate(newest), '2026-09-24', 'and its max: the newest')
  assert.deepEqual(timeLimits('2026-09-20', oldest, newest), { min: '14:08', max: '' }, '14:07 is before 14:07:31')
  assert.deepEqual(timeLimits('2026-09-24', oldest, newest), { min: '', max: '12:30' })
  for (const d of ['2026-09-21', '2026-09-22', '2026-09-23', '', '2026-09-19', '2026-09-25']) {
    assert.deepEqual(timeLimits(d, oldest, newest), { min: '', max: '' }, `${JSON.stringify(d)}: cleared`)
  }
  assert.deepEqual(timeLimits('2026-09-20', at(2026, 8, 20, 14, 7), newest), { min: '14:07', max: '' }, 'a whole minute is itself')
  assert.deepEqual(timeLimits('2026-09-24', oldest, at(2026, 8, 24, 12, 30, 45)), { min: '', max: '12:30' }, 'the next minute is past it')
  assert.deepEqual(timeLimits('2026-09-22', at(2026, 8, 22, 8), at(2026, 8, 22, 20)), { min: '08:00', max: '20:00' }, 'one day: both')
})

test('goMoment: the form\'s moment when it is real and exists; null (Go off) for an impossible one or one beyond the oldest or newest', () => {
  assert.equal(goMoment('2026-09-22', '17:43', oldest, newest), at(2026, 8, 22, 17, 43))
  assert.equal(goMoment('2026-09-24', '12:30', oldest, newest), newest, 'the newest moment itself')
  assert.equal(goMoment('2026-09-20', '14:07:31', oldest, newest), oldest, 'and the oldest (a time field may carry seconds)')
  assert.equal(goMoment('2026-09-20', '14:08', oldest, newest), at(2026, 8, 20, 14, 8))
  for (const [date, time] of [
    ['2026-09-20', '14:07'], // 31 s before the oldest moment
    ['2026-09-20', '00:00'], ['2026-09-19', '23:59'],
    ['2026-09-24', '12:31'], ['2026-09-25', '00:00'], ['2026-10-24', '12:00'],
    ['', '12:00'], ['2026-09-22', ''], ['2026-02-30', '12:00'], ['2026-09-22', '25:00'],
  ]) assert.equal(goMoment(date, time, oldest, newest), null, `${date} ${time}`)
})

test('the time field\'s limits and Go agree on every minute of the first day and of the last', (t) => {
  for (const [date, at0] of [['2026-09-20', oldest], ['2026-09-24', newest]] as const) {
    const day = localDay(at0)
    if (day.endMs - day.startMs !== 86_400_000) return t.skip('a day of the clocks changing')
    const lim = timeLimits(date, oldest, newest)
    for (let min = 0; min < 1440; min++) {
      const time = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
      const inField = (lim.min === '' || time >= lim.min) && (lim.max === '' || time <= lim.max)
      assert.equal(goMoment(date, time, oldest, newest) !== null, inField, `${date} ${time}`)
    }
  }
})

test('timeLimits: in the first day\'s last minute the field\'s min falls on the next day\'s 00:00, and Go alone holds the day', () => {
  const late = at(2026, 8, 20, 23, 59, 30)
  assert.deepEqual(timeLimits('2026-09-20', late, newest), { min: '00:00', max: '' })
  assert.equal(goMoment('2026-09-20', '23:59', late, newest), null, '23:59:00 is 30 s before the oldest moment')
  assert.equal(goMoment('2026-09-21', '00:00', late, newest), at(2026, 8, 21))
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
