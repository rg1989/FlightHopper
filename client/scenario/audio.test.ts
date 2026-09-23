// client/scenario/audio.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AudioSync, type MediaLike } from './audio.ts'
import type { AudioClip } from './types.ts'

class FakeMedia implements MediaLike {
  currentTime = 0
  volume = 1
  paused = true
  playCalls = 0
  pauseCalls = 0
  playResult: 'resolve' | 'reject' | 'sync' = 'resolve'

  play(): Promise<void> | void {
    this.playCalls++
    if (this.playResult === 'sync') {
      this.paused = false
      return
    }
    if (this.playResult === 'reject') return Promise.reject(new Error('NotAllowedError'))
    this.paused = false
    return Promise.resolve()
  }

  pause(): void {
    this.pauseCalls++
    this.paused = true
  }
}

const CLIPS: AudioClip[] = [{ from: 0, to: 100, at: 1000 }]

/** Stubs console.error for the duration of an async block (the rejection is logged on a later microtask). */
async function withStubbedError(fn: () => void): Promise<unknown[][]> {
  const orig = console.error
  const calls: unknown[][] = []
  console.error = (...args: unknown[]) => {
    calls.push(args)
  }
  try {
    fn()
    await new Promise((r) => setTimeout(r, 0)) // let the rejected play() promise's .catch run
    return calls
  } finally {
    console.error = orig
  }
}

test('plays inside a clip at rate 1 with gain > 0, and seeks to the mapped file time', () => {
  const el = new FakeMedia()
  const sync = new AudioSync(el, CLIPS)
  sync.update(1010, true, 1, 1) // 10 s into the clip → file time 0 + (1010-1000) = 10
  assert.equal(el.currentTime, 10)
  assert.equal(el.paused, false)
  assert.equal(el.playCalls, 1)
})

test('pauses outside every clip', () => {
  const el = new FakeMedia()
  el.paused = false
  const sync = new AudioSync(el, CLIPS)
  sync.update(500, true, 1, 1) // before the clip starts (at 1000)
  assert.equal(el.paused, true)
  assert.equal(el.pauseCalls, 1)
})

test('seeks when drift exceeds 0.25 s', () => {
  const el = new FakeMedia()
  el.paused = false
  el.currentTime = 5 // expected at t=1010 is 10: drift of 5 s
  const sync = new AudioSync(el, CLIPS)
  sync.update(1010, true, 1, 1)
  assert.equal(el.currentTime, 10)
})

test('does not seek when drift is within 0.25 s (no fighting a playing element)', () => {
  const el = new FakeMedia()
  el.paused = false
  el.currentTime = 10.1 // expected 10, drift 0.1
  const sync = new AudioSync(el, CLIPS)
  sync.update(1010, true, 1, 1)
  assert.equal(el.currentTime, 10.1)
})

test('seeks after a scrub (a large jump in t lands inside the clip)', () => {
  const el = new FakeMedia()
  el.paused = false
  el.currentTime = 3
  const sync = new AudioSync(el, CLIPS)
  sync.update(1003, true, 1, 1) // scrubbed straight to t=1003 → expected file time 3: no drift yet
  assert.equal(el.currentTime, 3)
  sync.update(1090, true, 1, 1) // scrubbed to t=1090 → expected file time 90: big jump
  assert.equal(el.currentTime, 90)
})

test('pauses at a rate other than 1, even inside a clip while "playing"', () => {
  const el = new FakeMedia()
  el.paused = false
  const sync = new AudioSync(el, CLIPS)
  sync.update(1010, true, 2, 1)
  assert.equal(el.paused, true)
})

test('volume follows gain while playing inside a clip', () => {
  const el = new FakeMedia()
  const sync = new AudioSync(el, CLIPS)
  sync.update(1010, true, 1, 0.4)
  assert.equal(el.volume, 0.4)
})

test('pauses at gain 0', () => {
  const el = new FakeMedia()
  el.paused = false
  const sync = new AudioSync(el, CLIPS)
  sync.update(1010, true, 1, 0)
  assert.equal(el.paused, true)
})

test('pauses when not playing (paused timeline), even inside a clip', () => {
  const el = new FakeMedia()
  el.paused = false
  const sync = new AudioSync(el, CLIPS)
  sync.update(1010, false, 1, 1)
  assert.equal(el.paused, true)
})

test('never throws when play() rejects, and logs it', async () => {
  const el = new FakeMedia()
  el.playResult = 'reject'
  const sync = new AudioSync(el, CLIPS)
  const calls = await withStubbedError(() => sync.update(1010, true, 1, 1))
  assert.ok(calls.length >= 1)
})

test('a repeated play() rejection logs only once', async () => {
  const el = new FakeMedia()
  el.playResult = 'reject'
  const sync = new AudioSync(el, CLIPS)
  const calls = await withStubbedError(() => {
    sync.update(1010, true, 1, 1)
    sync.update(1011, true, 1, 1)
    sync.update(1012, true, 1, 1)
  })
  assert.equal(calls.length, 1)
})
