// server/recorder.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Recorder } from './recorder.ts'
import { readRecording, recordingToSamples } from './recording.ts'
import type { FetchResult } from './sources/types.ts'

const GOLDEN = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))
const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'fh-recorder-')), 'nested', 'recordings')

const result = (over: Partial<FetchResult>): FetchResult => ({
  url: 'https://api.adsb.lol/v2/point/37.6188/-122.3758/40',
  status: 200,
  tSendMs: Date.UTC(2026, 8, 22, 12, 0, 0),
  tRecvMs: Date.UTC(2026, 8, 22, 12, 0, 0, 150),
  bytes: 21,
  body: '{"ac":[],"now":1,"msg":"No error"}',
  retryAfterS: null,
  snapshot: { nowMs: 1, aircraft: [] },
  ...over,
})

test('creates its directory and appends one RecordLine per poll', () => {
  const dir = tmp()
  const rec = new Recorder(dir)
  assert.ok(existsSync(dir))
  rec.write('adsblol', result({}))
  rec.write('readsb', result({ url: 'http://127.0.0.1:8042/?all_with_pos', bytes: 7 }))
  assert.deepEqual(readdirSync(dir), ['2026-09-22.jsonl'])
  const lines = readRecording(join(dir, '2026-09-22.jsonl'))
  assert.deepEqual(lines[0], {
    v: 1,
    source: 'adsblol',
    url: 'https://api.adsb.lol/v2/point/37.6188/-122.3758/40',
    status: 200,
    tSendMs: Date.UTC(2026, 8, 22, 12, 0, 0),
    tRecvMs: Date.UTC(2026, 8, 22, 12, 0, 0, 150),
    bytes: 21,
    body: '{"ac":[],"now":1,"msg":"No error"}',
  })
  assert.equal(lines[1].source, 'readsb')
  assert.equal(lines[1].bytes, 7)
})

test('daily files by the UTC date of tSendMs (a poll sent before midnight stays in that day)', () => {
  const dir = tmp()
  const rec = new Recorder(dir)
  const late = Date.UTC(2026, 8, 22, 23, 59, 59, 900)
  rec.write('adsblol', result({ tSendMs: late, tRecvMs: late + 200 })) // received 00:00:00.100 on the 23rd
  rec.write('adsblol', result({ tSendMs: late + 300, tRecvMs: late + 450 }))
  assert.deepEqual(readdirSync(dir).sort(), ['2026-09-22.jsonl', '2026-09-23.jsonl'])
  assert.equal(readRecording(join(dir, '2026-09-22.jsonl'))[0].tRecvMs, late + 200)
})

test('bodies are kept only for 200s; status, bytes and times always', () => {
  const dir = tmp()
  const rec = new Recorder(dir)
  rec.write('adsblol', result({ status: 429, body: 'Too Many Requests', bytes: 17, retryAfterS: 5, snapshot: null }))
  rec.write('adsblol', result({ status: 0, body: '', bytes: 0, snapshot: null }))
  const [r429, err] = readRecording(join(dir, '2026-09-22.jsonl'))
  assert.equal(r429.status, 429)
  assert.equal(r429.body, '')
  assert.equal(r429.bytes, 17)
  assert.equal(err.status, 0)
})

test('replay results are never recorded', () => {
  const dir = tmp()
  new Recorder(dir).write('replay', result({ url: 'replay:/?all_with_pos' }))
  assert.deepEqual(readdirSync(dir), [])
})

test('round trip: re-recording the golden polls reproduces them and their samples', () => {
  const golden = readRecording(GOLDEN)
  const dir = tmp()
  const rec = new Recorder(dir)
  for (const l of golden) rec.write(l.source, { ...l, retryAfterS: null, snapshot: null })
  const files = readdirSync(dir)
  assert.equal(files.length, 1)
  const again = readRecording(join(dir, files[0]))
  assert.deepEqual(again, golden)
  assert.equal(recordingToSamples(again).length, recordingToSamples(golden).length)
})
