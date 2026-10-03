// tools/models/variants.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { ModelManifest, ModelManifestEntry } from '../../client/types.ts'
import { readGlb } from './glb.ts'
import { MANIFEST, lightsFor } from './light-anchors.ts'
import { outlineFor } from './outline.ts'
import { engineParts, partBoxes, parts, profileOf } from './profile.ts'
import { build, cutOutboard, devicePieces, measureTip, meshOf, recipes, signedVolume, spine, toWork, withEntry, type Work } from './variants.ts'

const text = readFileSync(MANIFEST, 'utf8')
const manifest: ModelManifest = JSON.parse(text)
const byId = (id: string): ModelManifestEntry => manifest.models.find((m) => m.id === id)!
const all = recipes()
const built = Object.entries(all).map(([id, r]) => ({ id, r, ...build(id, r, manifest) }))
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const V = (w: Work, i: number): [number, number, number] => [w.p[3 * i], w.p[3 * i + 1], w.p[3 * i + 2]]
const workOf = (e: ModelManifestEntry): Work => toWork(readGlb(new Uint8Array(readFileSync(new URL(`../../public/${e.uri}`, import.meta.url)))), e)

/** Each left-wing device piece of recipe id, lofted on its base as build() does. */
function pieces(id: string): Work[] {
  const r = all[id]
  const base = byId(r.base)
  const { profile, wingPlane } = profileOf(base)
  const xStart = profile.wing[3] - r.wingtip!.blendStartM
  return devicePieces(measureTip(meshOf(workOf(base)), wingPlane, xStart), r.wingtip!)
}

test('the recipes: the A320neo, A321neo and 737 MAX 8, each on its base, with its types', () => {
  assert.deepEqual(Object.keys(all).sort(), ['a20n', 'a21n', 'b38m'])
  assert.deepEqual([all.a20n.base, all.a21n.base, all.b38m.base], ['a320', 'a321', 'b738'])
  assert.deepEqual(all.b38m.types, ['B38M', 'B37M', 'B39M', 'B3XM'])
})

test('spine: the blend reaches its span and rise, curving ever tighter, then runs straight at the final angle', () => {
  const a0 = 0.09
  const a1 = (84 * Math.PI) / 180
  const sp = spine(a0, a1, 1.35, 0.8, 1.7)
  const end = sp.find((q) => q.t >= 1)!
  near(end.x, 1.35, 0.03, 'span')
  near(end.y, 0.8, 0.03, 'rise')
  near(sp[sp.length - 1].a, a1, 1e-9)
  near(Math.hypot(sp[sp.length - 1].x - end.x, sp[sp.length - 1].y - end.y), 1.7, 0.03, 'the straight part')
  const turn = sp.slice(1).filter((q) => q.t < 1).map((q, k) => q.a - sp[k].a)
  assert.ok(turn[turn.length - 1] > 2 * turn[1], 'gentle leaving the wing, tight near vertical')
})

test('cutOutboard: nothing left beyond the cut on either wing; the triangles across it end on it', () => {
  // a strip from x = −3 to 3, cut at |x| = 2
  const w: Work = { p: [-3, 0, 0, -3, 0, 1, 3, 0, 0, 3, 0, 1, 0, 0, 0, 0, 0, 1], n: Array(18).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), c: Array(24).fill(200), tri: [0, 4, 1, 1, 4, 5, 4, 2, 5, 5, 2, 3] }
  const out = cutOutboard(w, 2)
  const xs = out.p.filter((_, i) => i % 3 === 0)
  assert.ok(Math.max(...xs.map(Math.abs)) <= 2 + 1e-9)
  assert.equal(xs.filter((x) => Math.abs(Math.abs(x) - 2) < 1e-9).length, 6, 'a new vertex where each of the three edges crosses each cut, shared')
  let area = 0
  for (let t = 0; t < out.tri.length; t += 3) {
    const [a, b, c] = [V(out, out.tri[t]), V(out, out.tri[t + 1]), V(out, out.tri[t + 2])]
    area += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2
  }
  near(area, 4, 1e-9, 'the strip from −2 to 2')
})

test('every device piece is closed, faces outward, shades smoothly and is painted like the wing (not glass)', () => {
  for (const id of Object.keys(all)) {
    for (const w of pieces(id)) {
      assert.ok(signedVolume(w) > 0, `${id}: outward`)
      const key = (i: number): string => V(w, i).map((v) => Math.round(v * 1e5)).join(',')
      const uses = new Map<string, number>()
      for (let t = 0; t < w.tri.length; t += 3) {
        for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
          const [ka, kb] = [key(w.tri[t + a]), key(w.tri[t + b])]
          if (ka === kb) continue // the flat tip's collapsed edges
          const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
          uses.set(k, (uses.get(k) ?? 0) + 1)
        }
      }
      const open = [...uses.values()].filter((n) => n % 2 !== 0).length
      assert.equal(open, 0, `${id}: no open edges`)
      let agree = 0
      for (let t = 0; t < w.tri.length; t += 3) {
        const [a, b, c] = [V(w, w.tri[t]), V(w, w.tri[t + 1]), V(w, w.tri[t + 2])]
        const f = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]
        const n = [0, 1, 2].map((k) => w.n[3 * w.tri[t] + k] + w.n[3 * w.tri[t + 1] + k] + w.n[3 * w.tri[t + 2] + k])
        if (f[0] * n[0] + f[1] * n[1] + f[2] * n[2] > 0) agree++
      }
      assert.ok(agree >= 0.995 * (w.tri.length / 3), `${id}: windings agree with the normals (${agree} of ${w.tri.length / 3})`)
      for (let i = 0; i < w.n.length; i += 3) near(Math.hypot(w.n[i], w.n[i + 1], w.n[i + 2]), 1, 1e-6, 'unit normal')
      for (let i = 0; i < w.c.length; i += 4) assert.ok(w.c[i] >= 140 && w.c[i] === w.c[i + 1] && w.c[i + 3] === 255, `${id}: COLOR_0 a grey shade in the base's range`)
    }
  }
})

