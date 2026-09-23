// client/scene/livery.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { UniformType } from 'cesium'
import type { ModelManifest } from '../types.ts'
import { liveryCode, liveryFromSpec, liveryOf, LiveryShaders, paintShaderText, paintVertexText, TABLE, WHITE } from './livery.ts'

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
    const vs = paintVertexText(m.paint!)
    assert.doesNotMatch(vs, /NaN|undefined/, m.id)
    assert.match(vs, /void vertexMain/)
  }
})

// ---------- scenario liveries: body wrap, span fold, damage ----------

const b744 = manifest.models.find((m) => m.id === 'b744')!
const a320 = manifest.models.find((m) => m.id === 'a320')!
const spec = { base: '#f4f4f1', belly: '#bfc3c7', fin: '#f4f4f1', engine: '#b9bdc1', body: 'livery/body.png', finLogo: 'local/fin.png' }

test('table liveries build their decal URLs from the code; no body wrap', () => {
  assert.equal(liveryOf('DLH').finUrl, '/liveries/DLH-fin.png')
  assert.equal(liveryOf('DLH').titleUrl, '/liveries/DLH-title.png')
  assert.equal(liveryOf('SWA').finUrl, null) // title only
  assert.equal(liveryOf('SWA').titleUrl, '/liveries/SWA-title.png')
  assert.equal(liveryOf('DLH').bodyUrl, null)
  assert.deepEqual([WHITE.bodyUrl, WHITE.finUrl, WHITE.titleUrl], [null, null, null])
})

test('liveryFromSpec: colours with defaults, decal paths resolved against the scenario folder, null when absent', () => {
  const l = liveryFromSpec('scenario:jal123', spec, '/scenarios/jal123/', { body: true, finLogo: true })
  assert.deepEqual(l, {
    code: 'scenario:jal123', base: '#f4f4f1', belly: '#bfc3c7', fin: '#f4f4f1', fin2: '#f4f4f1', engine: '#b9bdc1',
    bodyUrl: '/scenarios/jal123/livery/body.png', finUrl: '/scenarios/jal123/local/fin.png', titleUrl: null,
  })
  const abs = liveryFromSpec('k', { ...spec, title: 'livery/title.png' }, 'http://localhost:5173/scenarios/jal123/', { body: true, finLogo: true })
  assert.equal(abs.bodyUrl, 'http://localhost:5173/scenarios/jal123/livery/body.png')
  assert.equal(abs.titleUrl, 'http://localhost:5173/scenarios/jal123/livery/title.png')
  const missing = liveryFromSpec('k', spec, '/scenarios/jal123/', { body: false, finLogo: false }) // the loader found neither file
  assert.equal(missing.bodyUrl, null)
  assert.equal(missing.finUrl, null)
  const bare = liveryFromSpec('k', { base: '#ffffff', fin: '#ff0000' }, '/s/', { body: true, finLogo: true })
  assert.deepEqual([bare.belly, bare.fin2, bare.engine, bare.bodyUrl, bare.finUrl], ['#ffffff', '#ff0000', '#ffffff', null, null])
})

test('every livery shader declares u_body (blank), u_span and u_cut, off by default', () => {
  const none = liveryFromSpec('k', spec, '/s/', { body: false, finLogo: false }) // no URLs: Node cannot fetch images
  for (const m of [b744, a320]) {
    const s = new LiveryShaders(m.paint!)
    for (const cs of [s.for(null), s.custom(none)]) {
      assert.equal(cs.uniforms.u_span.type, UniformType.FLOAT, m.id)
      assert.equal(cs.uniforms.u_span.value, 0)
      assert.equal(cs.uniforms.u_cut.type, UniformType.FLOAT)
      assert.equal(cs.uniforms.u_cut.value, 0)
      assert.equal(cs.uniforms.u_body.type, UniformType.SAMPLER_2D)
      assert.deepEqual([...(cs.uniforms.u_body.value as { typedArray: Uint8Array }).typedArray], [0, 0, 0, 0], 'a blank 1×1 texture')
    }
  }
})

test('custom() caches by livery code, apart from the table liveries', () => {
  const s = new LiveryShaders(b744.paint!)
  const a = liveryFromSpec('scenario:jal123', spec, '/s/', { body: false, finLogo: false })
  assert.equal(s.custom(a), s.custom({ ...a }))
  assert.notEqual(s.custom(a), s.custom({ ...a, code: 'scenario:other' }))
  assert.notEqual(s.custom({ ...a, code: null }), s.for(null))
})

test('b744 shader: body wrap per the contract, span fold at wingTipY, damage branch; none of them on a320', () => {
  const [zNose, zTail, yBottom, yTop] = b744.paint!.body!
  const fs = paintShaderText(b744.paint!)
  // u runs nose → tail, f top → bottom; the top half of the image is the left side (turned +x); uv.y up, as decal()
  assert.ok(fs.includes(`(${zNose.toFixed(3)} - p.z) / ${(zNose - zTail).toFixed(3)}`), 'u')
  assert.ok(fs.includes(`(${yTop.toFixed(3)} - p.y) / ${(yTop - yBottom).toFixed(3)}`), 'f')
  assert.match(fs, /p\.x > 0\.0 \? 0\.5 \* f : 0\.5 \+ 0\.5 \* f/)
  assert.match(fs, /texture\(t, vec2\(u, 1\.0 - row\)\)/)
  assert.match(fs, /abs\(n\.x\) > 0\.2\) \{ vec4 t = bodyWrap\(u_body, p\)/)
  assert.match(fs, /if \(u_cut > 0\.5\)/)
  assert.match(fs, /discard/)
  assert.match(fs, /czm_backFacing\(\)\) \{ material\.diffuse = vec3\(0\.04\)/)
  const vs = paintVertexText(b744.paint!)
  assert.match(vs, /v_nMC = vsInput\.attributes\.normalMC/)
  assert.match(vs, /u_span > 0\.0 && abs\(q\.x\) > u_span/)
  assert.ok(vs.includes(`min(q.y, ${b744.paint!.wingTipY!.toFixed(3)})`))
  assert.match(vs, /vsOutput\.positionMC = q/)

  assert.doesNotMatch(paintShaderText(a320.paint!), /u_body|u_cut|discard|czm_backFacing/)
  assert.doesNotMatch(paintVertexText(a320.paint!), /u_span/)
})
