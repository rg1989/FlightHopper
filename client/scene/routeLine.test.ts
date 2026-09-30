// client/scene/routeLine.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distanceNm } from '../../shared/geo.ts'
import { greatCircle } from './routeLine.ts'

test('greatCircle: both ends, ~20 nm steps, every point on the shortest way (TLV → LHR passes over the Alps, not Turkey)', () => {
  const tlv = { lat: 32.0114, lon: 34.8867 }
  const lhr = { lat: 51.47, lon: -0.4543 }
  const pts = greatCircle(tlv, lhr)
  const total = distanceNm(tlv.lat, tlv.lon, lhr.lat, lhr.lon)
  assert.deepEqual(pts[0], tlv)
  assert.ok(distanceNm(pts.at(-1)!.lat, pts.at(-1)!.lon, lhr.lat, lhr.lon) < 0.01)
  assert.equal(pts.length, Math.ceil(total / 20) + 1)
  let sum = 0
  for (let i = 1; i < pts.length; i++) sum += distanceNm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon)
  assert.ok(Math.abs(sum - total) < 0.5, `${sum} vs ${total}: no detour`)
  const mid = pts[Math.floor(pts.length / 2)]
  assert.ok(mid.lat > 40 && mid.lat < 46 && mid.lon > 14 && mid.lon < 20, `midpoint ${mid.lat}, ${mid.lon}: over the Adriatic`)
  assert.equal(greatCircle(tlv, tlv).length, 2, 'no leg: its two ends')
  assert.ok(greatCircle({ lat: 0, lon: 0 }, { lat: 0, lon: 179 }).length <= 400, 'capped')
})
