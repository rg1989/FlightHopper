// client/scene/livery.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { ModelManifest } from '../types.ts'
import { liveryCode, liveryOf, paintShaderText, TABLE, WHITE } from './livery.ts'

const root = new URL('../../', import.meta.url)
const manifest: ModelManifest = JSON.parse(readFileSync(new URL('public/models/manifest.json', root), 'utf8'))

test('livery code: the operator, its brand for a subsidiary or single-partner regional, else null (plain white)', () => {
  assert.equal(liveryCode('DLH681'), 'DLH')
  assert.equal(liveryCode('EJU62BU'), 'EZY') // easyJet Europe flies in easyJet paint
  assert.equal(liveryCode('ENY3321'), 'AAL') // Envoy flies only as American Eagle
  assert.equal(liveryCode('SKW4742'), null) // SkyWest flies for four brands: unknowable
  assert.equal(liveryCode('EJA864'), null) // NetJets: not in the table
  assert.equal(liveryCode('N12345'), null)
  assert.equal(liveryCode(null), null)
  assert.equal(liveryOf(null), WHITE)
  assert.equal(liveryOf('DLH').fin, '#05164d')
  assert.equal(liveryOf('DLH').belly, liveryOf('DLH').base) // omitted fields default
})

test('table: colours are #rrggbb, aliases land on liveries, every decal file exists with a source, none unused', () => {
  const hex = /^#[0-9a-f]{6}$/
  for (const [code, l] of Object.entries(TABLE.liveries)) {
    for (const k of ['base', 'belly', 'fin', 'fin2', 'engine'] as const) {
      const v = l[k]
      if (v !== undefined) assert.match(v, hex, `${code}.${k}`)
    }
  }
  for (const [from, to] of Object.entries(TABLE.aliases)) assert.ok(to in TABLE.liveries, `${from} → ${to}`)
  const wanted = new Set<string>()
  for (const [code, l] of Object.entries(TABLE.liveries)) {
    if (l.title) wanted.add(`${code}-title.png`)
    if (l.finLogo) wanted.add(`${code}-fin.png`)
  }
  for (const f of wanted) {
    assert.ok(existsSync(new URL(`public/liveries/${f}`, root)), f)
    assert.ok(TABLE.logos[f], `source of ${f}`)
  }
  assert.deepEqual(new Set(readdirSync(new URL('public/liveries/', root))), wanted)
})

test('every manifest model with a paint map gives a complete shader', () => {
  const painted = manifest.models.filter((m) => m.paint)
  assert.ok(painted.length > 0)
  for (const m of painted) {
    const glsl = paintShaderText(m.paint!)
    assert.doesNotMatch(glsl, /NaN|undefined/, m.id)
    assert.match(glsl, /void fragmentMain/)
  }
})
