# WP-S2 — Replay, Recorder & Fake Receiver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the server run offline and switch sources by configuration. This package makes three things: a `replay` Source that serves recorded polls like a live full-snapshot upstream, a `Recorder` that writes every live poll to daily JSONL files, and a fake readsb receiver that serves a recording over readsb's `--net-api-port` API (for the A1 flip test and for work on `ADSB_SOURCE=readsb` before the receiver arrives).

**Architecture:** `makeReplay` loads RecordLine files with WP-00 `readRecording` and normalises each status-200 body. It indexes the positioned aircraft objects by poll receive time. One global offset `min(tRecvMs − upstream now)` maps each position time into the recording machine's clock. Each call computes the virtual time `vt` and walks back over the last 60 s of polls. It then serves the latest object per hex, with `seen_pos`/`seen` rebased to `vt`, as a readsb-shaped body `{now, aircraft}`. `Recorder` is a short append-only writer of the exact format `server/recording.ts` reads. `tools/fake-readsb.ts` is a `node:http` wrapper around `makeReplay` (its second user) that speaks readsb's query API and envelope.

**Tech Stack:** Node ≥ 24.2 (`node:http`, `node:fs` `globSync`, `node:util` `parseArgs`), `node:test` + `node:assert/strict`. No new dependencies.

**Wave:** 1 (parallel; depends only on WP-00). Consumed by I1 (`Recorder`), I3 (`Recorder`) and A1 (`makeReplay`, `startFakeReadsb` flip test). **Estimated:** 1.5–2 h. **Validated:** every file below was run on 2026-09-22 in a scratch copy of the WP-00 tree (Node 25.2.1, TypeScript 7.0.2). Results: 18/18 tests pass (replay 9, recorder 5, fake-readsb 4), and the WP-00 tests still pass. `tsc --noEmit` shows no errors in these files. Three deliberate mutations of `replay.ts` each make two replay tests fail: no `seen_pos` rebase; offset + 7 ms; no latest-per-hex rule. The CLI, run by hand with `--files 'data/fixtures/golden/*.jsonl' --loop`, served `/?circle=37.6188,-122.3758,3` (32 aircraft) and returned 400 for an unknown query (checked with curl).

## Global Constraints

See `.planning/PLAN.md` § Global Constraints — they apply to every task here. The ones that matter most in this package:
- Unit tests never touch the network. They serve the golden fixture on `127.0.0.1` port 0 and write only under `os.tmpdir()`.
- `Sample.tMs` is the upstream `now` minus `seen_pos`. The replay therefore rebases `seen_pos` and never changes position times in any other way.
- File ownership: only the six files below. WP-00 files (`server/recording.ts`, `server/sources/types.ts`, `shared/*`) are read-only.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `server/sources/replay.ts`, `server/sources/replay.test.ts` | `makeReplay`: recorded polls as a full-snapshot `Source` |
| `server/recorder.ts`, `server/recorder.test.ts` | `Recorder`: live polls → `<dir>/YYYY-MM-DD.jsonl` |
| `tools/fake-readsb.ts`, `tools/fake-readsb.test.ts` | `startFakeReadsb` + CLI: a recording behind readsb's API |

## Replay rules (PLAN.md §4 S2; each rule is pinned by a test in Task 1)

