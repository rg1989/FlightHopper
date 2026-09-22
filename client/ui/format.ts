// client/ui/format.ts
// Pure text for the HUD, the status banner and the attribution box. hud.ts / banner.ts only put it in the DOM.
import type { Degraded, StatusBrief } from '../../shared/api.ts'
import type { Quality } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'

/** observed = copied from the newest sample while interpolating; derived = computed or predicted; stale = too old to trust; unknown = no value. */
export type HudTag = 'observed' | 'derived' | 'stale' | 'unknown'

export interface HudField {
  label: string
  value: string
  tag: HudTag
}

/** Past this age a value is stale even if the track has not switched to mode 'stale' yet. */
export const STALE_AGE_S = 10

export const NOT_FOR_NAVIGATION = 'Entertainment only. Not for navigation.'

const QUALITY_LABEL: Record<Quality, string> = { adsb2: 'ADS-B v2', adsb01: 'ADS-B v0-1', mlat: 'MLAT', other: 'other' }

const DEGRADED_TEXT: Record<Exclude<Degraded, null>, string> = {
  blocked: 'Live data blocked by provider — showing nothing new',
  'rate-limited': 'Provider rate-limited us — updates slowed',
  'upstream-down': 'Live data unavailable',
}

const finite = (v: number | null): v is number => v !== null && Number.isFinite(v)
const int = (v: number): string => (Math.round(v) || 0).toLocaleString('en-US') // `|| 0` turns -0 into 0
const deg3 = (d: number): string => `${String((((Math.round(d) % 360) + 360) % 360)).padStart(3, '0')}°`

function vs(fpm: number): string {
  const v = Math.round(fpm / 10) * 10
  return `${v > 0 ? '+' : ''}${int(v)} fpm`
}

export function isStale(s: RenderState): boolean {
  return s.mode === 'stale' || s.ageS > STALE_AGE_S
}

/**
 * HUD rows for the selected aircraft, always GS ALT VS TRK HDG AGE SRC (none when nothing is selected).
 * Assumes Track copies gsKt, trackDeg and altBaroFt from its newest sample; vsFpm (filter), headingDeg
 * (true heading or track, smoothed) and ageS (render clock) are computed, so they are never 'observed'.
 */
export function hudFields(s: RenderState | null, status: StatusBrief): HudField[] {
  if (s === null) return []
  const stale = isStale(s)
  const row = (label: string, value: string | null, computed: boolean): HudField => ({
    label,
    value: value ?? '—',
    tag: value === null ? 'unknown' : stale ? 'stale' : computed || s.mode === 'extrap' ? 'derived' : 'observed',
  })
  // ALT is pressure altitude (what ATC and the pilot see). "alt est." = the drawn height is not GNSS but estimated from baro.
  const alt = s.onGround
    ? 'GND'
    : finite(s.altBaroFt)
      ? `${int(s.altBaroFt)} ft baro${s.altSource === 'geom' ? '' : ' · alt est.'}`
      : null
  return [
    row('GS', finite(s.gsKt) ? `${int(s.gsKt)} kt` : null, false),
    row('ALT', alt, false),
    row('VS', finite(s.vsFpm) ? vs(s.vsFpm) : null, true),
    row('TRK', finite(s.trackDeg) ? deg3(s.trackDeg) : null, false),
    row('HDG', finite(s.headingDeg) ? deg3(s.headingDeg) : null, true),
    // ageS < 0 while interpolating (render time is behind the newest sample): the drawn state is bracketed by real data.
    row('AGE', finite(s.ageS) ? `${Math.max(0, s.ageS).toFixed(1)} s` : null, true),
    row('SRC', `${QUALITY_LABEL[s.quality]}${status.source === 'replay' ? ' (replay)' : ''}`, false),
  ]
}

/** "UAL123 · B738 · a1b2c3", skipping the parts we do not know. */
export function hudTitle(s: RenderState): string {
  return [s.callsign, s.typeCode, s.hex].filter((x) => x).join(' · ')
}

/** One line for the top banner, or null when there is nothing to warn about. Provider problems win over the aircraft's state. */
export function bannerText(status: StatusBrief, s: RenderState | null): string | null {
  if (status.degraded !== null) return DEGRADED_TEXT[status.degraded]
  if (s === null) return null
  if (isStale(s)) return Number.isFinite(s.ageS) ? `Signal lost ${Math.round(Math.max(0, s.ageS))}s ago` : 'Signal lost'
  if (s.mode === 'extrap') return 'Predicting (no fresh data)'
  return null
}

/** The given credit lines plus the safety line, unless one of them already says "not for navigation". */
export function attributionLines(lines: string[]): string[] {
  return lines.some((l) => /not for navigation/i.test(l)) ? [...lines] : [...lines, NOT_FOR_NAVIGATION]
}
