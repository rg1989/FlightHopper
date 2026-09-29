// tools/models/profile.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { ModelManifest, ModelProfile } from '../../client/types.ts'
import { MANIFEST } from './light-anchors.ts'
import { DOCS, paintMesh, profileLine, profileOf, section, writeProfiles } from './profile.ts'

const text = readFileSync(MANIFEST, 'utf8')
const manifest: ModelManifest = JSON.parse(text)
const painted = manifest.models.filter((e) => e.paint !== undefined)
const measured = new Map(painted.map((e) => [e.id, profileOf(e).profile]))
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)

/** y along the body outline at z (column 1 bottom, 2 top), linear between its stations. */
const at = (p: ModelProfile, z: number, col: 1 | 2): number => {
  const b = p.body
  for (let k = 1; k < b.length; k++) if (z >= b[k][0]) return b[k - 1][col] + ((z - b[k - 1][0]) / (b[k][0] - b[k - 1][0])) * (b[k][col] - b[k - 1][col])
  return b[b.length - 1][col]
}

test('section: a unit cube cut at z = 0.5 gives its square outline', () => {
  const p = Float64Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1])
  const tri = Uint32Array.from([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0])
  const s = section({ p, tri }, 2, 0.5)
  assert.equal(s.length, 8 * 4, 'two segments per side face')
  for (let k = 0; k < s.length; k += 2) assert.ok([0, 1].includes(s[k]) || [0, 1].includes(s[k + 1]), `on the square: ${s[k]}, ${s[k + 1]}`)
})

test('paintMesh is the primitive POSITION turned by noseMinusZ (what the livery shader sees)', () => {
  const e = manifest.models.find((m) => m.id === 'a320')!
  const m = paintMesh(e)
  let [zMin, zMax] = [Infinity, -Infinity]
  for (let i = 2; i < m.p.length; i += 3) [zMin, zMax] = [Math.min(zMin, m.p[i]), Math.max(zMax, m.p[i])]
  near(zMax, 19.12, 0.01, 'the nose at +z')
  near(zMin, -19.12, 0.01)
  const p = measured.get('a320')!
  assert.ok(p.finRoot[1] < 0 && p.body[0][0] > 0, 'the fin aft (−z), the nose forward (+z)')
})

test('every painted model has a sane profile: outline nose → tail, fin above it, wing, box around all', () => {
  for (const [id, p] of measured) {
    const [z0, z1, y0, y1] = p.box
    for (let k = 1; k < p.body.length; k++) assert.ok(p.body[k][0] < p.body[k - 1][0], `${id} body z descends`)
    for (const [z, b, t] of p.body) {
      assert.ok(b <= t + 1e-9, `${id} bottom ≤ top at ${z}`)
      assert.ok(z > z0 && z < z1 && b > y0 && t < y1, `${id} body inside the box at ${z}`)
    }
    for (const [z, y] of p.fin) assert.ok(z >= z0 && z <= z1 && y >= y0 && y <= y1, `${id} fin inside the box: ${z}, ${y}`)
    const [yr, ler, ter] = p.finRoot
    const [yt, let_, tet] = p.finTip
    assert.ok(yt > yr + 0.5 && ler > ter && let_ > tet, `${id} fin root below its tip, leading edges forward`)
    near(yt, y1 - 0.1, 0.02, `${id} the box reaches the fin tip`)
    const [rootLe, rootTe, , tipX] = p.wing
    if (id !== 'ec135') assert.ok(rootLe > rootTe && tipX > 3 * manifest.models.find((m) => m.id === id)!.paint!.bodyHalfWidth, `${id} wing`)
    if (p.engines) assert.ok(p.engines[0] < p.engines[1] && p.engines[2] < p.engines[3] && p.engines[4] < p.engines[5], `${id} engines box`)
    if (p.stab) assert.ok(p.stab[0] < p.stab[1] && p.stab[1] < p.finRoot[1] + 2 && p.stab[2] > 1, `${id} stab by the fin`)
    for (const d of p.doors) assert.ok(d < p.body[0][0] && d > z0, `${id} door on the fuselage`)
    const cabinDoor = id === 'c182' || id === 'ec135' // the pilot's door is the cockpit's
    assert.ok(p.cockpit < p.body[0][0] && (p.doors.length === 0 || cabinDoor || p.cockpit > p.doors[0]), `${id} cockpit behind the nose, ahead of door 1`)
  }
})

test('profiles agree with the paint maps measured before them (turned frame, same mesh)', () => {
  for (const e of painted) {
    const p = measured.get(e.id)!
    const P = e.paint!
    const zMid = (p.body[0][0] + p.body[p.body.length - 1][0]) / 2 + 0.1 * (p.body[0][0] - p.body[p.body.length - 1][0])
    const [b, t] = [at(p, zMid, 1), at(p, zMid, 2)]
    if (P.windows) assert.ok(P.windows[0] > (b + t) / 2 - 0.3 && P.windows[0] < t, `${e.id}: the window row ${P.windows[0]} in the upper half of ${b}…${t}`)
    assert.ok(P.bellyBelowY > b - 0.1 && P.bellyBelowY < t, `${e.id}: bellyBelowY within the fuselage`)
    if (e.id !== 'ec135' && e.id !== 'c182' && e.id !== 'cesium-air') near((t - b) / 2, P.bodyHalfWidth, 0.3 * P.bodyHalfWidth, `${e.id} fuselage radius vs bodyHalfWidth`)
    assert.ok(P.finLogo[1] > p.finRoot[0] - 0.5 && P.finLogo[1] < p.finTip[0], `${e.id}: the fin logo between the fin's root and tip`)
    assert.ok(P.fin.behindZ > p.finTip[2], `${e.id}: the paint's fin region reaches the fin's tip trailing edge`)
  }
})

test('the device, the engines and the doors where the types have them', () => {
  for (const id of ['b738', 'a333', 'a359', 'b744', 'e75l', 'e190', 'crj9']) assert.ok(measured.get(id)!.winglet !== null, `${id} has winglets`)
  for (const id of ['a320', 'a321', 'b773', 'b789', 'at75', 'c182']) assert.equal(measured.get(id)!.winglet, null, `${id} has none (raked tips, fences not modelled)`)
  for (const id of ['c182', 'ec135']) assert.equal(measured.get(id)!.engines, null, `${id}: no nacelles`)
  const b738 = measured.get('b738')!
  near(b738.winglet![5] - b738.wing[4], 1.8, 0.3, 'the 737-800 winglet stands ~1.8 m over the wing (mesh; real 2.44 m from its lowest point)')
  const b744 = measured.get('b744')!
  assert.ok(b744.engines![1] - b744.engines![0] > 8, 'both 747 engines on the left in the box')
  for (const [id, d] of Object.entries(DOCS)) {
    const p = measured.get(id)
    if (p === undefined || d.doors.length === 0) continue // a derived model not built yet; no doors
    assert.equal(p.doors.length, d.doors.length, `${id} doors`)
    const k = d.lengthM === null ? 1 : (p.body[0][0] - p.box[0]) / d.lengthM
    near(p.body[0][0] - p.doors[0], d.doors[0] * k, 0.3, `${id} door 1 from the nose`)
  }
})

test('the manifest carries every painted model\'s profile (regenerate: node tools/models/profile.ts --write)', () => {
  for (const e of painted) assert.deepEqual(e.profile, measured.get(e.id), `${e.id} profile`)
  assert.equal(writeProfiles(text, measured), text, 'the manifest lines are the writer\'s')
  assert.ok(profileLine(measured.get('a320')!).startsWith('"profile": { "box": ['))
})
