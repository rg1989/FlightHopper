import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRecordLine, readRecording, recordingToSamples } from './recording.ts'

const path = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))

test('reads all record lines, including non-200; tolerates CRLF, blank lines, no final newline', () => {
  const lines = readRecording(path)
  assert.equal(lines.length, 4)
  assert.deepEqual(lines.map((l) => l.status), [200, 200, 429, 200])
  const raw = readFileSync(path, 'utf8').trim().split('\n')
  const p = join(mkdtempSync(join(tmpdir(), 'fh-rec-')), 'x.jsonl')
  writeFileSync(p, `${raw[0]}\r\n\n${raw[2]}`)
  assert.deepEqual(readRecording(p).map((l) => l.status), [200, 429])
})

test('re-served poll adds nothing; 429 skipped; second real poll adds only moved aircraft', () => {
  // 40 positions in poll 1; poll 2 is a re-serve (0 new); 429 has no body; poll 3 has 25 new positions.
  assert.equal(recordingToSamples(readRecording(path), { hideFlagged: false }).length, 40 + 25)
})

test('LADD/PIA aircraft are hidden by default (000002 has dbFlags 8 in both real polls)', () => {
  const samples = recordingToSamples(readRecording(path))
  assert.equal(samples.length, 40 + 25 - 2)
  assert.ok(!samples.some((s) => s.hex === '000002'))
})

test('stamps in the recording clock: offset = min(tRecv − now) so far', () => {
  const lines = readRecording(path)
  const first = JSON.parse(lines[0].body)
  const ac = first.ac.find((a: { lat?: number }) => a.lat !== undefined)
  const s = recordingToSamples([lines[0]]).find((x) => x.hex === ac.hex)!
  assert.equal(s.tMs, first.now - Math.round(ac.seen_pos * 1000) + (lines[0].tRecvMs - first.now))
  assert.equal(s.rxMs, lines[0].tRecvMs)
})

test('rejects lines that are not v1 records', () => {
  assert.throws(() => parseRecordLine('{"v":2}'))
})

