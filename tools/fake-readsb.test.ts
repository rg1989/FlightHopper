// tools/fake-readsb.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { distanceNm } from '../shared/geo.ts'
import { normalizeReadsb } from '../shared/readsb.ts'
import { readRecording } from '../server/recording.ts'
import { startFakeReadsb } from './fake-readsb.ts'

const FILE = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))
const FIRST = readRecording(FILE).find((l) => l.status === 200)!.tRecvMs

const get = async (url: string): Promise<{ status: number; type: string | null; text: string }> => {
  const res = await fetch(url)
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() }
}

test('serves the readsb API envelope: now in seconds, resultCount, ptime, aircraft', async (t) => {
  const fake = await startFakeReadsb({ files: [FILE], port: 0, speed: 0 }) // speed 0 freezes it at the first poll
  t.after(() => fake.close())
  assert.match(fake.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  const r = await get(`${fake.url}/?all_with_pos`)
  assert.equal(r.status, 200)
  assert.equal(r.type, 'application/json')
  const j = JSON.parse(r.text)
  assert.deepEqual(Object.keys(j), ['now', 'resultCount', 'ptime', 'aircraft'])
  assert.equal(j.now, FIRST / 1000)
  assert.equal(j.resultCount, j.aircraft.length)
  assert.equal(typeof j.ptime, 'number')
  const snap = normalizeReadsb(r.text)
  assert.equal(snap.nowMs, FIRST)
  assert.equal(snap.aircraft.length, 40)
})

test('circle and find_hex queries; anything else is a 400', async (t) => {
  const fake = await startFakeReadsb({ files: [FILE], port: 0, speed: 0 })
  t.after(() => fake.close())
  const near = normalizeReadsb((await get(`${fake.url}/?circle=37.6188,-122.3758,5`)).text).aircraft
  assert.ok(near.length > 0 && near.length < 40, `${near.length}`)
  for (const a of near) assert.ok(distanceNm(37.6188, -122.3758, a.lat!, a.lon!) <= 5)
  const found = normalizeReadsb((await get(`${fake.url}/?find_hex=a067ec,A99014,ffffff`)).text).aircraft
  assert.deepEqual(found.map((a) => a.hex).sort(), ['a067ec', 'a99014'])
  assert.equal((await get(`${fake.url}/?circle=1,2`)).status, 400)
  assert.equal((await get(`${fake.url}/?box=0,1,0,1`)).status, 400)
  assert.equal((await get(`${fake.url}/`)).status, 400)
})

test('close stops the server', async () => {
  const fake = await startFakeReadsb({ files: [FILE], port: 0, speed: 0 })
  await get(`${fake.url}/?all_with_pos`) // leave a keep-alive connection open
  await fake.close()
  await assert.rejects(fetch(`${fake.url}/?all_with_pos`))
})

test('CLI: prints its URL and serves the files', async (t) => {
  const script = fileURLToPath(new URL('./fake-readsb.ts', import.meta.url))
  const child = spawn(process.execPath, [script, '--files', FILE, '--port', '0', '--speed', '0'], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => child.kill())
  const [chunk] = await once(child.stdout, 'data')
  const url = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk))![0]
  const snap = normalizeReadsb((await get(`${url}/?find_hex=a067ec`)).text)
  assert.equal(snap.nowMs, FIRST)
  assert.deepEqual(snap.aircraft.map((a) => a.hex), ['a067ec'])
})
