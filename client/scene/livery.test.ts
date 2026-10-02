// client/scene/livery.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { Cartesian2, UniformType } from 'cesium'
import { DESIGNS } from '../livery/designs/index.ts'
import { drawDesign, profileOf } from '../livery/kit.ts'
import type { Op } from '../livery/kit.ts'
import type { ModelManifest, ModelManifestEntry } from '../types.ts'
import { liveryCode, MILITARY, liveryFromSpec, liveryOf, LiveryShaders, paintShaderText, paintVertexText, TABLE, WHITE } from './livery.ts'

const root = new URL('../../', import.meta.url)
const manifest: ModelManifest = JSON.parse(readFileSync(new URL('public/models/manifest.json', root), 'utf8'))
const b744 = manifest.models.find((m) => m.id === 'b744')!
const a320 = manifest.models.find((m) => m.id === 'a320')!

/** The ops a livery code draws on a model's left side. */
const leftOps = (code: string | null, m: ModelManifestEntry = a320): Op[] =>
  drawDesign(liveryOf(code).design, { id: m.id, profile: profileOf(m)!, paint: m.paint }).skin.left
const colours = (ops: Op[]): string[] => ops.flatMap((o) => ((o.k === 'fill' || o.k === 'path') && typeof o.color === 'string' ? [o.color] : []))
const images = (ops: Op[]): string[] => ops.flatMap((o) => (o.k === 'image' || o.k === 'wrap' ? [o.src] : []))

test('livery code: the operator, its brand for a subsidiary or single-partner regional, else null (plain white)', () => {
  assert.equal(liveryCode('DLH681'), 'DLH')
  assert.equal(liveryCode('EJU62BU'), 'EZY') // easyJet Europe flies in easyJet paint
  assert.equal(liveryCode('ENY3321'), 'AAL') // Envoy flies only as American Eagle
  assert.equal(liveryCode('SKW4742'), null) // SkyWest flies for four brands: unknowable
  assert.equal(liveryCode('EJA864'), null) // NetJets: not in the table
  assert.equal(liveryCode('N12345'), null)
  assert.equal(liveryCode(null), null)
  assert.equal(liveryOf(null), WHITE)
  assert.equal(liveryOf('XXX'), WHITE)
})

test('a military aircraft without an airline livery flies in grey, not white; one with an airline callsign keeps it', () => {
  assert.equal(liveryCode(null, '59-1472', true), MILITARY)
  assert.equal(liveryCode('RCH871', null, true), MILITARY) // USAF Air Mobility Command's "Reach": no airline livery
  assert.equal(liveryCode('DLH681', null, true), 'DLH')
  assert.equal(liveryCode(null, null, false), null)
  assert.notEqual(liveryOf(MILITARY), WHITE)
  assert.notEqual(liveryOf(MILITARY).design.base, WHITE.design.base)
  assert.equal(liveryOf(MILITARY).design.wing, liveryOf(MILITARY).design.base, 'grey wings too, not the airliners\' light grey')
})

test('a colours-only table livery draws the old regions: base, belly, fin, fin2, decals at the paint map boxes', () => {
  const ops = leftOps('DLH')
  assert.deepEqual(ops[0], { k: 'fill', color: '#f7f7f7' })
  assert.ok(colours(ops).includes('#05164d'), 'the fin')
  assert.deepEqual(images(ops), ['/liveries/DLH-fin.png', '/liveries/DLH-title.png'])
  const [lz, ly, ls] = a320.paint!.finLogo
  assert.deepEqual(ops.find((o) => o.k === 'image'), { k: 'image', src: '/liveries/DLH-fin.png', z: lz, y: ly, w: ls, h: ls })
  assert.deepEqual(images(leftOps('SWA')), ['/liveries/SWA-title.png']) // title only
})

