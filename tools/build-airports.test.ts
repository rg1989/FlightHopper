// tools/build-airports.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from './build-airports.ts'

test('parseCsv: header row becomes the keys; quoted and bare fields', () => {
  assert.deepEqual(parseCsv('"id","ident",elev\n1,"KSFO",13\n'), [{ id: '1', ident: 'KSFO', elev: '13' }])
})

test('parseCsv: embedded commas, doubled quotes and newlines inside quotes', () => {
  const rows = parseCsv('a,b,c\n"x, y","say ""hi""","line1\nline2"\n')
  assert.deepEqual(rows, [{ a: 'x, y', b: 'say "hi"', c: 'line1\nline2' }])
})

test('parseCsv: CRLF line ends, empty fields, no trailing newline', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n1,,3\r\n,,\r\n4,5,6'), [
    { a: '1', b: '', c: '3' },
    { a: '', b: '', c: '' },
    { a: '4', b: '5', c: '6' },
  ])
})

test('parseCsv: CRLF inside a quoted field is kept verbatim', () => {
  assert.deepEqual(parseCsv('a,b\r\n"1\r\n2",3\r\n'), [{ a: '1\r\n2', b: '3' }])
})

test('parseCsv: blank lines are skipped; short rows fill with empty strings', () => {
  assert.deepEqual(parseCsv('a,b\n\n1\n\n'), [{ a: '1', b: '' }])
})

test('parseCsv: header only or empty text gives no rows', () => {
  assert.deepEqual(parseCsv('a,b\n'), [])
  assert.deepEqual(parseCsv(''), [])
})
