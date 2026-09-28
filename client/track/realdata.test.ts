// client/track/realdata.test.ts
// The physics on a real arrival (data/fixtures/golden/adsbfi-egll-arrival.jsonl: an A350-900 at Heathrow, adsb.fi at the
// chase rate), played as the app plays it: each sample visible 0.5 s after the server got it, drawn 3.5 s behind at
// 60 fps. The numbers a real airliner keeps: nose up on the glide, no nodding, wings level on final and banked in the
// turn onto it, a speed that never jumps or dips, nose down once it brakes on the runway.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Sample } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import { Track } from './track.ts'

const samples: Sample[] = readFileSync(new URL('../../data/fixtures/golden/adsbfi-egll-arrival.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l) as Sample)
const T0 = samples[0].tMs
const FT = 0.3048

interface F { t: number; s: RenderState }
const frames: F[] = (() => {
  const tr = new Track(samples[0].hex, { pollPeriodS: 1 })
  const out: F[] = []
  let k = 0
  const end = samples[samples.length - 1].rxMs
  for (let now = samples[0].rxMs + 5000; now <= end; now += 1000 / 60) {
    while (k < samples.length && samples[k].rxMs + 500 <= now) tr.add(samples[k++])
    const s = tr.stateAt(now - 3500)
    if (s !== null) out.push({ t: (now - 3500 - T0) / 1000, s })
  }
  return out
})()
const at = (a: number, b: number): F[] => frames.filter((f) => f.t >= a && f.t <= b)
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const pct = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]
const touchdown = (samples.find((s) => s.onGround)!.tMs - T0) / 1000

test('real arrival: on the 3° glide the nose is up about 3°, as flown, and holds steady (no nodding)', (t) => {
  const glide = at(215, 380).filter((f) => !f.s.onGround && (f.s.vsFpm ?? 0) < -500)
  assert.ok(glide.length > 5000, `${glide.length} frames`)
  const p = glide.map((f) => f.s.pitchDeg)
  const wobble: number[] = []
  for (let i = 150; i < p.length - 150; i++) wobble.push(p[i] - p.slice(i - 150, i + 150).reduce((a, b) => a + b, 0) / 300)
  t.diagnostic(`pitch median ${median(p).toFixed(2)}°, range ${Math.min(...p).toFixed(2)}…${Math.max(...p).toFixed(2)}°, wobble p95 ${pct(wobble.map(Math.abs), 0.95).toFixed(2)}°`)
  assert.ok(median(p) > 1.5 && median(p) < 4.5, `median pitch ${median(p)}`)
  assert.ok(pct(wobble.map(Math.abs), 0.95) < 0.5, 'nodding')
})

test('real arrival: banked in the turn onto final, wings level on it', (t) => {
  const turn = at(20, 180).map((f) => Math.abs(f.s.rollDeg))
  const final = at(230, 380).map((f) => Math.abs(f.s.rollDeg))
  t.diagnostic(`turn: max bank ${Math.max(...turn).toFixed(1)}°; final: p95 bank ${pct(final, 0.95).toFixed(1)}°`)
  assert.ok(Math.max(...turn) > 8 && Math.max(...turn) < 30, 'turn bank')
  assert.ok(pct(final, 0.95) < 3, 'final wings level')
})

test('real arrival: the speed never jumps or dips (an A350 changes speed by a knot or two a second)', (t) => {
  // After the first 20 s (a new track settles on its first few samples; a chase starts with its stored history).
  const air = frames.filter((f) => f.t > 20 && f.t < touchdown - 15)
  const rates: number[] = []
  for (let i = 1; i < air.length; i++) rates.push(Math.abs(air[i].s.gsKt! - air[i - 1].s.gsKt!) / (air[i].t - air[i - 1].t))
  const reported = (t0: number): number => samples.filter((s) => Math.abs((s.tMs - T0) / 1000 - t0) < 6 && s.gsKt !== null).map((s) => s.gsKt!)[0]
  const dips = air.filter((f, i) => i % 60 === 0 && f.s.gsKt! < 0.9 * (reported(f.t) ?? f.s.gsKt!))
  t.diagnostic(`GS change p99 ${pct(rates, 0.99).toFixed(2)} kt/s, max ${Math.max(...rates).toFixed(2)} kt/s`)
  // A new sample may revise the speed by under a knot at once (the readout's own step); never more.
  assert.ok(pct(rates, 0.99) < 4 && Math.max(...rates) < 60, 'speed jumps')
  assert.equal(dips.length, 0, 'speed dips')
})

test('real arrival: braking on the runway, still flagged airborne, the nose comes down before the ground flag', (t) => {
  const last = at(touchdown - 4, touchdown - 3.5)
  t.diagnostic(`pitch 4 s before the ground flag: ${last.map((f) => f.s.pitchDeg.toFixed(1)).join(', ')}`)
  assert.ok(last.every((f) => f.s.pitchDeg < 2), 'nose down on the rollout')
})

test('real arrival: pitch and bank never change faster than an airframe can (5°/s, 15°/s)', () => {
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].t - frames[i - 1].t
    assert.ok(Math.abs(frames[i].s.pitchDeg - frames[i - 1].s.pitchDeg) <= 5 * dt + 1e-9, `pitch rate at ${frames[i].t}`)
    assert.ok(Math.abs(frames[i].s.rollDeg - frames[i - 1].s.rollDeg) <= 15 * dt + 1e-9, `roll rate at ${frames[i].t}`)
  }
})

test('real arrival: the drawn height follows the reported altitude within 25 ft steps', () => {
  const air = samples.filter((s) => !s.onGround && s.altGeomFt !== null && s.tMs - T0 > 20_000)
  for (const s of air.filter((_, i) => i % 5 === 0)) {
    const f = frames.find((x) => x.t >= (s.tMs - T0) / 1000)
    if (f === undefined || f.s.onGround) continue
    assert.ok(Math.abs(f.s.hM - s.altGeomFt! * FT) < 12, `height at ${f.t}: ${f.s.hM} vs ${s.altGeomFt! * FT}`)
  }
})