test('Air Astana (KZR): white, its midnight-blue fin, light engines; colours only (its logo is not free-licensed)', () => {
  assert.equal(liveryCode('KZR1388'), 'KZR')
  const d = liveryOf('KZR').design
  const ops = drawDesign(d, { id: a320.id, profile: profileOf(a320)!, paint: a320.paint })
  assert.deepEqual(colours(ops.skin.left).slice(0, 3), ['#f7f7f7', '#f7f7f7', '#253168'])
  assert.deepEqual(images(ops.skin.left), [])
  assert.equal(d.engineColor, '#d0d5da')
})

test('table: colours are #rrggbb, aliases land on liveries, every decal file exists with a source', () => {
  const hex = /^#[0-9a-f]{6}$/
  for (const [code, l] of Object.entries(TABLE.liveries)) {
    for (const k of ['base', 'belly', 'fin', 'fin2', 'engine', 'wing'] as const) {
      const v = l[k]
      if (v !== undefined) assert.match(v, hex, `${code}.${k}`)
    }
  }
  for (const [from, to] of Object.entries(TABLE.aliases)) assert.ok(to in TABLE.liveries || to in DESIGNS, `${from} → ${to}`)
  for (const code of Object.keys(DESIGNS)) assert.ok(!(code in TABLE.liveries), `${code}: a design and a colours entry`)
  const wanted = new Set<string>()
  for (const [code, l] of Object.entries(TABLE.liveries)) {
    if (l.title) wanted.add(`${code}-title.png`)
    if (l.finLogo) wanted.add(`${code}-fin.png`)
  }
  for (const f of wanted) {
    assert.ok(existsSync(new URL(`public/liveries/${f}`, root)), f)
    assert.ok(TABLE.logos[f], `source of ${f}`)
  }
  const files = readdirSync(new URL('public/liveries/', root)).filter((f) => !statSync(new URL(`public/liveries/${f}`, root)).isDirectory())
  assert.deepEqual(new Set(files), wanted, 'no stray top-level decal (designs keep theirs in public/liveries/<CODE>/)')
})

test('every manifest model with a paint map gives a complete shader', () => {
  const painted = manifest.models.filter((m) => m.paint)
  assert.ok(painted.length > 0)
  for (const m of painted) {
    const glsl = paintShaderText(m.paint!, profileOf(m)!)
    assert.doesNotMatch(glsl, /NaN|undefined|Infinity/, m.id)
    assert.match(glsl, /void fragmentMain/)
    assert.match(glsl, /skinAt\(p, p\.x > 0\.0\)/)
    const vs = paintVertexText(m.paint!)
    assert.doesNotMatch(vs, /NaN|undefined/, m.id)
    assert.match(vs, /void vertexMain/)
  }
})

// ---------- scenario liveries: body wrap, span fold, damage ----------

const spec = { base: '#f4f4f1', belly: '#bfc3c7', fin: '#f4f4f1', engine: '#b9bdc1', body: 'livery/body.png', finLogo: 'local/fin.png' }

test('liveryFromSpec: colours with defaults, decal paths resolved against the scenario folder, none when absent', () => {
  const l = liveryFromSpec('scenario:jal123', spec, '/scenarios/jal123/', { body: true, finLogo: true })
  assert.equal(l.code, 'scenario:jal123')
  const ops = leftOps(null, b744)
  assert.deepEqual(colours(ops), ['#f7f7f7'])
  const jal = drawDesign(l.design, { id: b744.id, profile: profileOf(b744)!, paint: b744.paint }).skin.left
  assert.deepEqual(colours(jal).slice(0, 3), ['#f4f4f1', '#bfc3c7', '#f4f4f1'])
  assert.deepEqual(jal.find((o) => o.k === 'wrap'), { k: 'wrap', src: '/scenarios/jal123/livery/body.png', box: b744.paint!.body })
  assert.deepEqual(images(jal), ['/scenarios/jal123/livery/body.png', '/scenarios/jal123/local/fin.png'])
  assert.equal(l.design.engineColor, '#b9bdc1')
  const abs = liveryFromSpec('k', { ...spec, title: 'livery/title.png' }, 'http://localhost:5173/scenarios/jal123/', { body: true, finLogo: true })
  assert.ok(images(drawDesign(abs.design, { id: b744.id, profile: profileOf(b744)!, paint: b744.paint }).skin.left).includes('http://localhost:5173/scenarios/jal123/livery/title.png'))
  const missing = liveryFromSpec('k', spec, '/scenarios/jal123/', { body: false, finLogo: false }) // the loader found neither file
  assert.deepEqual(images(drawDesign(missing.design, { id: b744.id, profile: profileOf(b744)!, paint: b744.paint }).skin.left), [])
})

