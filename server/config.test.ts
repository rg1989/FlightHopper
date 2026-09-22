// server/config.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readServerConfig } from './config.ts'

const FILE = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))

test('defaults: replay at 1 req/s on port 8787, no recording, PIA/LADD hidden, client from dist/', () => {
  assert.deepEqual(readServerConfig({ REPLAY_FILES: FILE }), {
    source: 'replay',
    contact: null,
    maxRps: 1,
    readsbUrl: 'http://127.0.0.1:8042',
    readsbCoverage: null,
    replayFiles: [FILE],
    replaySpeed: 1,
    recordDir: null,
    port: 8787,
    showPiaLadd: false,
    staticDir: 'dist',
  })
})

test('REPLAY_FILES defaults to data/fixtures/*.jsonl (relative to the working directory)', () => {
  // The curated fixtures are promoted from recordings later, so the default pattern may match nothing yet.
  try {
    const cfg = readServerConfig({})
    assert.ok(cfg.replayFiles.length > 0)
    for (const f of cfg.replayFiles) assert.match(f, /^data\/fixtures\/[^/]+\.jsonl$/)
  } catch (e) {
    assert.match((e as Error).message, /^REPLAY_FILES matched no files: data\/fixtures\/\*\.jsonl/)
  }
})

test('REPLAY_FILES: comma-separated paths and globs, each glob sorted, duplicates dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fh-config-'))
  for (const f of ['b.jsonl', 'a.jsonl', 'c.txt']) writeFileSync(join(dir, f), '')
  const cfg = readServerConfig({ REPLAY_FILES: ` ${FILE} , ${dir}/*.jsonl,${join(dir, 'a.jsonl')}` })
  assert.deepEqual(cfg.replayFiles, [FILE, join(dir, 'a.jsonl'), join(dir, 'b.jsonl')])
})

test('REPLAY_FILES that match nothing throw', () => {
  assert.throws(() => readServerConfig({ REPLAY_FILES: '/nonexistent/*.jsonl' }), /^Error: REPLAY_FILES matched no files: \/nonexistent\/\*\.jsonl/)
  assert.throws(() => readServerConfig({ REPLAY_FILES: '/nonexistent/day.jsonl' }), /REPLAY_FILES matched no files/)
})

test('adsblol without CONTACT throws: adsb.lol asks for a contact in the User-Agent', () => {
  assert.throws(() => readServerConfig({ ADSB_SOURCE: 'adsblol' }), /CONTACT is required for ADSB_SOURCE=adsblol/)
  assert.throws(() => readServerConfig({ ADSB_SOURCE: 'adsblol', CONTACT: '   ' }), /CONTACT is required/)
})

test('adsblol: MAX_RPS is clamped to 1 and replay files are not looked at', () => {
  const env = { ADSB_SOURCE: 'adsblol', CONTACT: ' me@example.invalid ', REPLAY_FILES: '/nonexistent/*.jsonl' }
  const cfg = readServerConfig(env)
  assert.equal(cfg.source, 'adsblol')
  assert.equal(cfg.contact, 'me@example.invalid')
  assert.equal(cfg.maxRps, 1)
  assert.deepEqual(cfg.replayFiles, [])
  assert.equal(readServerConfig({ ...env, MAX_RPS: '5' }).maxRps, 1)
  assert.equal(readServerConfig({ ...env, MAX_RPS: '0.5' }).maxRps, 0.5)
})

test('readsb: READSB_URL and READSB_COVERAGE "lat,lon,nm"; MAX_RPS is not clamped', () => {
  const cfg = readServerConfig({ ADSB_SOURCE: 'readsb', READSB_URL: 'http://pi.local:8042/', READSB_COVERAGE: '32.01, 34.88, 200' })
  assert.equal(cfg.source, 'readsb')
  assert.equal(cfg.readsbUrl, 'http://pi.local:8042/')
  assert.deepEqual(cfg.readsbCoverage, { lat: 32.01, lon: 34.88, radiusNm: 200 })
  assert.equal(cfg.maxRps, 1)
  assert.deepEqual(cfg.replayFiles, [])
  assert.equal(readServerConfig({ ADSB_SOURCE: 'readsb', READSB_COVERAGE: '32,34,200', MAX_RPS: '5' }).maxRps, 5)
})

test('readsb: coverage is required and checked; the URL must be http(s)', () => {
  assert.throws(() => readServerConfig({ ADSB_SOURCE: 'readsb' }), /READSB_COVERAGE is required for ADSB_SOURCE=readsb/)
  for (const bad of ['32,34', '32,,200', '91,34,200', '32,181,200', '32,34,0', '32,34,x', '32,34,200,1']) {
    assert.throws(() => readServerConfig({ ADSB_SOURCE: 'readsb', READSB_COVERAGE: bad }), /READSB_COVERAGE must be/, bad)
  }
  for (const bad of ['not a url', 'ftp://pi.local:8042', 'pi.local:8042']) {
    assert.throws(() => readServerConfig({ ADSB_SOURCE: 'readsb', READSB_COVERAGE: '32,34,200', READSB_URL: bad }), /READSB_URL must be/, bad)
  }
})

test('RECORD_DIR, REPLAY_SPEED, PORT, SHOW_PIA_LADD', () => {
  const cfg = readServerConfig({ REPLAY_FILES: FILE, RECORD_DIR: 'data/recordings', REPLAY_SPEED: '10', PORT: '0', SHOW_PIA_LADD: '1' })
  assert.equal(cfg.recordDir, 'data/recordings')
  assert.equal(cfg.replaySpeed, 10)
  assert.equal(cfg.port, 0)
  assert.equal(cfg.showPiaLadd, true)
  const blank = readServerConfig({ REPLAY_FILES: FILE, RECORD_DIR: '', PORT: '', SHOW_PIA_LADD: '0' })
  assert.equal(blank.recordDir, null)
  assert.equal(blank.port, 8787)
  assert.equal(blank.showPiaLadd, false)
})

test('invalid values throw a message that names the variable', () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ ADSB_SOURCE: 'opensky' }, /^Error: ADSB_SOURCE must be one of adsblol, readsb, replay, got "opensky"$/],
    [{ MAX_RPS: 'fast' }, /^Error: MAX_RPS must be a number > 0, got "fast"$/],
    [{ MAX_RPS: '0' }, /MAX_RPS must be a number > 0/],
    [{ MAX_RPS: '-1' }, /MAX_RPS must be a number > 0/],
    [{ MAX_RPS: 'Infinity' }, /MAX_RPS must be a number > 0/],
    [{ REPLAY_SPEED: '0' }, /REPLAY_SPEED must be a number > 0/],
    [{ PORT: '70000' }, /PORT must be an integer 0..65535/],
    [{ PORT: '80.5' }, /PORT must be an integer 0..65535/],
    [{ PORT: 'http' }, /PORT must be an integer 0..65535/],
    [{ SHOW_PIA_LADD: 'yes' }, /^Error: SHOW_PIA_LADD must be 0 or 1, got "yes"$/],
  ]
  for (const [env, re] of cases) assert.throws(() => readServerConfig({ REPLAY_FILES: FILE, ...env }), re, JSON.stringify(env))
})

test('accepts process.env as it is', () => {
  const cfg = readServerConfig({ ...process.env, ADSB_SOURCE: 'replay', REPLAY_FILES: FILE, PORT: '0', MAX_RPS: '', REPLAY_SPEED: '', SHOW_PIA_LADD: '' })
  assert.equal(cfg.source, 'replay')
})
