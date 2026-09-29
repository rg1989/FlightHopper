// client/ui/framePrefs.ts
/**
 * The flight-data frame's cards as the viewer arranged them (its edit mode, scene/flightFrame.ts): the cards moved, each
 * by its anchor's offset from the aircraft's middle in sides of the square the cards go round (layoutSide), so a moved
 * card keeps its place in proportion at any zoom; and the cards hidden. Kept in localStorage['fh.hudLayout.v1'], for
 * every aircraft and scenario. Pure: the app passes the stored string and the storage, so Node tests need no DOM.
 */
import type { BlockId } from '../scene/flightFrame.ts'

export const FRAME_PREFS_KEY = 'fh.hudLayout.v1'

/** Where a moved card's anchor is: its offset from the aircraft's middle, x right and y down, in layout sides. */
export interface Offset { x: number; y: number }
export interface FramePrefs { moved: Partial<Record<BlockId, Offset>>; hidden: readonly BlockId[] }

export const NO_FRAME_PREFS: FramePrefs = Object.freeze({ moved: Object.freeze({}), hidden: Object.freeze([]) })

const CARDS: readonly BlockId[] = ['left', 'right', 'top', 'bottom']
const REACH = 10 // sides: farther than any screen reaches, so a larger offset is a corrupt one

const offset = (v: unknown): Offset | null => {
  const { x, y } = (v ?? {}) as Record<string, unknown>
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= REACH
  return ok(x) && ok(y) ? { x, y } : null
}

/** The stored layout; corrupt or foreign values fall back card by card (to its place, shown). Never throws. */
export function readFramePrefs(stored: string | null): FramePrefs {
  let saved: { moved?: unknown; hidden?: unknown } | null = null
  try {
    saved = stored === null ? null : JSON.parse(stored)
  } catch {
    // corrupt: the defaults stand
  }
  const moved: Partial<Record<BlockId, Offset>> = {}
  const m = saved?.moved
  if (m !== null && typeof m === 'object' && !Array.isArray(m)) {
    for (const id of CARDS) {
      const o = offset((m as Record<string, unknown>)[id])
      if (o !== null) moved[id] = o
    }
  }
  const h = Array.isArray(saved?.hidden) ? (saved.hidden as unknown[]) : []
  return { moved, hidden: CARDS.filter((id) => h.includes(id)) }
}

/** Stores the layout as JSON. Storage errors (private mode, quota, blocked) are swallowed: the layout still applies. */
export function writeFramePrefs(prefs: FramePrefs, storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(FRAME_PREFS_KEY, JSON.stringify({ moved: prefs.moved, hidden: prefs.hidden }))
  } catch {
    // not kept; the page keeps the layout in memory
  }
}
