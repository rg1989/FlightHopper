// client/ui/framePrefs.ts
/**
 * The flight-data frame's cards as the viewer arranged them (its edit mode, scene/flightFrame.ts): the cards moved, each
 * by its anchor's offset from the aircraft's middle in sides of the square the cards go round (layoutSide), so a moved
 * card keeps its place in proportion at any zoom; the cards hidden; their stacking, the last moved on top (a card
 * dropped over another stays in sight, and in reach); each card's size (a scale, pulled at its bottom corners); and the
 * units the figures are in (units.ts). Kept in localStorage['fh.hudLayout.v1'], for
 * every aircraft and scenario. Pure: the app passes the stored string and the storage, so Node tests need no DOM.
 */
import type { BlockId } from '../scene/flightFrame.ts'
import { DEFAULT_UNITS, readUnits, type Units } from './units.ts'

export const FRAME_PREFS_KEY = 'fh.hudLayout.v1'

/**
 * Where a moved card's anchor is: its offset from the aircraft's middle, x right and y down, in layout sides; v: the
 * variant it keeps (its index: the full card, then smaller ones), the one it had when it was moved.
 */
export interface Offset { x: number; y: number; v?: number }
export interface FramePrefs {
  moved: Partial<Record<BlockId, Offset>>
  hidden: readonly BlockId[]
  order: readonly BlockId[]
  scale: Partial<Record<BlockId, number>> // a card's size over its own (1: as designed); absent: 1
  units: Units
}

export const NO_FRAME_PREFS: FramePrefs = Object.freeze({
  moved: Object.freeze({}), hidden: Object.freeze([]), order: Object.freeze([]), scale: Object.freeze({}), units: DEFAULT_UNITS,
})
export const MIN_SCALE = 0.6
export const MAX_SCALE = 1.8
/** A card's scale kept to MIN_SCALE…MAX_SCALE. */
export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

const CARDS: readonly BlockId[] = ['left', 'right', 'top', 'bottom']
const REACH = 10 // sides: farther than any screen reaches, so a larger offset is a corrupt one

const VARIANTS = 4 // more than any card has: a larger index is a corrupt one

const offset = (o: unknown): Offset | null => {
  const { x, y, v } = (o ?? {}) as Record<string, unknown>
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= REACH
  if (!ok(x) || !ok(y)) return null
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < VARIANTS ? { x, y, v: v as number } : { x, y }
}

/** The stored layout; corrupt or foreign values fall back card by card (to its place, shown). Never throws. */
export function readFramePrefs(stored: string | null): FramePrefs {
  let saved: { moved?: unknown; hidden?: unknown; order?: unknown; scale?: unknown; units?: unknown } | null = null
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
  const o = Array.isArray(saved?.order) ? (saved.order as unknown[]) : []
  const order = o.filter((id, i): id is BlockId => CARDS.includes(id as BlockId) && o.indexOf(id) === i)
  const scale: Partial<Record<BlockId, number>> = {}
  const sc = saved?.scale
  if (sc !== null && typeof sc === 'object' && !Array.isArray(sc)) {
    for (const id of CARDS) {
      const v = (sc as Record<string, unknown>)[id]
      if (typeof v === 'number' && Number.isFinite(v) && v !== 1) scale[id] = clampScale(v)
    }
  }
  return { moved, hidden: CARDS.filter((id) => h.includes(id)), order, scale, units: readUnits(saved?.units) }
}

/** Stores the layout as JSON. Storage errors (private mode, quota, blocked) are swallowed: the layout still applies. */
export function writeFramePrefs(prefs: FramePrefs, storage: Pick<Storage, 'setItem'> | null): void {
  try {
    const { moved, hidden, order, scale, units } = prefs
    storage?.setItem(FRAME_PREFS_KEY, JSON.stringify({ moved, hidden, order, scale, units }))
  } catch {
    // not kept; the page keeps the layout in memory
  }
}
