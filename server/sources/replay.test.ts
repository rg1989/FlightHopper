// server/sources/replay.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MinOffset } from '../../shared/clock.ts'
import { Deduper } from '../../shared/dedupe.ts'
import { distanceNm } from '../../shared/geo.ts'
import { normalizeReadsb, normalizers } from '../../shared/readsb.ts'
import { toSample } from '../../shared/sample.ts'
import { readRecording, recordingToSamples } from '../recording.ts'
import { LOOP_GAP_MS, makeReplay } from './replay.ts'

const FILE = fileURLToPath(new URL('../../data/fixtures/golden/recording-sample.jsonl', import.meta.url))
const LINES = readRecording(FILE)
const OK = LINES.filter((l) => l.status === 200)
const SNAPS = OK.map((l) => normalizers[l.source](l.body))
const FIRST = OK[0].tRecvMs
const LAST = OK[OK.length - 1].tRecvMs
// The replay's single upstream → recording clock offset: min(tRecvMs − upstream now) over all 200 lines.
const OFFSET = Math.min(...OK.map((l, i) => l.tRecvMs - SNAPS[i].nowMs))

/** A replay on a hand-driven clock; at(e) puts the clock e ms after the replay was created. */
function clocked(opts: { speed?: number; loop?: boolean; files?: string[] } = {}) {
  const clock = { t: 5_000 }
  const src = makeReplay({ files: opts.files ?? [FILE], speed: opts.speed, loop: opts.loop, nowMs: () => clock.t })
  return { src, at: (elapsedMs: number): void => void (clock.t = 5_000 + elapsedMs) }
}

test('caps: full-snapshot replay, 10 rps, global coverage', () => {
  const { caps } = makeReplay({ files: [FILE] })
  assert.equal(caps.kind, 'replay')
  assert.equal(caps.fullSnapshot, true)
  assert.equal(caps.maxRps, 10)
  assert.equal(caps.coverage, null)
  assert.match(caps.attribution, /adsb\.lol.*ODbL/)
})

test('virtual time: vt = first tRecv + elapsed × speed; body is readsb-shaped', async () => {
  const { src, at } = clocked({ speed: 2 })
  at(0)
  assert.equal(JSON.parse((await src.all()).body).now, FIRST / 1000)
  at(500)
  const r = await src.all()
  assert.equal(r.snapshot!.nowMs, FIRST + 1000)
  assert.deepEqual(Object.keys(JSON.parse(r.body)), ['now', 'aircraft'])
  assert.deepEqual(normalizeReadsb(r.body), r.snapshot)
  assert.equal(r.status, 200)
  assert.equal(r.tSendMs, 5_500)
  assert.equal(r.tRecvMs, 5_500)
  assert.equal(r.retryAfterS, null)
  assert.equal(r.bytes, Buffer.byteLength(r.body))
  assert.match(r.url, /^replay:\/\?all_with_pos$/)
})

test('seen_pos is rebased: now − seen_pos = original position time in recording clock (±1 ms)', async () => {
  const { src, at } = clocked()
  for (const [i, line] of OK.entries()) {
    at(line.tRecvMs - FIRST) // vt = this line's receive time, so its body is the newest one served
    const r = await src.all()
    const got = new Map(r.snapshot!.aircraft.map((ac) => [ac.hex, toSample(ac, r.snapshot!.nowMs, 0, 0)!.tMs]))
    for (const ac of SNAPS[i].aircraft) {
      const want = SNAPS[i].nowMs - Math.round(ac.seen_pos! * 1000) + OFFSET
      assert.ok(Math.abs(got.get(ac.hex)! - want) <= 1, `${ac.hex}: ${got.get(ac.hex)} vs ${want}`)
    }
  }
})

test('consumed like a live upstream, replay yields exactly the positions and times of recordingToSamples', async () => {
  // Poller-style pipeline on an arbitrary local clock K: MinOffset(local recv − upstream now) + toSample + Deduper.
  const K = 42_000_000
  const clock = { t: K }
  const src = makeReplay({ files: [FILE], nowMs: () => clock.t })
  const offset = new MinOffset(60_000)
  const dedupe = new Deduper()
  const got: string[] = []
  for (let e = 0; e <= LAST - FIRST + 1_000; e += 250) {
    clock.t = K + e
    const r = await src.all()
    offset.update(r.tRecvMs, r.snapshot!.nowMs)
    for (const ac of r.snapshot!.aircraft) {
      const s = toSample(ac, r.snapshot!.nowMs, offset.get(), r.tRecvMs)
      // server clock → recording clock (− (K − FIRST)) → upstream clock (− OFFSET)
      if (s && dedupe.accept(s)) got.push(`${s.hex}@${s.tMs - (K - FIRST) - OFFSET}`)
    }
  }
  // recordingToSamples stamps each line with the causal min offset so far; subtracting it gives upstream time.
  const causal = new Map<number, number>()
  let m = Infinity
  for (const [i, l] of OK.entries()) causal.set(l.tRecvMs, (m = Math.min(m, l.tRecvMs - SNAPS[i].nowMs)))
  const want = recordingToSamples(LINES, { hideFlagged: false }).map((s) => `${s.hex}@${s.tMs - causal.get(s.rxMs)!}`)
  assert.equal(want.length, 65)
  assert.deepEqual(got.sort(), want.sort())
})

