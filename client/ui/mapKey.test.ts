// client/ui/mapKey.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { NM_M, niceLength } = await import('./mapKey.ts')

test('niceLength: the longest 1, 2 or 5 × 10ⁿ that fits the ruler, in its unit', () => {
  assert.deepEqual(niceLength(10, 1000, 120), { px: 100, n: 1 }) // 1.2 km fit: 1 km
  assert.deepEqual(niceLength(100, 1000, 120), { px: 100, n: 10 }) // 12 km: 10 km
  const nm = niceLength(50, NM_M, 120)! // 3.24 nm fit: 2 nm
  assert.equal(nm.n, 2)
  assert.ok(Math.abs(nm.px - (2 * NM_M) / 50) < 1e-9)
  assert.equal(niceLength(0.5, 1000, 120)!.n, 0.05) // 60 m fit: 0.05 km
  assert.equal(niceLength(0, 1000), null)
  assert.equal(niceLength(Number.NaN, 1000), null)
})
