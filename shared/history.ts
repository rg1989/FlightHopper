// shared/history.ts
// The past in half hours. adsb.lol writes one heatmap file per UTC half hour (server/heatmap.ts reads it), just after
// that half hour ends. Shared so the server's cache and the client's time bar agree on the slots.

export const SLOT_MS = 30 * 60_000
/**
 * How long after its half hour ends its file is taken to be there: it appears 2-8 s after (median 2 s, p90 8 s, measured
 * 2026-10-02). The rare one later than this answers 404 at first, which the server takes for "late" and asks again 15 s on.
 */
export const PUBLISH_DELAY_MS = 20_000

/** The start of the half hour holding tMs (UTC ms). */
export function slotOf(tMs: number): number {
  return Math.floor(tMs / SLOT_MS) * SLOT_MS
}

/** The newest half hour whose file is published at nowMs: the one that ended at least PUBLISH_DELAY_MS ago. */
export function newestSlotMs(nowMs: number): number {
  return slotOf(nowMs - PUBLISH_DELAY_MS) - SLOT_MS
}

/** The whole-world radius, nm (a quarter of the way round the earth): a circle this wide holds every position. */
export const EVERYTHING_NM = 5400

/** [largest radius nm, seconds between the slices kept] for each band of view sizes, nearest first. */
export const STEP_BANDS: readonly (readonly [number, number])[] = [[300, 10], [1000, 30], [2500, 60], [EVERYTHING_NM, 300]]

/** Seconds between the slices kept for a circle of radius nm: every 10 s slice near, fewer for a wide view (payload). */
export function stepFor(nm: number): number {
  return (STEP_BANDS.find(([max]) => nm <= max) ?? STEP_BANDS[STEP_BANDS.length - 1])[1]
}
