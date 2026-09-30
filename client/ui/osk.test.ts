// client/ui/osk.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// osk.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})

const { OSK_COLS, OSK_KEYS, oskEdit, oskKey, oskMove } = await import('./osk.ts')

const label = (at: { row: number; col: number }): string => oskKey(at).label

test('OSK_KEYS: every row fills the columns; 0–9, a–z, Space, ⌫, Clear and Done, once each', () => {
  for (const row of OSK_KEYS) {
    assert.equal(row.reduce((n, k) => n + k.span, 0), OSK_COLS)
    row.forEach((k, i) => assert.equal(k.col, i === 0 ? 0 : row[i - 1].col + row[i - 1].span))
  }
  const labels = OSK_KEYS.flat().map((k) => k.label)
  assert.deepEqual(labels.filter((l) => l.length === 1 && l !== '⌫').sort().join(''), '0123456789abcdefghijklmnopqrstuvwxyz')
  for (const l of ['Space', '⌫', 'Clear', 'Done']) assert.equal(labels.filter((x) => x === l).length, 1, l)
})

test('oskMove: ↑/↓ keep the column, and a wide key is left the way it was entered', () => {
  let at = { row: 1, col: 12 } // m
  assert.equal(label(at), 'm')
  for (const want of ['z', 'Done', 'Done']) assert.equal(label((at = oskMove(at, 'down'))), want, 'the last row stays')
  for (const want of ['z', 'm', '⌫', '⌫']) assert.equal(label((at = oskMove(at, 'up'))), want, 'the first row stays')
  // From 0, → onto ⌫ and ↓ lands under its first column (k), next to where the highlight was, not its last (m).
  at = oskMove({ row: 0, col: 9 }, 'right')
  assert.equal(label(at), '⌫')
  assert.equal(label(oskMove(at, 'down')), 'k')
})

test('oskMove: ←/→ go round the row', () => {
  assert.equal(label(oskMove({ row: 1, col: 12 }, 'right')), 'a')
  assert.equal(label(oskMove({ row: 1, col: 0 }, 'left')), 'm')
  const clear = oskMove({ row: 3, col: 0 }, 'right')
  assert.equal(label(clear), 'Clear')
  assert.equal(label(oskMove(oskMove(clear, 'right'), 'right')), 'Space')
  // From Clear, ← onto Space and ↑ goes to the key over Space's right end (t), next to where the highlight was.
  assert.equal(label(oskMove(oskMove(clear, 'left'), 'up')), 't')
})

test('oskEdit: a char at the end, ⌫ the last off, Clear all, Done leaves the text', () => {
  const find = (l: string) => OSK_KEYS.flat().find((k) => k.label === l)!
  assert.equal(oskEdit('el', find('y')), 'ely')
  assert.equal(oskEdit('ely', find('Space')), 'ely ')
  assert.equal(oskEdit('ely', find('⌫')), 'el')
  assert.equal(oskEdit('', find('⌫')), '')
  assert.equal(oskEdit('ely', find('Clear')), '')
  assert.equal(oskEdit('ely', find('Done')), 'ely')
})
