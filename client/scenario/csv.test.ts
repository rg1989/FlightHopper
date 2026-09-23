// client/scenario/csv.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from './csv.ts'

test('parseCsv: simple header and rows', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n4,5,6'), [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
    ['4', '5', '6'],
  ])
})

test('parseCsv: quoted field containing a comma', () => {
  assert.deepEqual(parseCsv('a,b\n1,"2,2"'), [
    ['a', 'b'],
    ['1', '2,2'],
  ])
})

test('parseCsv: quoted field containing an escaped double quote ("")', () => {
  assert.deepEqual(parseCsv('a\n"He said ""hi"""'), [['a'], ['He said "hi"']])
})

test('parseCsv: quoted field containing a newline', () => {
  assert.deepEqual(parseCsv('a,b\n1,"line1\nline2"'), [
    ['a', 'b'],
    ['1', 'line1\nline2'],
  ])
})

test('parseCsv: CRLF line endings', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n3,4'), [
    ['a', 'b'],
    ['1', '2'],
    ['3', '4'],
  ])
})

test('parseCsv: leading BOM is stripped', () => {
  assert.deepEqual(parseCsv('﻿a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ])
})

test('parseCsv: a trailing newline adds no extra row', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [
    ['a', 'b'],
    ['1', '2'],
  ])
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [
    ['a', 'b'],
    ['1', '2'],
  ])
})

test('parseCsv: empty cells', () => {
  assert.deepEqual(parseCsv('a,b,c\n,2,\n,,'), [
    ['a', 'b', 'c'],
    ['', '2', ''],
    ['', '', ''],
  ])
})

test('parseCsv: empty input has no rows', () => {
  assert.deepEqual(parseCsv(''), [])
})

test('parseCsv: a genuinely blank line (not a trailing newline) is a one-field row', () => {
  assert.deepEqual(parseCsv('a\n\nb'), [['a'], [''], ['b']])
})

test('parseCsv: mixed CRLF and LF in the same document', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\n3,4'), [
    ['a', 'b'],
    ['1', '2'],
    ['3', '4'],
  ])
})
