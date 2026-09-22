// client/app.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { StatusBrief } from '../shared/api.ts'
import type { ModelManifestEntry } from './types.ts'

// app.ts imports viewer.ts, hud.ts and banner.ts, which import CSS for Vite. Node cannot load CSS, so this file loads
// every .css as an empty module. The hook lives only in this test's process: node --test runs each file in its own.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { attributionFor, placedHeightM, readParams, statusShown, viewRadiusNm } = await import('./app.ts')

test('view radius follows the camera height, in 10 nm steps, clamped to 20–250 nm', () => {
  assert.equal(viewRadiusNm(0), 20)
  assert.equal(viewRadiusNm(150), 20) // chasing on the runway
  assert.equal(viewRadiusNm(37_040), 20) // 20 nm up
  assert.equal(viewRadiusNm(37_041), 30)
  assert.equal(viewRadiusNm(100_000), 60) // 54 nm → next step
  assert.equal(viewRadiusNm(20_000_000), 250) // whole-Earth view
  assert.equal(viewRadiusNm(Number.NaN), 250)
})

test('chased model height: wheels on the terrain on the ground, never below it in the air', () => {
  assert.equal(placedHeightM(-20, true, -31.5), -31.5) // ground: the terrain, whatever the estimator says
  assert.equal(placedHeightM(-20, true, null), -20) // tile not loaded yet: the estimate
  assert.equal(placedHeightM(-40, false, -31.5), -31.5) // airborne below the terrain: lifted to it
  assert.equal(placedHeightM(300, false, -31.5), 300) // airborne above: untouched
  assert.equal(placedHeightM(300, false, null), 300)
})

test('URL parameters: ?hex= (lower-cased, validated), ?bench=1, ?airport=', () => {
  assert.deepEqual(readParams('?hex=A1B2C3&bench=1'), { hex: 'a1b2c3', bench: true, airport: null })
  assert.deepEqual(readParams('?hex=~a330e6'), { hex: '~a330e6', bench: false, airport: null })
  assert.deepEqual(readParams('?hex=nope&bench=true&airport=llbg'), { hex: null, bench: false, airport: 'LLBG' })
  assert.deepEqual(readParams(''), { hex: null, bench: false, airport: null })
})

test('attribution: adsb.lol ODbL, OurAirports, the model licence', () => {
  const m: ModelManifestEntry = {
    id: 'cesium-air',
    uri: 'models/Cesium_Air.glb',
    license: 'Apache-2.0: CesiumJS repository LICENSE.md',
    author: 'CesiumJS Contributors (Cesium GS, Inc.)',
    source: 'https://github.com/CesiumGS/cesium',
    forwardAxisFix: { headingDeg: -90, pitchDeg: 0, rollDeg: 0 },
    gearHeightM: 4.03,
    lengthM: 37.57,
    scale: 1.7555,
  }
  const lines = attributionFor(m)
  assert.ok(lines.some((l) => /adsb\.lol/.test(l) && /ODbL/.test(l)), lines.join(' | '))
  assert.ok(lines.some((l) => /OurAirports/.test(l)))
  assert.ok(lines.includes('3D model: CesiumJS Contributors (Cesium GS, Inc.), Apache-2.0'), lines.join(' | '))
  assert.equal(attributionFor(null).length, lines.length - 1)
})

test('status shown: 3 failed polls in a row read as "upstream-down"; fewer change nothing', () => {
  const ok: StatusBrief = { source: 'replay', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }
  assert.equal(statusShown(ok, 0), ok)
  assert.equal(statusShown(ok, 2), ok)
  assert.deepEqual(statusShown(ok, 3), { ...ok, degraded: 'upstream-down' })
  assert.deepEqual(statusShown({ ...ok, degraded: 'blocked' }, 0), { ...ok, degraded: 'blocked' })
})
