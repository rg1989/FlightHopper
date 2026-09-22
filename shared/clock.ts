/**
 * Windowed minimum of (localRecvMs − remoteNowMs) = remote→local clock offset + smallest one-way latency seen.
 * Add get() to a remote timestamp to express it in the local clock.
 */
export class MinOffset {
  #win: { t: number; v: number }[] = []
  #windowMs: number

  constructor(windowMs: number) {
    this.#windowMs = windowMs
  }

  update(localRecvMs: number, remoteNowMs: number): void {
    this.#win.push({ t: localRecvMs, v: localRecvMs - remoteNowMs })
    const cutoff = localRecvMs - this.#windowMs
    while (this.#win.length > 1 && this.#win[0].t < cutoff) this.#win.shift()
  }

  get ready(): boolean {
    return this.#win.length > 0
  }

  get(): number {
    if (this.#win.length === 0) throw new Error('MinOffset: no samples yet')
    let m = Infinity
    for (const x of this.#win) if (x.v < m) m = x.v
    return m
  }
}
