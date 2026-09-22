import type { AircraftInfo } from '../shared/info.ts'
import type { Quality } from '../shared/types.ts'
import type { AltSource } from './track/types.ts'

/** What the scene draws for one aircraft at render time. Produced by Track.stateAt(). */
export interface RenderState {
  hex: string
  lat: number
  lon: number
  hM: number                                    // WGS84 ellipsoidal metres of the wheels (the chase model adds gearHeightM)
  headingDeg: number                            // true, nose direction
  pitchDeg: number                              // nose-up positive
  rollDeg: number                               // right-wing-down positive
  gsKt: number | null                           // copied from the newest sample
  trackDeg: number | null                       // copied from the newest sample
  altBaroFt: number | null                      // copied from the newest sample
  vsFpm: number | null                          // from the vertical filter (derived)
  mode: 'interp' | 'extrap' | 'stale'           // stale = extrapolated past 8 s → frozen
  altSource: AltSource
  onGround: boolean
  ageS: number                                  // tRender − newest sample tMs, seconds
  quality: Quality
  callsign: string | null
  typeCode: string | null
}

export interface ClientConfig {
  terrain: 'ion' | 'reearth' | 'ellipsoid'
  imagery: 'ion' | 'eox' | 'none'
  ionToken: string | null
  apiBase: string
}

/** public/models/manifest.json entry. Calibration makes the model's nose point along RenderState.headingDeg. */
export interface ModelManifestEntry {
  id: string
  uri: string                                   // relative to public/, e.g. "models/airliner.glb"
  license: string
  author: string
  source: string                                // where it was downloaded from
  forwardAxisFix: { headingDeg: number; pitchDeg: number; rollDeg: number }
  gearHeightM: number                           // model origin → wheel bottom, metres (after scale)
  lengthM: number                               // real-world length the scale targets
  scale: number
}

export interface ModelManifest {
  default: string                               // id of the model used when no type match
  models: ModelManifestEntry[]
}

/**
 * One aircraft in the browse view: newest sample, dead-reckoned to the render time (no Hermite, no filters), for
 * thousands of aircraft per frame. Objects are reused between frames by Fleet; never keep a reference across frames.
 */
export interface FleetEntry {
  hex: string
  lat: number
  lon: number
  hM: number                                    // HAE metres for 3-D placement (geom, else baro + N; ground: N)
  altFt: number | null                          // baro ft (geom when no baro) for colour and table; null = unknown
  onGround: boolean
  trackDeg: number | null
  gsKt: number | null
  vsFpm: number | null
  ageS: number                                  // render time − newest sample tMs, seconds
  quality: Quality
  info: AircraftInfo | null
}
