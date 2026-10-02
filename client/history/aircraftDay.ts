// client/history/aircraftDay.ts
// One aircraft through a day of History (design D2). The server gives the aircraft's flight legs for the day (TraceDay.legs,
// in time order); at a replay time the aircraft is in one of five states: heard (a leg feeds the time), gap (inside a
// leg, in a hole no receiver heard: between two of its points the flown path draws dotted), quiet (after a leg, before
// the next: it was somewhere, and not heard), before (earlier than its first leg) or none (no leg that day).
// Pure: the app draws and words what the state says.
import type { TraceReply } from '../../shared/api.ts'
import { isGap } from '../scene/pathGap.ts'
import { legFeeds } from './policy.ts'

export type DayState =
  | { kind: 'heard'; leg: TraceReply } // t from the leg's first point to a minute after its last (policy.ts legFeeds), except in a hole
  | { kind: 'gap'; leg: TraceReply; sinceMs: number; untilMs: number } // strictly inside a hole of the leg: its points either side
  | { kind: 'quiet'; leg: TraceReply; sinceMs: number } // after that leg, before the next: where it ended (sinceMs: its last point)
  | { kind: 'before'; leg: TraceReply; untilMs: number } // earlier than its first leg (leg): not heard until its first point
  | { kind: 'none' } // no legs

/**
 * A time in a leg (s after its t0Ms) as UTC ms, whole: its points (traceSamples, tracePath), its callsign changes and its
 * span are all placed by it, so they agree to the ms (32.2 s × 1000 is 32200.000000000004 in floating point).
 */
export function legMs(t0Ms: number, s: number): number {
  return Math.round(t0Ms + s * 1000)
}

/** The time of the leg's last point, UTC ms, whole (as traceSamples gives it). */
export function legEndMs(leg: TraceReply): number {
  return legMs(leg.t0Ms, leg.t.at(-1) ?? 0)
}

/** Each leg from its first point to its last: its bar on the timeline. */
export function legSpans(legs: readonly TraceReply[]): { fromMs: number; toMs: number }[] {
  return legs.map((leg) => ({ fromMs: leg.t0Ms, toMs: legEndMs(leg) }))
}

/** How many of the leg's points are at or before t (their times as legMs places them): a binary search, legs are long. */
export function pointsUpTo(leg: TraceReply, t: number): number {
  let lo = 0
  let hi = leg.t.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (legMs(leg.t0Ms, leg.t[mid]) <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Where the aircraft is at replay time t (legs in time order, none inside another: one aircraft flies one leg at a time).
 * The leg that counts is the last to have started: legs that touch or overlap by a few seconds (a file's edge) hand over
 * at the later one's first point. Heard is policy.ts's legFeeds of it, so the map, the card and the track agree on when a
 * leg is the aircraft, except strictly inside a step the flown path draws dotted (scene/pathGap.ts isGap): a gap, between
 * the points either side (at either point it is heard). Otherwise it has ended and the aircraft is quiet where it ended
 * (sinceMs its last point).
 * ponytail: the last leg started is found by a scan: a day has a handful of legs. Upgrade: a binary search on t0Ms if a
 * day ever held thousands.
 */
export function dayState(legs: readonly TraceReply[], t: number): DayState {
  if (legs.length === 0) return { kind: 'none' }
  const started = legs.findLastIndex((leg) => leg.t0Ms <= t)
  if (started < 0) return { kind: 'before', leg: legs[0], untilMs: legs[0].t0Ms }
  const leg = legs[started]
  if (!legFeeds(leg, t)) return { kind: 'quiet', leg, sinceMs: legEndMs(leg) }
  const n = pointsUpTo(leg, t)
  if (n === 0 || n === leg.t.length) return { kind: 'heard', leg } // no step around t: no point yet, or the minute after its last
  const a = { tMs: legMs(leg.t0Ms, leg.t[n - 1]), lat: leg.lat[n - 1], lon: leg.lon[n - 1] }
  const b = { tMs: legMs(leg.t0Ms, leg.t[n]), lat: leg.lat[n], lon: leg.lon[n] }
  return t > a.tMs && isGap(a, b) ? { kind: 'gap', leg, sinceMs: a.tMs, untilMs: b.tMs } : { kind: 'heard', leg }
}

/**
 * The callsign the aircraft was sending at t: the last of the leg's calls from at or before t; before the first one, the
 * first (the leg's start had no name yet); a leg with no calls (or from a server older than the field), its own callsign.
 */
export function callsignAt(leg: TraceReply, t: number): string | null {
  const calls = leg.calls ?? []
  if (calls.length === 0) return leg.callsign
  // The calls at or before t, by a binary search of their times: traceSamples asks for every point of a leg (thousands),
  // and a transponder that flaps between two names makes hundreds of calls.
  let lo = 0
  let hi = calls.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (legMs(leg.t0Ms, calls[mid][0]) <= t) lo = mid + 1
    else hi = mid
  }
  return calls[lo > 0 ? lo - 1 : 0][1]
}
