// server/budget.ts
import type { BudgetState, Degraded } from '../shared/api.ts'

const BURST = 2
const RATE_LIMITED_MS = 60_000 // a 429 younger than this → degraded 'rate-limited'
const MAX_BACKOFF_MS = 60_000
const DEFAULT_RETRY_AFTER_S = 5

/**
 * Upstream request budget: a token bucket (burst 2) whose rate adapts to what the upstream answers.
 * Call tryTake() before each request and onResult() with its outcome.
 * 429 → rate halves for good and pauses for Retry-After (PLAN.md Global Constraints: never climb back toward a refused rate).
 * 401/403 → blocked forever (never retry a block). 5xx / network error (status 0) → exponential pause.
 * After any pause exactly one probe request is allowed; then the steady rate applies.
 */
export class TokenBucket {
  #maxRps: number
  #now: () => number
  #random: () => number
  #rps: number
  #tokens = BURST
  #lastMs: number // tokens are accrued up to this time
  #last429Ms = -Infinity
  #pausedUntilMs = 0
  #blocked = false
  #fails = 0 // consecutive 5xx / network errors
  #counts = { ok: 0, r429: 0, r4xx: 0, r5xx: 0, err: 0 }

  /** random is the jitter source (tests inject a constant). */
  constructor(maxRps: number, nowMs: () => number = Date.now, random: () => number = Math.random) {
    this.#maxRps = maxRps
    this.#rps = maxRps
    this.#now = nowMs
    this.#random = random
    this.#lastMs = nowMs()
  }

  tryTake(): boolean {
    const now = this.#advance()
    if (this.#blocked || now < this.#pausedUntilMs || this.#tokens < 1) return false
    this.#tokens -= 1
    return true
  }

  onResult(status: number, retryAfterS: number | null): void {
    const now = this.#advance()
    if (status === 429) {
      this.#counts.r429++
      this.#fails = 0
      this.#rps /= 2
      this.#last429Ms = now
      this.#pause(now + (retryAfterS ?? DEFAULT_RETRY_AFTER_S) * 1000)
    } else if (status === 401 || status === 403) {
      this.#counts.r4xx++
      this.#blocked = true
    } else if (status === 0 || status >= 500) {
      if (status === 0) this.#counts.err++
      else this.#counts.r5xx++
      this.#fails++
      this.#pause(now + Math.min(MAX_BACKOFF_MS, 2 ** this.#fails * 1000 + this.#random() * 1000))
    } else {
      if (status >= 400) this.#counts.r4xx++
      else this.#counts.ok++
      this.#fails = 0
    }
  }

  state(): BudgetState {
    this.#advance()
    return {
      rps: this.#rps,
      maxRps: this.#maxRps,
      tokens: this.#tokens,
      blocked: this.#blocked,
      pausedUntilMs: this.#pausedUntilMs,
      counts: { ...this.#counts },
    }
  }

  get degraded(): Degraded {
    if (this.#blocked) return 'blocked'
    if (this.#now() - this.#last429Ms < RATE_LIMITED_MS) return 'rate-limited'
    if (this.#fails >= 3) return 'upstream-down'
    return null
  }

  /** Brings tokens up to now; returns now. */
  #advance(): number {
    const now = this.#now()
    this.#accrue(now)
    return now
  }

  #accrue(t: number): void {
    if (t <= this.#lastMs) return
    this.#tokens = Math.min(BURST, this.#tokens + ((t - this.#lastMs) * this.#rps) / 1000)
    this.#lastMs = t
  }

  /** Nothing is sent before untilMs; exactly one token is ready at untilMs. A pause is never shortened. */
  #pause(untilMs: number): void {
    if (untilMs <= this.#pausedUntilMs) return
    this.#pausedUntilMs = untilMs
    this.#tokens = 1
    this.#lastMs = untilMs
  }
}
