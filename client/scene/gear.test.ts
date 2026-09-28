// client/scene/gear.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Matrix4 } from 'cesium'
import { EXTEND_S, GearMotion, RETRACT_S, gearWanted, legMatrix } from './gear.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const air = { onGround: false, aglFt: 8000, vsFpm: 0, gsKt: 280 }

test('gearWanted: on the ground, down; en route, up', () => {
  assert.equal(gearWanted(null, { ...air, onGround: true, aglFt: 0, gsKt: 12 }), true)
  assert.equal(gearWanted(null, air), false)
  assert.equal(gearWanted(true, air), false, 'high up: up whatever it was')
})

test('gearWanted: down on the approach, below 2,000 ft above the ground, descending, slow', () => {
  assert.equal(gearWanted(false, { ...air, aglFt: 1800, vsFpm: -750, gsKt: 150 }), true)
  assert.equal(gearWanted(false, { ...air, aglFt: 2500, vsFpm: -750, gsKt: 150 }), false, 'not yet')
  assert.equal(gearWanted(false, { ...air, aglFt: 1800, vsFpm: -750, gsKt: 260 }), false, 'too fast for gear')
})

test('gearWanted: up once climbing away after take-off or a go-around; held while level low', () => {
  assert.equal(gearWanted(true, { ...air, aglFt: 120, vsFpm: 1800, gsKt: 160 }), false, 'positive rate')
  assert.equal(gearWanted(true, { ...air, aglFt: 20, vsFpm: 900, gsKt: 150 }), true, 'still in ground effect: not yet')
  assert.equal(gearWanted(true, { ...air, aglFt: 1500, vsFpm: 0, gsKt: 160 }), true, 'level, gear down: stays down')
  assert.equal(gearWanted(false, { ...air, aglFt: 1500, vsFpm: 0, gsKt: 160 }), false, 'level, gear up: stays up')
})

test('gearWanted: no ground known (traffic out of the loaded terrain): the rates and the speed decide, or it holds', () => {
  assert.equal(gearWanted(true, { ...air, aglFt: null, vsFpm: 2000, gsKt: 180 }), false)
  assert.equal(gearWanted(false, { ...air, aglFt: null, vsFpm: -800, gsKt: 150 }), false, 'no approach call without a height')
  assert.equal(gearWanted(null, { ...air, aglFt: null, vsFpm: 0, gsKt: 150 }), false, 'first look, nothing known: up')
})

test('GearMotion: the first target is taken at once; then down in EXTEND_S, up in RETRACT_S, never past the ends', () => {
  const g = new GearMotion()
  g.step(true, 0.016)
  assert.equal(g.pos, 1, 'first look: as it is')
  let t = 0
  while (g.pos > 0 && t < 60) {
    g.step(false, 0.1)
    t += 0.1
  }
  near(t, RETRACT_S, 0.11)
  t = 0
  while (g.pos < 1 && t < 60) {
    g.step(true, 0.1)
    t += 0.1
  }
  near(t, EXTEND_S, 0.11)
  g.step(true, 5)
  assert.equal(g.pos, 1)
})

test('GearMotion: a reversal midway turns round from where the gear is; snap() jumps (a seek)', () => {
  const g = new GearMotion()
  g.step(true, 0)
  g.step(false, RETRACT_S / 2)
  near(g.pos, 0.5, 1e-9)
  g.step(true, EXTEND_S / 4)
  near(g.pos, 0.75, 1e-9)
  g.snap(false)
  assert.equal(g.pos, 0)
  assert.equal(g.target, false)
})

test('legMatrix: down, the hinge alone; up, swung the whole angle about the axis; eased in between', () => {
  const hinge = new Cartesian3(1, 2, -3)
  const down = legMatrix(hinge, new Cartesian3(0, 1, 0), -90, 1, new Matrix4())
  assert.ok(Matrix4.equalsEpsilon(down, Matrix4.fromTranslation(hinge), 1e-12))
  const up = legMatrix(hinge, new Cartesian3(0, 1, 0), -90, 0, new Matrix4())
  const wheel = Matrix4.multiplyByPoint(up, new Cartesian3(0, 0, -2), new Cartesian3()) // 2 m down the leg
  near(wheel.x, 1 + 2, 1e-9, 'swung forward')
  near(wheel.z, -3, 1e-9, 'level with the hinge')
  const mid = legMatrix(hinge, new Cartesian3(0, 1, 0), -90, 0.5, new Matrix4())
  const w = Matrix4.multiplyByPoint(mid, new Cartesian3(0, 0, -2), new Cartesian3())
  near(Math.atan2(w.x - 1, -(w.z + 3)) * 180 / Math.PI, 45, 1e-6, 'halfway in time, halfway round (the ease is symmetric)')
})
