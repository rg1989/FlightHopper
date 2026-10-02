// client/history/policy.ts
// History's decisions that need no map (app.ts acts on them): which half hours to ask for, how long one stays
// unasked after it was missing or failed, how far back a fresh fleet starts and how far ahead the selected aircraft's
// track is fed (both scaled to the slices the files were cut at), how wide a circle to ask for, and whether the
// selected aircraft's leg covers the replay time.
import type { HistoryStatus } from '../../shared/api.ts'
import { SLOT_MS, STEP_BANDS, slotOf } from '../../shared/history.ts'

const BACK_MIN_MS = 60_000
const LOOKAHEAD_MIN_MS = 20_000
const MISSING_KEEP_MS = 10 * 60_000 // the server remembers a missing file this long too
const RETRY_MS = 15_000 // a failed ask (the server busy or unreachable): asked again after this
const LEG_MARGIN_MS = 60_000
const MARGIN = 1.3 // a half hour is asked for a circle this much wider than the view: small pans ask nothing
const MIN_ASK_NM = 20
const CHASE_ASK_NM = 100 // the chase view moves with its aircraft: a small circle would be asked again every few seconds

/** How far back a fresh fleet starts: a minute, and 1.5 slices of a coarse file (else no slice is in reach). */
export function backMs(stepS: number): number {
  return Math.max(BACK_MIN_MS, 1500 * stepS)
}

/** How far past the replay time the selected aircraft's track is fed: 20 s, and two slices of a coarse file. */
export function lookaheadMs(stepS: number): number {
  return Math.max(LOOKAHEAD_MIN_MS, 2000 * stepS)
}

/**
 * The half hours to ask for at replay time t: the one holding it, never the one still in progress (maxMs, the end of
 * the newest published, is its start), and the next one prefetchMs before it starts when that is published.
 */
export function wantedSlots(t: number, maxMs: number, prefetchMs: number): number[] {
  const slot = slotOf(Math.min(t, maxMs - 1))
  return t - slot > SLOT_MS - prefetchMs && slot + SLOT_MS < maxMs ? [slot, slot + SLOT_MS] : [slot]
}

/** Half hours not to ask for now: missing (adsb.lol has no file: MISSING_KEEP_MS) or failed (RETRY_MS). */
export class SlotBlock {
  #until = new Map<number, number>()
  #missing = new Set<number>()

  missing(slot: number, nowMs: number): void {
    this.#until.set(slot, nowMs + MISSING_KEEP_MS)
    this.#missing.add(slot)
  }

  failed(slot: number, nowMs: number): void {
    this.#until.set(slot, nowMs + RETRY_MS)
    this.#missing.delete(slot)
  }

  blocked(slot: number, nowMs: number): boolean {
    const until = this.#until.get(slot)
    if (until === undefined) return false
    if (nowMs < until) return true
    this.#until.delete(slot)
    this.#missing.delete(slot)
    return false
  }

  isMissing(slot: number, nowMs: number): boolean {
    return this.blocked(slot, nowMs) && this.#missing.has(slot)
  }

  /** The server's view: its missing ones are missing here, any other state it lists clears a missing one. */
  fromStatus(slots: HistoryStatus['slots'], nowMs: number): void {
    for (const s of slots) {
      if (s.state === 'missing') {
        if (!this.#missing.has(s.slotMs)) this.missing(s.slotMs, nowMs)
      } else if (this.#missing.delete(s.slotMs)) this.#until.delete(s.slotMs)
    }
  }
}

/** The leg (TraceReply's times) covers t: from a minute before its first point to a minute after its last. */
export function legCovers(leg: { t0Ms: number; t: readonly number[] }, t: number): boolean {
  return t >= leg.t0Ms - LEG_MARGIN_MS && t <= leg.t0Ms + (leg.t.at(-1) ?? 0) * 1000 + LEG_MARGIN_MS
}

/**
 * The radius to ask a half hour for, around a view of radius nm: MARGIN wider, but within the view's step band (a
 * wider circle is cut coarser, and the feed would never find the view covered); a chase at least CHASE_ASK_NM.
 * ponytail: a view just under a band's edge gets no margin (asked again on each pan; the server has the file, so it
 * is a local answer, not a download). Upgrade: let /api/history take the step.
 */
export function askNm(nm: number, chasing: boolean): number {
  const cap = (STEP_BANDS.find(([max]) => nm <= max) ?? STEP_BANDS[STEP_BANDS.length - 1])[0]
  return Math.min(cap, Math.max(chasing ? CHASE_ASK_NM : MIN_ASK_NM, Math.round(nm * MARGIN)))
}
