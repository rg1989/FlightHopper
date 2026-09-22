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