test('an aircraft is served while its latest position is ≤ 60 s old, then dropped', async () => {
  const { src, at } = clocked()
  const latest = new Map<string, number>() // hex → position time (recording clock) of its latest recorded object
  for (const s of SNAPS) for (const ac of s.aircraft) latest.set(ac.hex, s.nowMs - Math.round(ac.seen_pos! * 1000) + OFFSET)
  const counts: number[] = []
  for (const after of [0, 20_000, 40_000, 59_000]) {
    const vt = LAST + after
    at(vt - FIRST)
    const served = (await src.all()).snapshot!.aircraft.map((a) => a.hex).sort()
    const want = [...latest].filter(([, t]) => vt - t <= 60_000).map(([h]) => h).sort()
    assert.deepEqual(served, want)
    counts.push(served.length)
  }
  assert.ok(counts[0] > counts[1] && counts[3] > 0, `counts ${counts}`)
  at(LAST + 60_001 - FIRST)
  assert.deepEqual((await src.all()).snapshot!.aircraft, [])
})

test('circle and hexes filter the same snapshot', async () => {
  const { src } = clocked()
  const all = (await src.all()).snapshot!.aircraft
  const near = (await src.circle(37.6188, -122.3758, 5)).snapshot!.aircraft
  assert.ok(near.length > 0 && near.length < all.length, `${near.length} of ${all.length}`)
  assert.deepEqual(near, all.filter((a) => distanceNm(37.6188, -122.3758, a.lat!, a.lon!) <= 5))
  const found = await src.hexes(['A067EC', 'a99014', '~a3541a', 'ffffff'])
  assert.deepEqual(found.snapshot!.aircraft.map((a) => a.hex).sort(), ['a067ec', 'a99014', '~a3541a'])
  assert.match(found.url, /^replay:\/\?find_hex=/)
  assert.deepEqual((await src.hexes([])).snapshot!.aircraft, [])
})

test('loop restarts the recording while the served clock keeps moving forward', async () => {
  const period = LAST - FIRST + LOOP_GAP_MS
  const looped = clocked({ loop: true })
  const once = clocked()
  looped.at(500)
  const a = (await looped.src.all()).snapshot!
  const k = 25
  looped.at(k * period + 500)
  once.at(k * period + 500)
  const b = (await looped.src.all()).snapshot!
  assert.equal(b.nowMs, a.nowMs + k * period)
  assert.deepEqual(b.aircraft, a.aircraft) // same objects, same seen_pos: the whole recording shifted by k periods
  assert.deepEqual((await once.src.all()).snapshot!.aircraft, []) // without loop, everything has aged out
})

test('several files (any order) and globs replay as one recording', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fh-replay-'))
  const raw = readFileSync(FILE, 'utf8').trim().split('\n')
  writeFileSync(join(dir, 'b.jsonl'), raw.slice(0, 2).join('\n') + '\n')
  writeFileSync(join(dir, 'a.jsonl'), raw.slice(2).join('\n') + '\n')
  const one = clocked()
  const split = clocked({ files: [join(dir, 'a.jsonl'), join(dir, 'b.jsonl')] })
  const glob = clocked({ files: [join(dir, '*.jsonl')] })
  for (const e of [0, 1_000, 2_500, 30_000]) {
    for (const x of [one, split, glob]) x.at(e)
    const want = (await one.src.all()).body
    assert.equal((await split.src.all()).body, want)
    assert.equal((await glob.src.all()).body, want)
  }
})

test('a recording without one usable 200 line is a configuration error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fh-replay-'))
  const f = join(dir, 'x.jsonl')
  const bad200 = { ...LINES[0], body: '<html>502 Bad Gateway</html>' } // a proxy error page served with 200
  writeFileSync(f, [JSON.stringify(LINES[2]), JSON.stringify(bad200)].join('\n') + '\n') // the 429 + the bad 200
  assert.throws(() => makeReplay({ files: [f] }), /no usable/)
  assert.throws(() => makeReplay({ files: [join(dir, 'nothing-*.jsonl')] }), /no usable/)
})