test('every livery shader declares its atlases, u_span and u_cut (off by default)', () => {
  const none = liveryFromSpec('k', spec, '/s/', { body: false, finLogo: false })
  for (const m of [b744, a320]) {
    const s = new LiveryShaders(m)
    for (const cs of [s.for(null), s.custom(none)]) {
      assert.equal(cs.uniforms.u_span.type, UniformType.FLOAT, m.id)
      assert.equal(cs.uniforms.u_span.value, 0)
      assert.equal(cs.uniforms.u_cut.type, UniformType.FLOAT)
      assert.equal(cs.uniforms.u_cut.value, 0)
      assert.equal(cs.uniforms.u_rudder.type, UniformType.VEC2)
      assert.equal((cs.uniforms.u_rudder.value as Cartesian2).y, 0)
      assert.equal(cs.uniforms.u_skin.type, UniformType.SAMPLER_2D)
      assert.equal((cs.uniforms.u_skin.value as { typedArray: Uint8Array }).typedArray.length, 4, 'a 1×1 flat colour until drawn')
    }
  }
})

test('custom() caches by livery code, apart from the table liveries', () => {
  const s = new LiveryShaders(b744)
  const a = liveryFromSpec('scenario:jal123', spec, '/s/', { body: false, finLogo: false })
  assert.equal(s.custom(a), s.custom({ ...a }))
  assert.notEqual(s.custom(a), s.custom({ ...a, code: 'scenario:other' }))
  assert.notEqual(s.custom({ ...a, code: null }), s.for(null))
  assert.equal(s.for('DLH'), s.for('DLH'))
})

test('b744 shader: span fold at wingTipY and the damage branch; neither on a320', () => {
  const fs = paintShaderText(b744.paint!, profileOf(b744)!)
  assert.match(fs, /if \(u_cut > 0\.5 \|\| u_rudder\.y > u_rudder\.x\)/)
  assert.match(fs, /p\.y > u_rudder\.x \+ 0\.2 \* jag && p\.y < u_rudder\.y - 0\.2 \* jag\) discard/)
  assert.match(fs, /discard/)
  assert.match(fs, /czm_backFacing\(\)\) \{ material\.diffuse = vec3\(0\.04\)/)
  const vs = paintVertexText(b744.paint!)
  assert.match(vs, /v_nMC = vsInput\.attributes\.normalMC/)
  assert.match(vs, /u_span > 0\.0 && abs\(q\.x\) > u_span/)
  assert.ok(vs.includes(`min(q.y, ${b744.paint!.wingTipY!.toFixed(3)})`))
  assert.match(vs, /vsOutput\.positionMC = q/)

  assert.doesNotMatch(paintShaderText(a320.paint!, profileOf(a320)!), /u_cut|discard|czm_backFacing/)
  assert.doesNotMatch(paintVertexText(a320.paint!), /u_span/)
})

test('the skin atlas is sampled over the profile box, the left side in the top half', () => {
  const p = profileOf(a320)!
  const fs = paintShaderText(a320.paint!, p)
  const [zMin, zMax, yMin, yMax] = p.box
  assert.ok(fs.includes(`(${zMax.toFixed(3)} - p.z) / ${(zMax - zMin).toFixed(3)}`), 'u from the nose')
  assert.ok(fs.includes(`(${yMax.toFixed(3)} - p.y) / ${(yMax - yMin).toFixed(3)}`), 'rows from the top')
  assert.match(fs, /left \? 0\.0 : 512\.000\) \/ 1024\.000/)
})
