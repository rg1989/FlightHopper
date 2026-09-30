// client/scene/modelFor.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { ModelManifest, ModelManifestEntry } from '../types.ts'
import { ModelPicker } from './modelFor.ts'

const e = (id: string, types: string[] = []): ModelManifestEntry => ({
  id, uri: `models/${id}.glb`, license: 'x', author: 'x', source: 'x', forwardAxisFix: { headingDeg: 90, pitchDeg: 0, rollDeg: 0 },
  gearHeightM: 1, lengthM: 30, scale: 1, types,
})
const man: ModelManifest = {
  default: 'generic',
  fallback: { A1: 'c182', A2: 'c550', A3: 'a320', A4: 'a321', A5: 'b789', A7: 'ec135', light: 'c182', jet: 'a320', heavy: 'b789', heli: 'ec135' },
  models: [
    e('generic'), e('a320', ['A320', 'A20N']), e('a321', ['A321', 'A21N']), e('b738', ['B73*', 'B38M']), e('b789', ['B789']),
    e('c550', ['C25*', 'C68A']), e('c182', ['C1*', 'C2*']), e('ec135', ['EC35']), e('b744', ['B744', 'A388']),
  ],
}
const pick = new ModelPicker(man)
const id = (type: string | null, cat: string | null = null): string => pick.for(type, cat).id

test('exact designator first, then the longest prefix', () => {
  assert.equal(id('A21N', 'A3'), 'a321')
  assert.equal(id('B38M'), 'b738')
  assert.equal(id('B739'), 'b738') // B73* prefix
  assert.equal(id('C25B'), 'c550') // C25* beats C2*
  assert.equal(id('C208'), 'c182')
  assert.equal(id('a388'), 'b744') // designators are upper-cased
})

test('unlisted types: a helicopter designator wins, then the ADS-B category, then the type family', () => {
  assert.equal(id('R44', 'A1'), 'ec135') // a helicopter squawking A1
  assert.equal(id('GLF6', 'A2'), 'c550')
  assert.equal(id('B77W', null), 'b789') // heavy list
  assert.equal(id('PA46', null), 'c182') // light pattern
  assert.equal(id('XYZ9', null), 'a320') // unknown jet
  assert.equal(id(null, 'A5'), 'b789')
  assert.equal(id(null, 'A7'), 'ec135')
})

test('no type and no category (or a ground vehicle): the default model', () => {
  assert.equal(id(null, null), 'generic')
  assert.equal(id('', 'C1'), 'generic')
})

test('a fallback naming a missing model is a manifest error', () => {
  assert.throws(() => new ModelPicker({ ...man, fallback: { A1: 'nope' } }), /nope/)
})

test('the shipped manifest: E190s and E195s (and their E2s) fly the E190 model; E170s, E175s and the ERJ family the E175', () => {
  const shipped = new ModelPicker(JSON.parse(readFileSync(new URL('../../public/models/manifest.json', import.meta.url), 'utf8')))
  for (const t of ['E190', 'E195', 'E290', 'E295']) assert.equal(shipped.for(t, 'A3').id, 'e190', t)
  for (const t of ['E170', 'E175', 'E75L', 'E75S', 'E135', 'E145', 'E45X']) assert.equal(shipped.for(t, 'A3').id, 'e75l', t)
})

test('the shipped manifest: the 707 and DC-8 families (tankers, AWACS, E-6) fly the four-engine model, not a twin', () => {
  const shipped = new ModelPicker(JSON.parse(readFileSync(new URL('../../public/models/manifest.json', import.meta.url), 'utf8')))
  for (const t of ['K35R', 'K35E', 'C135', 'R135', 'E3TF', 'E3CF', 'E6', 'B703', 'B701', 'B720', 'DC86', 'DC87']) assert.equal(shipped.for(t, 'A5').id, 'b744', t)
  for (const t of ['P8', 'E737']) assert.equal(shipped.for(t, 'A5').id, 'b738', t) // 737 airframes
  assert.equal(shipped.for('K46', 'A5').id, 'b789', 'the KC-46 is a 767: the widebody twin')
})
