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
