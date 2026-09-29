// client/livery/kit.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contourAt, drawDesign, imagesOf, Kit, roughProfile } from './kit.ts'
import type { Design, Op } from './kit.ts'
import type { ModelProfile } from '../types.ts'

// A 20 m tube: keel −1, crown +1, the tail cone rising from z −6 to −10; a fin over the aft 4 m.
const P: ModelProfile = {
  box: [-10.1, 10.1, -1.5, 5.1],
  body: [[10, -0.5, 0.5], [8, -1, 1], [-6, -1, 1], [-10, 0.4, 0.8]],
  fin: [[-6, 1], [-8.5, 5], [-9.5, 5], [-10, 1]],
  finRoot: [1, -6, -10],
  finTip: [5, -8.5, -9.5],
  wing: [2, -2, -0.8, 12, -0.2],
  engines: [2, 3.5, 1, 4, -2.2, -0.8],
  winglet: null,
  stab: [-8, -10, 4],
  doors: [7.5, -5],
  cockpit: 8.4,
}
const kit = (side: 'left' | 'right' = 'left'): Kit => new Kit({ profile: P, side, model: 'tube' })

test('contour: interpolates between stations and clamps past the nose and tail', () => {
  assert.deepEqual(contourAt(P.body, 9), [-0.75, 0.75])
  assert.deepEqual(contourAt(P.body, 0), [-1, 1])
  const [b, t] = contourAt(P.body, -8)
  assert.ok(Math.abs(b + 0.3) < 1e-9 && Math.abs(t - 0.9) < 1e-9)
  assert.deepEqual(contourAt(P.body, 50), [-0.5, 0.5])
  assert.deepEqual(contourAt(P.body, -50), [0.4, 0.8])
})

test('landmarks and fractions: at(), fin(u, h) along the swept fin', () => {
  const k = kit()
  assert.equal(k.a.nose, 10)
  assert.equal(k.a.tail, -10)
  assert.equal(k.a.door1, 7.5)
  assert.equal(k.at(0, 0.5), 0)
  assert.equal(k.at(0, 0.25), -0.5)
  assert.deepEqual(k.fin(0, 0), [-6, 1])
  assert.deepEqual(k.fin(1, 1), [-9.5, 5])
  assert.deepEqual(k.fin(0.5, 0.5), [(-7.25 + -9.75) / 2, 3])
})

test('band: follows the contour between two fractions over its z range; stripe keeps its width', () => {
  const k = kit()
  k.band(0, 0.5, '#ff0000', { from: 0, to: -8 })
  const op = k.ops[0] as Extract<Op, { k: 'path' }>
  assert.equal(op.color, '#ff0000')
  const pts = op.d.filter((s) => s[0] === 'M' || s[0] === 'L').map((s) => [s[1], s[2]] as [number, number])
  assert.deepEqual(pts[0], [0, 0]) // upper edge first, fore end
  const upperEnd = pts[pts.length / 2 - 1]
  assert.equal(upperEnd[0], -8)
  assert.ok(Math.abs(upperEnd[1] - 0.3) < 1e-9, 'half-way between keel −0.3 and crown 0.9 at z −8')
  assert.deepEqual(pts[pts.length - 1], [0, -1]) // the lower edge comes back to the fore end at the keel
  k.stripe(0.5, 0.4, '#00ff00', { from: 0, to: -6 })
  const s = (k.ops[1] as Extract<Op, { k: 'path' }>).d
  assert.deepEqual([s[0][1], s[0][2]], [0, 0.2])
})

test('text and image ops take their defaults; drawDesign runs each region for both sides', () => {
  const d: Design = {
    code: 'TST', name: 'test',
    side: (k) => k.fill('#ffffff').text('TEST', { z: k.a.door1 - 1, y: 1, capM: 0.8, color: '#000000' }).image('liveries/TST/fin.svg', { z: -8, y: 3, h: 2, mirror: true }),
    engine: (k) => k.fill(k.side === 'left' ? '#111111' : '#222222'),
  }
  const ops = drawDesign(d, { id: 'tube', profile: P })
  assert.deepEqual(ops.skin.box, P.box)
  assert.deepEqual(ops.nacelle!.box, [1, 4, -2.2, -0.8])
  assert.equal(ops.tip, null, 'no winglet on this model')
  assert.deepEqual(ops.nacelle!.left, [{ k: 'fill', color: '#111111' }])
  assert.deepEqual(ops.nacelle!.right, [{ k: 'fill', color: '#222222' }])
  assert.deepEqual(ops.skin.left[1], { k: 'text', text: 'TEST', z: 6.5, y: 1, capM: 0.8, color: '#000000', font: 'Helvetica, Arial, sans-serif', weight: 700, italic: false, align: 'fore', tracking: 0, mirror: false })
  assert.deepEqual(imagesOf(ops), ['liveries/TST/fin.svg'])
})

test('the rough profile of an old paint map is a closed, ordered stand-in', () => {
  const p = roughProfile({
    noseMinusZ: true, bodyHalfWidth: 2.24, bellyBelowY: -3.68, fin: { behindZ: -13.48, aboveY: -0.67, halfWidth: 0.41 }, finSplit: [0.55, -19.12, 3.06],
    engines: [2.34, 9.11, -0.96, 7.41], finLogo: [-16.09, 2.69, 3.36], title: [7.65, -2.21, 8.41], windows: [-2.4, -13.98, 14.15, 0.51],
  }, 38.23)
  assert.ok(p.body.length > 100)
  for (let i = 1; i < p.body.length; i++) assert.ok(p.body[i][0] < p.body[i - 1][0], 'nose → tail')
  for (const [, b, t] of p.body) assert.ok(t > b)
  assert.ok(p.box[3] > p.finRoot[0] && p.finTip[0] > p.finRoot[0])
})

test('stroke, circle and clip record their ops; clip wraps what it draws', () => {
  const k = kit()
  k.stroke([[0, 0], [-2, 1]], 0.2, '#123456')
  k.circle(1, 2, 0.5, { radial: [1, 2, 0.5], stops: [[0, '#ffffff'], [1, '#000000']] })
  k.clip('fin', () => k.fill('#ff0000'))
  assert.deepEqual(k.ops[0], { k: 'stroke', d: [['M', 0, 0], ['L', -2, 1]], color: '#123456', widthM: 0.2 })
  assert.equal(k.ops[1].k, 'path')
  assert.deepEqual(k.ops.slice(2).map((o) => o.k), ['clip', 'fill', 'unclip'])
  const clip = k.ops[2] as Extract<Op, { k: 'clip' }>
  assert.deepEqual(clip.d[0], ['M', -6, 0.95], 'the fin outline starts 5 cm under the leading-edge root')
})