test('the devices have the real ones\' size: sharklets 2.4 m over the wing, 0.8 m more span; the MAX\'s blades 2.1 m up and 0.66 m down', () => {
  for (const id of ['a20n', 'a21n']) {
    const [w] = pieces(id)
    const base = byId(all[id].base)
    const { profile, wingPlane } = profileOf(base)
    const xs = w.p.filter((_, i) => i % 3 === 0)
    const ys = w.p.filter((_, i) => i % 3 === 1)
    const xStart = profile.wing[3] - all[id].wingtip!.blendStartM
    near(Math.max(...ys) - wingPlane(xStart), 2.55, 0.15, `${id}: top over the wing's upper surface where the blend starts`)
    near(Math.max(...xs) - profile.wing[3], 0.8, 0.1, `${id}: span added (35.80 m vs 34.10 m)`)
  }
  const [upper, lower] = pieces('b38m')
  const { profile, wingPlane } = profileOf(byId('b738'))
  const xStart = profile.wing[3] - all.b38m.wingtip!.blendStartM
  near(Math.max(...upper.p.filter((_, i) => i % 3 === 1)) - wingPlane(xStart), 2.1, 0.15, 'the upper blade over the junction')
  near(wingPlane(xStart) - Math.min(...lower.p.filter((_, i) => i % 3 === 1)), 0.66 + 0.1, 0.12, 'the lower blade under it (and the wing\'s thickness)')
  near(Math.max(...upper.p.filter((_, i) => i % 3 === 0)), 17.8, 0.15, 'half the 35.92 m span, on this 1 % small mesh')
})

test('the MAX loses the 737-800\'s blended winglet: none of its vertices is left', () => {
  const base = workOf(byId('b738'))
  const b38m = meshOf(workOf(byId('b38m')))
  const old: number[][] = []
  for (let i = 0; i < base.p.length / 3; i++) if (base.p[3 * i] > 17.3 && base.p[3 * i + 1] > -2.5) old.push(V(base, i))
  assert.ok(old.length > 3, 'the NG winglet found on the base')
  for (let i = 0; i < b38m.p.length; i += 3) {
    for (const q of old) assert.ok(Math.hypot(b38m.p[i] - q[0], b38m.p[i + 1] - q[1], b38m.p[i + 2] - q[2]) > 0.02, `an old winglet vertex at ${q}`)
  }
})

test('the nacelles: scaled about their axis by the recipe, from the inlet lip aft, moved forward and up', () => {
  for (const { id, r } of built) {
    const cowl = (e: ModelManifestEntry): number[] => {
      const m = meshOf(workOf(e))
      return engineParts(partBoxes(m, parts(m)), e.paint!.engines)[0].core
    }
    const [b, v] = [cowl(byId(r.base)), cowl(byId(id))]
    const [sx, sy, sz] = r.nacelle!.scale
    near(v[1] - v[0], sx * (b[1] - b[0]), 0.02, `${id} width`)
    near(v[3] - v[2], sy * (b[3] - b[2]), 0.02, `${id} height`)
    near(v[5] - v[4], sz * (b[5] - b[4]), 0.02, `${id} length`)
    near(v[2] + v[3], b[2] + b[3] + 2 * r.nacelle!.upM, 0.02, `${id} axis height`)
    near((v[0] + v[1]) / 2, (b[0] + b[1]) / 2, 0.01, `${id} axis span`)
  }
})

test('public/models/<id>.glb and its manifest entry are up to date (regenerate: node tools/models/variants.ts)', () => {
  for (const { id, r, bytes, entry } of built) {
    assert.deepEqual(new Uint8Array(readFileSync(new URL(`../../public/${entry.uri}`, import.meta.url))), bytes, `${id}.glb`)
    const e = byId(id)
    assert.deepEqual(e, { ...entry, lights: lightsFor(entry), outline: outlineFor(entry), profile: profileOf(entry).profile, ...{} } as ModelManifestEntry, `${id} entry`)
    assert.equal(withEntry(text, e, r.base), text, `${id}: the manifest lines are the writer's`)
  }
})

test('the variants own their types; provenance: the base\'s licence, authors and source, and the modification noted', () => {
  for (const { id, r } of built) {
    const e = byId(id)
    const base = byId(r.base)
    assert.deepEqual(e.types, r.types)
    for (const m of manifest.models) if (m.id !== id) for (const t of r.types) assert.ok(!(m.types ?? []).includes(t), `${t} still on ${m.id}`)
    assert.ok((base.types ?? []).length > 0, `${r.base} keeps its other types`)
    assert.equal(e.license, base.license)
    assert.ok(e.author.startsWith(base.author) && e.author.endsWith('modified by FlightHopper (tools/models/variants.ts)'))
    assert.ok(e.source.startsWith(base.source) && e.source.includes(`recipe ${id}`))
    for (const k of ['forwardAxisFix', 'gearHeightM', 'lengthM', 'scale', 'gear'] as const) assert.deepEqual(e[k], base[k], `${id} ${k} as its base's`)
    const asset = readGlb(new Uint8Array(readFileSync(new URL(`../../public/${e.uri}`, import.meta.url)))).json.asset
    assert.match(asset.copyright, new RegExp(`^GPL-2\\.0-only, derived from ${r.base}\\.glb .*modified by FlightHopper .*recipe ${id}`))
  }
})
