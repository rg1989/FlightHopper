// client/api.ts
// Browser client for the FlightHopper server: GET /view and /chase with a per-key `since`, plus the server clock.
import type { ChaseResponse, ViewResponse } from '../shared/api.ts'
import { MinOffset } from '../shared/clock.ts'

const OFFSET_WINDOW_MS = 60_000
const TIMEOUT_MS = 10_000 // a hung request must not stall the 1 Hz poll loop
// ponytail: plain insertion-order eviction; a camera panning for hours creates many view keys. Upgrade to real LRU if
// a key ever gets evicted while still polled (it would only cost one full `since=0` reply).
const MAX_KEYS = 100

export class ApiClient {
  #base: string
  #fetch: typeof fetch
  #nowMs: () => number
  #offset = new MinOffset(OFFSET_WINDOW_MS)
  #since = new Map<string, number>()

  /** Wrap the global fetch: a browser throws "Illegal invocation" when fetch is called as a method of another object. */
  constructor(base: string, fetchFn: typeof fetch = (input, init) => fetch(input, init), nowMs: () => number = Date.now) {
    this.#base = base
    this.#fetch = fetchFn
    this.#nowMs = nowMs
  }

  /** Samples in the circle received by the server after the last reply for this view (key: lat/lon to 2 decimals + nm). */
  view(lat: number, lon: number, radiusNm: number): Promise<ViewResponse> {
    const key = `view:${lat.toFixed(2)},${lon.toFixed(2)},${radiusNm}`
    return this.#get(key, (since) => `${this.#base}/view?lat=${lat}&lon=${lon}&nm=${radiusNm}&since=${since}`)
  }

  /** The chased aircraft's samples received by the server after the last reply for this hex. */
  chase(hex: string): Promise<ChaseResponse> {
    return this.#get(`chase:${hex}`, (since) => `${this.#base}/chase?hex=${hex}&since=${since}`)
  }

  /** Server clock now, from the local clock and the smallest (receive − serverNowMs) of the last 60 s. Throws before `ready`. */
  serverNowMs(): number {
    if (!this.#offset.ready) throw new Error('ApiClient: no response yet')
    return this.#nowMs() - this.#offset.get()
  }

  get ready(): boolean {
    return this.#offset.ready
  }

  async #get<T extends ViewResponse | ChaseResponse>(key: string, url: (since: number) => string): Promise<T> {
    const res = await this.#fetch(url(this.#since.get(key) ?? 0), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const recvMs = this.#nowMs() // headers are in: the closest local time to when the server stamped serverNowMs
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // ponytail: trusts the JSON shape; this is our own server built from the same shared/api.ts contract.
    const body = (await res.json()) as T
    this.#offset.update(recvMs, body.serverNowMs)
    let since = this.#since.get(key) ?? 0 // re-read after the await: overlapping requests only ever raise it
    for (const s of body.samples) if (s.rxMs > since) since = s.rxMs
    this.#since.delete(key) // re-insert so the oldest-used key is evicted first
    this.#since.set(key, since)
    if (this.#since.size > MAX_KEYS) this.#since.delete(this.#since.keys().next().value!)
    return body
  }
}
