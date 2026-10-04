// client/scene/marchPace.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MARCH_SCALES, MarchPace } from './marchPace.ts'

/** s seconds of frames, each as long as `ms` says for the scale in force; the scales seen, in turn (after `seen`). */
function run(p: MarchPace, ms: number | ((scale: number) => number), s: number, seen: number[] = [p.scale]): number[] {
  for (let t = 0; t < s * 1000;) {
    const dt = typeof ms === 'number' ? ms : ms(p.scale)
    t += dt
    const scale = p.frame(dt)
    if (scale !== seen.at(-1)) seen.push(scale)
  }
  return seen
}

test('MarchPace: the march starts at half size, and stays there while the frames are quick', () => {
  assert.deepEqual(MARCH_SCALES, [0.5, 0.35, 0.25])
  const p = new MarchPace()
  assert.equal(p.scale, 0.5)
  assert.deepEqual(run(p, 16.7, 120), [0.5])
  assert.deepEqual(run(p, 20, 60), [0.5], '50 a second is not slow')
})

test('MarchPace: the first eight seconds are not looked at: the view is loading then, and slow whatever the march', () => {
  const p = new MarchPace()
  assert.deepEqual(run(p, 60, 10), [0.5], 'slow from the start, for 10 s: the first 8 do not count, and 2 are not a while')
  assert.deepEqual(run(p, 16.7, 60), [0.5], 'then quick: nothing changed')
  const slow = new MarchPace()
  assert.deepEqual(run(slow, 60, 14), [0.5, 0.35], 'slow for 14 s: the 6 after the start are a while')
})

test('MarchPace: slow frames for a while make the march coarser; when that made the frames quicker it stays, and it never grows finer again', () => {
  const p = new MarchPace()
  run(p, 16.7, 10) // the start
  assert.deepEqual(run(p, 30, 3), [0.5], 'three seconds of slow frames: not yet')
  const cost = (scale: number): number => (scale === 0.5 ? 30 : 19)
  assert.deepEqual(run(p, cost, 60), [0.5, 0.35], 'a while more: coarser, and quicker for it: kept')
  assert.deepEqual(run(p, 8, 600), [0.35], 'quick frames do not bring the finer march back (it would be slow again)')
})

test('MarchPace: still slow after a step that helped: the next step; the coarsest stays however slow', () => {
  const p = new MarchPace()
  const cost = (scale: number): number => (scale === 0.5 ? 40 : scale === 0.35 ? 30 : 24)
  assert.deepEqual(run(p, cost, 60), [0.5, 0.35, 0.25])
  assert.deepEqual(run(p, 60, 300), [0.25])
})

test('MarchPace: a coarser march that does not make the frames quicker is taken back, and nothing is tried again: the slowness is not the march\'s', () => {
  const p = new MarchPace()
  const cost = (scale: number): number => (scale === 0.5 ? 33 : 32)
  assert.deepEqual(run(p, cost, 60), [0.5, 0.35, 0.5], 'as slow as before: back')
  assert.deepEqual(run(p, 33, 600), [0.5], 'held')
  assert.deepEqual(run(p, 80, 600), [0.5])
})

test('MarchPace: a step that helped and one that did not: the last that helped is kept', () => {
  const p = new MarchPace()
  const cost = (scale: number): number => (scale === 0.5 ? 40 : scale === 0.35 ? 30 : 29.5)
  assert.deepEqual(run(p, cost, 120), [0.5, 0.35, 0.25, 0.35])
  assert.deepEqual(run(p, 50, 600), [0.35], 'held there')
})

test('MarchPace: a hitch is not a while: slow runs between quick ones change nothing, and a gap that is no frame (the tab was hidden) is not counted', () => {
  const p = new MarchPace()
  for (let k = 0; k < 20; k++) {
    run(p, 40, 2)
    run(p, 16.7, 3)
  }
  assert.equal(p.scale, 0.5)
  for (let k = 0; k < 400; k++) {
    p.frame(16.7)
    p.frame(5000)
  }
  assert.equal(p.scale, 0.5)
  p.frame(Number.NaN)
  p.frame(-5)
  assert.equal(p.scale, 0.5)
})

test('MarchPace: reset starts again at half size, watching', () => {
  const p = new MarchPace()
  run(p, (scale) => (scale === 0.5 ? 33 : 32), 30) // taken back and held
  run(p, 40, 30)
  assert.equal(p.scale, 0.5, 'held')
  p.reset()
  run(p, 40, 7)
  assert.equal(p.scale, 0.5, 'after a reset the start is not looked at again')
  run(p, 40, 7)
  assert.equal(p.scale, 0.35, 'and then it tries again')
  p.reset()
  assert.equal(p.scale, 0.5)
})