1. **Input.** All files are read, and glob patterns are expanded and sorted. Usable polls are the status-200 lines whose body normalises with `normalizers[line.source]`, sorted by `tRecvMs`. A 200 with a non-JSON body (for example a proxy error page) is skipped. With no usable poll, `makeReplay` throws `replay: no usable (status 200) lines in …`.
2. **Clock.** `offset = min(tRecvMs − snapshot.nowMs)` over all usable polls. An object's position time in recording clock is `posT = nowMs − round(seen_pos·1000) + offset`. Only objects with numeric `lat`, `lon` and `seen_pos` are kept. Because `offset ≤ tRecvMs − nowMs` for every poll, `posT ≤ tRecvMs` always.
3. **Virtual time.** `vt = round(firstTRecv + (nowMs() − start)·speed)`. `start` is `nowMs()` when `makeReplay` runs. `firstTRecv` is the first usable poll. `vt` is rounded to whole ms, so `now` has at most 3 decimals, as readsb's does. `speed` defaults to 1; `speed: 0` freezes the replay at its first poll.
4. **Served set.** For each hex, the object from the latest poll with `tRecvMs ≤ vt` is served. It is dropped when `vt − posT > 60 s` (readsb's `all_with_pos` window). Then `seen_pos = (vt − posT)/1000` and `seen = (vt − seenT)/1000`, so `toSample(ac, vt, 0, rx).tMs === posT`. Polls older than `vt − 60 s` cannot contribute, so each call only scans the last minute.
5. **Filters.** `circle`: `distanceNm(lat, lon, ac.lat, ac.lon) ≤ radiusNm`. `hexes`: case-insensitive match. `all`: everything.
6. **Loop.** `period = lastTRecv − firstTRecv + LOOP_GAP_MS (1 s)`. The lookup uses `rt = first + (vt − first) mod period`, but `now` stays `vt`. The served clock therefore never runs backwards, and a downstream `MinOffset` and `Deduper` stay valid across loops. Without `loop`, every aircraft ages out 60 s after the last poll and `aircraft` is then `[]`.
7. **Result.** `url` is `replay:/?<circle=…|find_hex=…|all_with_pos>`, status 200, `tSendMs = tRecvMs = nowMs()`, `bytes` is the UTF-8 length of `body`, `retryAfterS` is null. `snapshot` is `{ nowMs: vt, aircraft }` and deep-equals `normalizeReadsb(body)`.

---

### Task 1: Replay source

**Files:**
- Create: `server/sources/replay.ts`, `server/sources/replay.test.ts`
- Test: `server/sources/replay.test.ts`

**Interfaces:**
- Consumes: `readRecording` (`server/recording.ts`), `normalizers` (`shared/readsb.ts`), `distanceNm` (`shared/geo.ts`), types `ReadsbAircraft`, `Snapshot` (`shared/types.ts`), `FetchResult`, `Source` (`server/sources/types.ts`). The test also uses `recordingToSamples`, `toSample`, `MinOffset`, `Deduper`, `normalizeReadsb` and `data/fixtures/golden/recording-sample.jsonl`.
- Produces: `makeReplay(opts: { files: string[]; speed?: number; loop?: boolean; nowMs?: () => number }): Source` with caps `{ kind: 'replay', fullSnapshot: true, maxRps: 10, coverage: null, attribution }`. `attribution` names adsb.lol (ODbL 1.0) when any line came from adsb.lol. Extra exports: `MAX_POS_AGE_MS = 60_000`, `LOOP_GAP_MS = 1_000`, `expandFiles(files: string[]): string[]`. Note for I1/A1: the body's `now` is in the recording machine's clock. The Poller's per-source `MinOffset` maps it to server clock like any other upstream. `files` entries may be globs, so `REPLAY_FILES=data/fixtures/*.jsonl` can be passed through as-is.

- [ ] **Step 1: Write the failing test**

The key tests are the third and fourth. The third stamps every served object with `toSample(…, offset 0)` and gets back the original position time (±1 ms). The fourth consumes the replay like a live upstream (MinOffset + `toSample` + `Deduper`, 4 polls/s on an unrelated local clock). It shows the result is exactly the 65 positions `recordingToSamples` produces, at the same upstream times.

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/sources/replay.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/sources/replay.ts' imported from …/server/sources/replay.test.ts`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// server/sources/replay.ts
// Replays recorded upstream polls (RecordLine JSONL) as a full-snapshot source with readsb-shaped bodies,
// so the whole server runs offline exactly as it would against a receiver.
// ponytail: every file is parsed into memory at start. Fine for curated fixtures (tens of MB); a full-day
// recording (hundreds of MB) needs a streamed, time-indexed reader instead.
import { globSync } from 'node:fs'
import { distanceNm } from '../../shared/geo.ts'
import { normalizers } from '../../shared/readsb.ts'
import type { ReadsbAircraft, Snapshot } from '../../shared/types.ts'
import { readRecording } from '../recording.ts'
import type { FetchResult, Source } from './types.ts'

/** readsb's all_with_pos serves positions up to one minute old. */
export const MAX_POS_AGE_MS = 60_000
/** Pause between the end of a looped recording and its restart, so two passes never share a timestamp. */
export const LOOP_GAP_MS = 1_000

/** One recorded aircraft object; posT/seenT are its position / last-message times in recording clock (ms). */
interface Obj {
  ac: ReadsbAircraft
  posT: number
  seenT: number | null
}

interface Poll {
  tRecvMs: number
  objs: Obj[]
}

/** Glob patterns are expanded (sorted); plain paths pass through, so a missing file fails loudly on read. */
export function expandFiles(files: string[]): string[] {
  return files.flatMap((f) => (/[*?[{]/.test(f) ? globSync(f).sort() : [f]))
}

function loadPolls(files: string[]): { polls: Poll[]; fromAdsblol: boolean } {
  const lines = expandFiles(files).flatMap((f) => readRecording(f))
  const ok: { tRecvMs: number; snap: Snapshot }[] = []
  for (const l of lines) {
    if (l.status !== 200 || l.body === '') continue
    try {
      ok.push({ tRecvMs: l.tRecvMs, snap: normalizers[l.source](l.body) })
    } catch {
      // a 200 whose body is not the API's JSON (e.g. a proxy error page): nothing to replay
    }
  }
  if (ok.length === 0) throw new Error(`replay: no usable (status 200) lines in ${files.join(', ')}`)
  ok.sort((a, b) => a.tRecvMs - b.tRecvMs)
  // One global upstream → recording clock offset: the smallest (receive − upstream now) over the whole recording.
  let offset = Infinity
  for (const p of ok) offset = Math.min(offset, p.tRecvMs - p.snap.nowMs)
  const ms = (s: number): number => Math.round(s * 1000)
  const polls = ok.map(({ tRecvMs, snap }) => ({
    tRecvMs,
    objs: snap.aircraft
      .filter((ac) => typeof ac.lat === 'number' && typeof ac.lon === 'number' && typeof ac.seen_pos === 'number')
      .map((ac) => ({
        ac,
        posT: snap.nowMs - ms(ac.seen_pos!) + offset,
        seenT: typeof ac.seen === 'number' ? snap.nowMs - ms(ac.seen) + offset : null,
      })),
  }))
  return { polls, fromAdsblol: lines.some((l) => l.source === 'adsblol') }
}

/** Index of the last poll received at or before t, or −1. */
function lastAtOrBefore(polls: Poll[], t: number): number {
  let lo = 0
  let hi = polls.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (polls[mid].tRecvMs <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/**
 * A full-snapshot Source over recorded polls. Virtual time vt = first tRecv + (nowMs() − start) · speed, in the
 * recording machine's clock. Each call serves, per hex, the latest recorded object received ≤ vt whose position
 * is ≤ 60 s old, with seen_pos (and seen) rebased so that now − seen_pos is the original position time.
 * loop: after the last poll (+ LOOP_GAP_MS) the recording restarts, shifted forward by whole periods.
 * ponytail: a hex present at both ends of a looped recording jumps at the seam; fine for development.
 */
export function makeReplay(opts: { files: string[]; speed?: number; loop?: boolean; nowMs?: () => number }): Source {
  const { polls, fromAdsblol } = loadPolls(opts.files)
  const speed = opts.speed ?? 1
  const nowMs = opts.nowMs ?? Date.now
  const first = polls[0].tRecvMs
  const period = polls[polls.length - 1].tRecvMs - first + LOOP_GAP_MS
  const start = nowMs()

  function snapshotAt(t: number, keep: (ac: ReadsbAircraft) => boolean): Snapshot {
    const vt = Math.round(first + (t - start) * speed)
    const rt = opts.loop ? first + ((vt - first) % period) : vt // position inside the recording
    const done = new Set<string>()
    const aircraft: ReadsbAircraft[] = []
    // A position is never newer than its poll's receive time, so polls older than 60 s cannot contribute.
    for (let i = lastAtOrBefore(polls, rt); i >= 0 && polls[i].tRecvMs >= rt - MAX_POS_AGE_MS; i--) {
      for (const o of polls[i].objs) {
        if (done.has(o.ac.hex)) continue // newest poll first: the latest recorded object per hex wins
        done.add(o.ac.hex)
        if (rt - o.posT > MAX_POS_AGE_MS || !keep(o.ac)) continue
        // ponytail: other fields (dst/dir, rssi, …) pass through as recorded; nothing downstream reads them.
        const ac: ReadsbAircraft = { ...o.ac, seen_pos: (rt - o.posT) / 1000 }
        if (o.seenT !== null) ac.seen = (rt - o.seenT) / 1000
        aircraft.push(ac)
      }
    }
    return { nowMs: vt, aircraft }
  }

  async function serve(query: string, keep: (ac: ReadsbAircraft) => boolean): Promise<FetchResult> {
    const t = nowMs()
    const snapshot = snapshotAt(t, keep)
    const body = JSON.stringify({ now: snapshot.nowMs / 1000, aircraft: snapshot.aircraft })
    return { url: `replay:/?${query}`, status: 200, tSendMs: t, tRecvMs: t, bytes: Buffer.byteLength(body), body, retryAfterS: null, snapshot }
  }

  return {
    caps: {
      kind: 'replay',
      fullSnapshot: true,
      maxRps: 10,
      coverage: null,
      attribution: fromAdsblol ? 'Replay of recorded adsb.lol data (ODbL 1.0)' : 'Replay of recorded receiver data',
    },
    circle: (lat, lon, radiusNm) =>
      serve(`circle=${lat},${lon},${radiusNm}`, (ac) => distanceNm(lat, lon, ac.lat!, ac.lon!) <= radiusNm),
    hexes: (hexes) => {
      const want = new Set(hexes.map((h) => h.toLowerCase()))
      return serve(`find_hex=${[...want].join(',')}`, (ac) => want.has(ac.hex.toLowerCase()))
    },
    all: () => serve('all_with_pos', () => true),
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/sources/replay.test.ts`
Expected: PASS — `ℹ tests 9`, `ℹ pass 9`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/sources/replay.ts server/sources/replay.test.ts
git commit -m "feat(server): replay source serving recordings as a readsb-shaped full snapshot" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Recorder

**Files:**
- Create: `server/recorder.ts`, `server/recorder.test.ts`
- Test: `server/recorder.test.ts`

**Interfaces:**
- Consumes: `RecordLine`, `readRecording`, `recordingToSamples` (`server/recording.ts`), `FetchResult` (`server/sources/types.ts`), `SourceKind` (`shared/types.ts`).
- Produces: `class Recorder { constructor(dir: string); write(kind: SourceKind, r: FetchResult): void }`. The constructor creates `dir` (recursive). `write` appends `JSON.stringify(RecordLine) + '\n'` to `<dir>/<UTC date of tSendMs>.jsonl`. It skips `kind === 'replay'`, and `body` is `''` unless `status === 200`. I/O errors are thrown to the caller; the Poller decides what to do with them. The output is the same format `tools/record-cells.ts` writes, so `readRecording`/`makeReplay` read both.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/recorder.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/recorder.ts' imported from …/server/recorder.test.ts`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// server/recorder.ts
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceKind } from '../shared/types.ts'
import type { RecordLine } from './recording.ts'
import type { FetchResult } from './sources/types.ts'

/**
 * Appends every live upstream poll to <dir>/YYYY-MM-DD.jsonl (UTC date of tSendMs), one RecordLine per line,
 * the same format tools/record-cells.ts writes and server/recording.ts reads.
 * Replay results are skipped (re-recording a recording is noise); bodies are kept only for status 200.
 * ponytail: one synchronous append per poll (≤ 10/s). Switch to a WriteStream per day if it ever shows in a profile.
 */
export class Recorder {
  #dir: string

  constructor(dir: string) {
    this.#dir = dir
    mkdirSync(dir, { recursive: true })
  }

  write(kind: SourceKind, r: FetchResult): void {
    if (kind === 'replay') return
    const line: RecordLine = {
      v: 1,
      source: kind,
      url: r.url,
      status: r.status,
      tSendMs: r.tSendMs,
      tRecvMs: r.tRecvMs,
      bytes: r.bytes,
      body: r.status === 200 ? r.body : '',
    }
    const day = new Date(r.tSendMs).toISOString().slice(0, 10)
    appendFileSync(join(this.#dir, `${day}.jsonl`), JSON.stringify(line) + '\n')
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/recorder.test.ts`
Expected: PASS — `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/recorder.ts server/recorder.test.ts
git commit -m "feat(server): recorder appending live polls to UTC daily JSONL" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Fake readsb receiver

**Files:**
- Create: `tools/fake-readsb.ts`, `tools/fake-readsb.test.ts`
- Test: `tools/fake-readsb.test.ts`

**Interfaces:**
- Consumes: `makeReplay` (Task 1), `FetchResult`, `Source` (`server/sources/types.ts`). The test also uses `normalizeReadsb`, `distanceNm`, `readRecording`.
- Produces: `startFakeReadsb(opts: { files: string[]; port: number; speed?: number; loop?: boolean }): Promise<{ url: string; close(): Promise<void> }>`. `loop` is an optional extra passed through to `makeReplay`. It binds `127.0.0.1`; port 0 picks a free port, and `url` is `http://127.0.0.1:<port>` with no trailing slash. Routes (the path is ignored, only the query counts): `?circle=lat,lon,nm`, `?find_hex=h1,h2`, `?all_with_pos` → 200 `application/json` `{ now (s), resultCount, ptime (ms), aircraft }`; anything else → 400. CLI: `node tools/fake-readsb.ts --files <glob or paths> [--port 8042] [--speed 1] [--loop]`. It prints `fake readsb on <url> …` on stdout. readsb API facts (query syntax, units, envelope fields, `all_with_pos` = position within the last minute) are from https://github.com/wiedehopf/readsb/blob/dev/README-json.md.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/fake-readsb.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tools/fake-readsb.ts' imported from …/tools/fake-readsb.test.ts`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// tools/fake-readsb.ts
// Stand-in for your own receiver: serves a recording through readsb's --net-api-port query API, so
// ADSB_SOURCE=readsb can be developed and flip-tested before the receiver exists.
//
//   node tools/fake-readsb.ts --files 'data/fixtures/*.jsonl' --port 8042 [--speed 1] [--loop]
//   curl 'http://127.0.0.1:8042/?circle=37.6188,-122.3758,40'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseArgs } from 'node:util'
import { makeReplay } from '../server/sources/replay.ts'
import type { FetchResult, Source } from '../server/sources/types.ts'

/** The three readsb API queries the server uses; null for anything else. */
function route(src: Source, q: URLSearchParams): Promise<FetchResult> | null {
  const circle = q.get('circle')
  if (circle !== null) {
    const p = circle.split(',').map(Number)
    return p.length === 3 && p.every(Number.isFinite) ? src.circle(p[0], p[1], p[2]) : null
  }
  const hexes = q.get('find_hex')
  if (hexes !== null) return src.hexes(hexes.split(',').filter((h) => h !== ''))
  if (q.has('all_with_pos')) return src.all()
  return null
}

/**
 * Serves `files` (paths or globs) as readsb does on --net-api-port: /?circle=lat,lon,nm, /?find_hex=h1,h2,
 * /?all_with_pos, in the envelope { now (s), resultCount, ptime (ms), aircraft }. Listens on 127.0.0.1;
 * port 0 picks a free port. The replay clock starts now; speed 0 freezes it at the first poll.
 */
export async function startFakeReadsb(opts: {
  files: string[]
  port: number
  speed?: number
  loop?: boolean
}): Promise<{ url: string; close(): Promise<void> }> {
  const src = makeReplay({ files: opts.files, speed: opts.speed, loop: opts.loop })
  const server = createServer(async (req, res) => {
    const t0 = performance.now()
    const pending = route(src, new URL(req.url ?? '/', 'http://fake').searchParams)
    if (pending === null) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('expected ?circle=lat,lon,nm | ?find_hex=h1,h2 | ?all_with_pos\n')
      return
    }
    const { nowMs, aircraft } = (await pending).snapshot!
    const ptime = Math.round((performance.now() - t0) * 1000) / 1000
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ now: nowMs / 1000, resultCount: aircraft.length, ptime, aircraft }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()))
        server.closeAllConnections() // keep-alive clients would otherwise hold close() open
      }),
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      files: { type: 'string', multiple: true },
      port: { type: 'string', default: '8042' },
      speed: { type: 'string', default: '1' },
      loop: { type: 'boolean', default: false },
    },
  })
  // An unquoted `--files data/*.jsonl` arrives shell-expanded: the first file as --files, the rest as positionals.
  const files = [...(values.files ?? []), ...positionals]
  if (files.length === 0) throw new Error('usage: node tools/fake-readsb.ts --files <glob or paths> [--port 8042] [--speed 1] [--loop]')
  const { url } = await startFakeReadsb({ files, port: Number(values.port), speed: Number(values.speed), loop: values.loop })
  console.log(`fake readsb on ${url} (try ${url}/?all_with_pos)`)
}

if (import.meta.main) await main()
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/fake-readsb.test.ts`
Expected: PASS — `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add tools/fake-readsb.ts tools/fake-readsb.test.ts
git commit -m "feat(tools): fake readsb receiver serving recordings over the readsb API" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: All tests of this package**

Run: `node --test server/sources/replay.test.ts server/recorder.test.ts tools/fake-readsb.test.ts`
Expected: `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 2: Type-check, filtered to this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'server/sources/replay|server/recorder|tools/fake-readsb'`
Expected: no output (grep exits 1). Errors in other packages' files are not this package's gate.

- [ ] **Step 3: Smoke-test the CLI by hand (optional, local only)**

```bash
node tools/fake-readsb.ts --files 'data/fixtures/golden/*.jsonl' --port 8042 --loop &
sleep 1
curl -s 'http://127.0.0.1:8042/?circle=37.6188,-122.3758,3' | head -c 200; echo
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8042/?bogus'
kill %1
```

Expected: `fake readsb on http://127.0.0.1:8042 …`, then a readsb body such as `{"now":1790081711.8,"resultCount":32,"ptime":0.6,"aircraft":[…` (`now` is about 1790081711 and there are about 30 aircraft; the exact values depend on how much time has passed), then `400`.
