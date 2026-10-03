// tools/models/outline.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { ModelManifest } from '../../client/types.ts'
import { MANIFEST, loadBody, toModelFrame } from './light-anchors.ts'
import { CELLS, outlineFor, outlineOf, writeOutlines, type Sphere } from './outline.ts'

const text = readFileSync(MANIFEST, 'utf8')
const manifest: ModelManifest = JSON.parse(text)
const inside = (o: Sphere[], x: number, y: number, z: number, tol = 0): boolean => o.some((s) => Math.hypot(x - s[0], y - s[1], z - s[2]) <= s[3] + tol)

test('outlineOf: one large triangle (three vertices) is covered all over, by spheres no wider than a cell\'s diagonal', () => {
  const m = { p: Float64Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]), tri: Uint32Array.from([0, 1, 2]) }
  const o = outlineOf(m, 5)
  for (let x = 0; x <= 10; x += 0.5) for (let y = 0; y <= 10 - x; y += 0.5) assert.ok(inside(o, x, y, 0, 1e-9), `(${x}, ${y}) is covered`)
  assert.ok(!inside(o, 8, 8, 0) && !inside(o, 5, 5, 3), 'not what is off the triangle')
  assert.ok(o.length <= 21, `a sphere for each cell it passes through: ${o.length}`)
  for (const s of o) assert.ok(s[3] <= Math.SQRT2 + 0.5 / Math.sqrt(3) + 1e-9, `r ${s[3]} of a flat piece in a cell 2 across, and to the next sample`)
})

test('every model\'s outline in the manifest is the measured one, covers its mesh and hugs it', () => {
  const measured = new Map(manifest.models.map((e) => [e.id, outlineFor(e)]))
  for (const e of manifest.models) {
    const o = measured.get(e.id)!
    assert.deepEqual(e.outline, o, `${e.id} outline`)
    const { p } = loadBody(e)
    let [lo, hi, out] = [Infinity, -Infinity, 0]
    for (let i = 0; i < p.length; i += 3) {
      const v = toModelFrame(e, [p[i], p[i + 1], p[i + 2]])
      if (!inside(o, v[0], v[1], v[2])) out++
      for (const c of v) [lo, hi] = [Math.min(lo, c), Math.max(hi, c)]
    }
    assert.equal(out, 0, `${e.id}: every vertex inside a sphere`)
    assert.ok(o.length <= 400, `${e.id}: ${o.length} spheres`)
    const cell = (hi - lo) / CELLS
    for (const s of o) assert.ok(s[3] <= 1.02 * cell + 0.02, `${e.id}: r ${s[3]} about a cell's half diagonal at most (cell ${cell})`)
  }
  assert.equal(writeOutlines(text, measured), text, 'the manifest lines are the writer\'s')
})

test('writeOutlines: a new line goes after the lights; after an entry\'s last line, that one gets the comma', () => {
  const o = new Map<string, Sphere[]>([['x', [[1, 2, 3, 0.5]]]])
  const entry = (rest: string): string => `{\n  "models": [\n    {\n      "id": "x",\n${rest}\n    }\n  ]\n}`
  const mid = writeOutlines(entry('      "lights": {},\n      "paint": {}'), o)
  assert.equal(mid, entry('      "lights": {},\n      "outline": [[1, 2, 3, 0.5]],\n      "paint": {}'))
  const last = writeOutlines(entry('      "scale": 1'), o)
  assert.equal(last, entry('      "scale": 1,\n      "outline": [[1, 2, 3, 0.5]]'))
  assert.equal(writeOutlines(last, new Map([['x', [[0, 0, 0, 1]] as Sphere[]]])), entry('      "scale": 1,\n      "outline": [[0, 0, 0, 1]]'), 'replaced in place')
})
