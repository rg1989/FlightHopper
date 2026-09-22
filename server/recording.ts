import { readFileSync } from 'node:fs'
import { MinOffset } from '../shared/clock.ts'
import { Deduper } from '../shared/dedupe.ts'
import { normalizers } from '../shared/readsb.ts'
import { isHidden, toSample } from '../shared/sample.ts'
import type { Sample } from '../shared/types.ts'

/** One upstream poll, recorded verbatim. Written by server/recorder.ts and tools/record-cells.ts. */
export interface RecordLine {
  v: 1
  source: 'adsblol' | 'readsb'
  url: string
  status: number
  tSendMs: number
  tRecvMs: number
  bytes: number
  body: string
}

export function parseRecordLine(line: string): RecordLine {
  const r = JSON.parse(line)
  if (r?.v !== 1 || (r.source !== 'adsblol' && r.source !== 'readsb')) throw new Error('not a v1 record line')
  return r as RecordLine
}

export function readRecording(path: string): RecordLine[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map(parseRecordLine)
}

/**
 * Causal conversion of recorded polls to deduped samples, in recording (arrival) order.
 * Server clock = the recording machine's clock: offset is the windowed min of (tRecvMs − upstream now),
 * updated with each line BEFORE that line's samples are stamped. rxMs = tRecvMs.
 */
export function recordingToSamples(lines: RecordLine[], opts: { hideFlagged?: boolean } = {}): Sample[] {
  const hideFlagged = opts.hideFlagged ?? true
  const offset = new MinOffset(10 * 60_000)
  const dedupe = new Deduper()
  const out: Sample[] = []
  for (const line of lines) {
    if (line.status !== 200 || line.body === '') continue
    const snap = normalizers[line.source](line.body)
    offset.update(line.tRecvMs, snap.nowMs)
    for (const ac of snap.aircraft) {
      if (hideFlagged && isHidden(ac)) continue
      const s = toSample(ac, snap.nowMs, offset.get(), line.tRecvMs)
      if (s && dedupe.accept(s)) out.push(s)
    }
  }
  return out
}
