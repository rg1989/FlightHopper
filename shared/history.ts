// shared/history.ts
// The past in half hours. adsb.lol writes one heatmap file per UTC half hour (server/heatmap.ts reads it), just after
// that half hour ends. Shared so the server's cache and the client's time bar agree on the slots.

export const SLOT_MS = 30 * 60_000
/** How long after its half hour ends its file is surely there: written ~1 s after, the rest is margin. */
export const PUBLISH_DELAY_MS = 90_000

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

/** Seconds between the slices kept for a circle of radius nm: every 10 s slice near, fewer for a wide view (payload). */
export function stepFor(nm: number): number {
  if (nm <= 300) return 10
  if (nm <= 1000) return 30
  if (nm <= 2500) return 60
  return 300
}
