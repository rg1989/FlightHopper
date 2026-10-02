// client/scene/drawQueue.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queueDraw } from './drawQueue.ts'

const g = globalThis as unknown as Record<string, unknown>

test('queueDraw: jobs run in turn, a frame at a time; a dropped one rejects undrawn, a failing one rejects, the rest still run', async () => {
  const saved = g.requestAnimationFrame
  let frames = 0
  g.requestAnimationFrame = (f: () => void) => setTimeout(() => (frames++, f()), 0)
  try {
    const ran: string[] = []
    const a = queueDraw(() => (ran.push('a'), 1))
    const b = assert.rejects(queueDraw(() => {
      ran.push('b')
      throw new Error('boom')
    }), /boom/)
    const c = assert.rejects(queueDraw(() => (ran.push('c'), 3), () => false), /dropped/)
    const d = queueDraw(() => (ran.push('d'), 4))
    assert.equal(await a, 1)
    await b
    await c
    assert.equal(await d, 4)
    assert.deepEqual(ran, ['a', 'b', 'd'])
    assert.equal(frames, 1, 'quick jobs share a frame')
  } finally {
    g.requestAnimationFrame = saved
  }
})

test('queueDraw: a frame runs jobs for about 6 ms and at least one: slow jobs go a frame each, in order', async (t) => {
  let clock = 0 // each job takes the time it says
  t.mock.method(performance, 'now', () => clock)
  const saved = g.requestAnimationFrame
  let frames = 0
  g.requestAnimationFrame = (f: () => void) => setTimeout(() => (frames++, f()), 0)
  try {
    const ran: number[] = []
    const job = (n: number, ms: number): Promise<number> => queueDraw(() => (ran.push(n), (clock += ms), n))
    await Promise.all([1, 2, 3, 4, 5].map((n) => job(n, 4)))
    assert.deepEqual(ran, [1, 2, 3, 4, 5])
    assert.equal(frames, 3, 'two in a frame (the second ends past 6 ms), then two, then the last alone')
    frames = 0
    await Promise.all([6, 7, 8].map((n) => job(n, 10)))
    assert.equal(frames, 3, 'each past the budget alone: one a frame, never none')
  } finally {
    g.requestAnimationFrame = saved
  }
})
