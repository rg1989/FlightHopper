import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SLOT_MS, newestSlotMs, slotOf, stepFor } from './history.ts'

const at = (iso: string): number => Date.parse(iso)

test('a time falls in the half hour that holds it', () => {
  assert.equal(slotOf(at('2026-09-30T04:00:00Z')), at('2026-09-30T04:00:00Z'))
  assert.equal(slotOf(at('2026-09-30T04:29:59.999Z')), at('2026-09-30T04:00:00Z'))
  assert.equal(slotOf(at('2026-09-30T04:30:00Z')), at('2026-09-30T04:30:00Z'))
  assert.equal(SLOT_MS, 1_800_000)
})

test('the newest published half hour ended at least 90 s ago', () => {
  assert.equal(newestSlotMs(at('2026-10-01T13:50:00Z')), at('2026-10-01T13:00:00Z'))
  assert.equal(newestSlotMs(at('2026-10-01T13:31:29Z')), at('2026-10-01T12:30:00Z')) // 13:00's file: not sure yet
  assert.equal(newestSlotMs(at('2026-10-01T13:31:30Z')), at('2026-10-01T13:00:00Z'))
})

test('wide views keep fewer slices', () => {
  assert.deepEqual([50, 300, 301, 1000, 2500, 5400].map(stepFor), [10, 10, 30, 30, 60, 300])
})
