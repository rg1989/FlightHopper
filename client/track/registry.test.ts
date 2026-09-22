// client/track/registry.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Sample } from '../../shared/types.ts'
import { TrackRegistry } from './registry.ts'

const T0 = 1_760_000_000_000

/** Aircraft `hex` flying north at ~200 kt from (32, 34.9 + lonOffset); t in seconds. */
function s(hex: string, t: number, o: Partial<Sample> = {}): Sample {
  return {
    hex, tMs: T0 + t * 1000, rxMs: T0 + t * 1000 + 1000, lat: 32 + t * 0.001, lon: 34.9, onGround: false, altBaroFt: 5000,
    altGeomFt: 5200, gsKt: 216, trackDeg: 0, trueHeadingDeg: null, rollDeg: null, baroRateFpm: null, geomRateFpm: null,
    navQnhHpa: null, version: 2, nic: 8, quality: 'adsb2', nM: 19.6, callsign: null, typeCode: null, reg: null, ...o,
  }
}

test('ingest routes samples by hex; states() returns only renderable tracks', () => {
  const reg = new TrackRegistry()
  reg.ingest([s('aaa111', 0), s('bbb222', 0, { lon: 35 }), s('aaa111', 1), s('ccc333', 50)])
  assert.equal(reg.get('aaa111')?.newestTMs, T0 + 1000)
  assert.equal(reg.get('bbb222')?.newestTMs, T0)
  assert.equal(reg.get('zzz999'), undefined)
  const st = reg.states(T0 + 500) // ccc333's first sample is still in the future
  assert.deepEqual(st.map((x) => x.hex).sort(), ['aaa111', 'bbb222'])
  assert.equal(st.find((x) => x.hex === 'aaa111')!.mode, 'interp')
})

test('ingest sorts a batch by time, so an out-of-order response is not lost to the deduper', () => {
  const reg = new TrackRegistry()
  reg.ingest([s('aaa111', 2), s('aaa111', 0), s('aaa111', 1)])
  assert.equal(reg.get('aaa111')!.gapP90S(), 1)
  reg.ingest([s('aaa111', 2)]) // re-served
  assert.equal(reg.get('aaa111')!.newestTMs, T0 + 2000)
})

test('delayTargetS: the track target, else the 3 s default', () => {
  const reg = new TrackRegistry({ pollPeriodS: 1 })
  reg.ingest([0, 1, 2, 3].map((t) => s('aaa111', t, { quality: 'mlat' })))
  reg.ingest([0, 5, 10, 15].map((t) => s('bbb222', t)))
  assert.equal(reg.delayTargetS('aaa111'), 6) // MLAT floor
  assert.equal(reg.delayTargetS('bbb222'), 6) // p90 gap 5 s + 1
  assert.equal(reg.delayTargetS('zzz999'), 3)
  assert.equal(reg.delayTargetS(null), 3)
  const slow = new TrackRegistry({ pollPeriodS: 5 })
  slow.ingest([s('aaa111', 0)])
  assert.equal(slow.delayTargetS('aaa111'), 6) // poll period 5 s + 1
})

test('prune drops tracks whose newest sample is older than maxAgeS', () => {
  const reg = new TrackRegistry()
  reg.ingest([s('aaa111', 0), s('bbb222', 50)])
  reg.prune(T0 + 60_000, 30)
  assert.equal(reg.get('aaa111'), undefined)
  assert.ok(reg.get('bbb222'))
  reg.prune(T0 + 80_000, 30)
  assert.ok(reg.get('bbb222'), 'exactly maxAgeS old is kept')
  reg.prune(T0 + 80_001, 30)
  assert.equal(reg.get('bbb222'), undefined)
  assert.deepEqual(reg.states(T0 + 50_000), [])
})
