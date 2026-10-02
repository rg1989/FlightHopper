import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SLOT_MS } from '../../shared/history.ts'
import { SlotBlock, askNm, backMs, legCovers, legFeeds, legStarted, lookaheadMs, wantedSlots } from './policy.ts'

const H = Date.parse('2026-10-01T10:00:00Z') // a slot start
const MIN = 60_000

test('the half hour asked for holds the replay time, never the one still in progress; the next one ahead of time', () => {
  const maxMs = H + SLOT_MS // 10:00–10:30 is the newest published: 10:30 is where the replay ends
  assert.deepEqual(wantedSlots(H + 5 * MIN, maxMs, 5 * MIN), [H])
  assert.deepEqual(wantedSlots(maxMs, maxMs, 5 * MIN), [H], 'at the very end: still the newest published one')
  assert.deepEqual(wantedSlots(H - 3 * MIN, maxMs, 5 * MIN), [H - SLOT_MS, H], 'near its end: the next one too')
  assert.deepEqual(wantedSlots(H + 27 * MIN, maxMs, 5 * MIN), [H], 'no next one past the newest published')
})

test('a fresh fleet starts far enough back, and the track is fed far enough ahead, for the slice step', () => {
  assert.deepEqual([backMs(10), backMs(60), backMs(300)], [60_000, 90_000, 450_000])
  assert.deepEqual([lookaheadMs(10), lookaheadMs(30), lookaheadMs(300)], [20_000, 60_000, 600_000])
})

test("a missing half hour is not asked again for 10 minutes, a failed one for 15 s; the server's list rebuilds the missing ones", () => {
  const b = new SlotBlock()
  b.missing(H, 0)
  b.failed(H + SLOT_MS, 0)
  assert.deepEqual([b.blocked(H, 14_999), b.blocked(H + SLOT_MS, 14_999), b.isMissing(H, 14_999)], [true, true, true])
  assert.deepEqual([b.blocked(H + SLOT_MS, 15_000), b.isMissing(H + SLOT_MS, 15_000)], [false, false], 'failed: retried')
  assert.equal(b.blocked(H, 10 * MIN), false, 'missing: asked again after 10 min, as the server forgets too')
  b.missing(H, 0)
  b.fromStatus([{ slotMs: H, state: 'ready' }, { slotMs: H - SLOT_MS, state: 'missing' }], 1000)
  assert.deepEqual([b.isMissing(H, 1000), b.isMissing(H - SLOT_MS, 1000)], [false, true], 'the server has it now; the other is missing')
})

test('a leg covers the replay time from a minute before its first point to a minute after its last', () => {
  const leg = { t0Ms: H, t: [0, 600, 1200] } // 10:00 to 10:20
  assert.deepEqual([H - MIN, H + 10 * MIN, H + 21 * MIN].map((t) => legCovers(leg, t)), [true, true, true])
  assert.deepEqual([H - MIN - 1, H + 21 * MIN + 1].map((t) => legCovers(leg, t)), [false, false])
})

test("a half hour is asked for a wider circle than the view, within the view's slice step; a chase asks at least 100 nm", () => {
  assert.equal(askNm(100, false), 130)
  assert.equal(askNm(280, false), 300, 'capped at the band: a wider circle would be cut coarser')
  assert.equal(askNm(500, false), 650)
  assert.equal(askNm(20, false), 26)
  assert.equal(askNm(20, true), 100, 'the chase view moves with its aircraft: a small circle would be asked again every few seconds')
  assert.equal(askNm(5400, false), 5400)
})

test('a leg draws as the flown path once it has started (after it ended too), and feeds the track only from its first point', () => {
  const leg = { t0Ms: H, t: [0, 600, 1200] } // 10:00 to 10:20
  assert.deepEqual([H - MIN, H + 5 * MIN, H + 3 * 60 * MIN].map((t) => legStarted(leg, t)), [true, true, true])
  assert.equal(legStarted(leg, H - MIN - 1), false)
  assert.deepEqual([H - 1, H, H + 21 * MIN, H + 21 * MIN + 1].map((t) => legFeeds(leg, t)), [false, true, true, false])
})
