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
  gsKt: number | null                           // from the smoothed path
  trackDeg: number | null                       // from the smoothed path
  altBaroFt: number | null                      // the current sample's (at or before the render time)
  vsFpm: number | null                          // from the smoothed height (derived)
  mode: 'interp' | 'extrap' | 'stale'           // stale = extrapolated past 8 s → frozen
  altSource: AltSource
  onGround: boolean
  ageS: number                                  // tRender − newest sample tMs, seconds
  quality: Quality
  callsign: string | null
  typeCode: string | null
  altMslFt?: number | null                      // the smoothed height above mean sea level; null on the ground
  iasKt?: number | null                         // indicated airspeed while the aircraft reports it (averaged, ≤ 30 s old)
}

/**
 * What the flight-data frame around the chased aircraft shows (client/scene/flightFrame.ts), in a scenario or a live
 * chase. null: unknown, not shown. Fields in `derived` are estimates and are drawn dimmer.
 */
export interface FlightData {
  altFt: number | null // true altitude: above mean sea level
  aglFt: number | null // above the ground drawn under the aircraft
  vsFpm: number | null
  iasKt: number | null // indicated (calibrated) airspeed: what the pilots' airspeed indicator shows
  tasKt?: number | null // true airspeed: the speed through the air (IAS grows into it with height); optional so FlightData
  // literals written before it keep compiling| null // true airspeed: the speed through the air (IAS grows into it with height)
  gsKt: number | null // ground speed: over the ground, the true airspeed's horizontal part plus the wind
  hdgDeg: number | null // true heading of the nose
  trackDeg: number | null // true course over the ground
  pitchDeg: number | null // nose-up +
  rollDeg: number | null // right-wing-down +
  g: number | null // vertical load factor
  windFromDeg: number | null // true, where the wind blows from
  windKt: number | null
  gear: 'up' | 'down' | null
  flaps: number | null // units
  epr: readonly number[] | null // thrust, one per engine
  derived: ReadonlySet<keyof FlightData>
}

export interface ClientConfig {
  terrain: 'ion' | 'reearth' | 'ellipsoid'
  imagery: 'ion' | 'esri' | 'eox' | 'none'
  ionToken: string | null
  arcgisKey?: string | null // optional so ClientConfig literals written before it keep compiling
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
  paint?: Paint                                 // where the livery goes (client/scene/livery.ts); absent: unpainted
  types?: string[]                              // ICAO designators it draws; "B73*" matches a prefix (modelFor.ts)
  box?: { centre: [number, number, number]; half: number } // traffic bracket square: model frame, unscaled (traffic.ts)
  // landing gear drawn with the model (ChaseModel.setGear, Traffic); heightM: origin → wheel bottom, gear down. legs: the
  // GLB's leg nodes (tools/models/gear-glb.ts), each swung upDeg about axis (body frame: nose +X, left +Y, up +Z) to retract.
  gear?: { uri: string; heightM: number; legs?: Array<{ node: string; axis: [number, number, number]; upDeg: number }> }
  lights?: LightAnchors                         // exterior lights (aircraftLights.ts); absent: none drawn
  profile?: ModelProfile                        // side geometry the livery artwork is drawn on (tools/models/profile.ts)
}

/**
 * A model's side geometry, measured from its mesh by tools/models/profile.ts, in the paint frame (Paint: turned, +z
 * nose, +y up, +x left wing), mesh metres. The livery kit (client/livery/kit.ts) draws airline artwork onto it.
 */
export interface ModelProfile {
  box: [zMin: number, zMax: number, yMin: number, yMax: number] // the body atlas box: tail … nose, keel … fin tip, padded
  body: Array<[z: number, yBottom: number, yTop: number]>      // fuselage side outline nose → tail every 0.25 m (fairing in; fin, wings out)
  fin: Array<[z: number, y: number]>                            // the fin's side outline above the fuselage, closed, leading-edge root first
  finRoot: [y: number, le: number, te: number]                  // fin leading and trailing edge z where it meets the fuselage
  finTip: [y: number, le: number, te: number]                   // …and at its tip
  wing: [rootLe: number, rootTe: number, rootY: number, tipX: number, tipY: number] // root chord at the fuselage side; the tip
  engines: [xMin: number, xMax: number, zMin: number, zMax: number, yMin: number, yMax: number] | null // nacelles and pylons
  winglet: [xMin: number, xMax: number, zMin: number, zMax: number, yMin: number, yMax: number] | null // wingtip device above the wing
  stab: [zMin: number, zMax: number, halfSpan: number] | null   // horizontal tailplane
  doors: number[]                                               // z of the left passenger door centres, nose → tail (may be empty)
  cockpit: number                                               // z of the cockpit windows' aft edge
}

/**
 * Where a model's exterior lights sit, in the frame `box` uses (Cesium's model frame before forwardAxisFix; unscaled),
 * measured from the GLB by tools/models/light-anchors.ts. The wing-tip strobes share the nav lights' places, the tail
 * strobe the tail light's.
 */
export interface LightAnchors {
  navLeft: [number, number, number]             // red position light, left (port) wing tip
  navRight: [number, number, number]            // green, right (starboard) wing tip
  tail: [number, number, number]                // white, aft-facing, on the tail cone
  beacons: [number, number, number][]           // red anti-collision: the upper one first, then the belly's
  landing: [number, number, number][]           // forward-facing: the wing roots, then the nose gear
}

/**
 * Where a model's livery regions are, in its glTF mesh frame (x left, y up, z nose-forward; unscaled), measured
 * from its vertices. The fuselage (|x| < bodyHalfWidth) takes the base colour and, below bellyBelowY, the belly
 * colour; everything wider (wings, tailplane) is light grey on every airline.
 */
export interface Paint {
  noseMinusZ?: boolean                                        // the mesh faces −Z (+X right wing): turned 180° about y first
  bodyHalfWidth: number
  bellyBelowY: number
  fin: { behindZ: number; aboveY: number; halfWidth: number } // the vertical fin: z < behindZ, y > aboveY, |x| < halfWidth
  finSplit: [slope: number, zRef: number, below: number]      // fin2 where (y − fin.aboveY) + slope·(z − zRef) < below
  engines: [xMin: number, xMax: number, zMin: number, zMax: number] // nacelles: |x| and z in range, not flat wing skin
  finLogo: [z: number, y: number, side: number]               // centre and side of the square fin decal
  title: [z: number, y: number, width: number]                // centre and width of the 4:1 fuselage title
  windows?: [y: number, zAft: number, zFore: number, pitch: number] // the cabin window row (tools/models/light-anchors.ts)
  body?: [zNose: number, zTail: number, yBottom: number, yTop: number] // the box a scenario's body-wrap decal covers
  wingTipY?: number                                           // mesh y of the wing at the tip: ChaseModel.setShape folds the span to it
  cut?: {                                                     // the damage ChaseModel.setDamage shows (JAL 123: fin and tail cone lost)
    finKeepY: number                                          // the fin is gone above this height (a jagged line ±0.35 m)…
    rudderFrac: number                                        // …and in the aft fraction of its local chord below it
    tailConeZ: number                                         // the fuselage is gone aft of this…
    tailHalfWidth: number                                     // …within this half-width (the tailplane outside it stays)
    finEdges: [yRoot: number, leRoot: number, teRoot: number, yTip: number, leTip: number, teTip: number] // fin leading and trailing edge z at two heights
  }
}

export interface ModelManifest {
  default: string                               // id of the model used when no type match
  fallback?: Record<string, string>             // ADS-B category (A1…) or icon kind (light/jet/heavy/heli) → model id
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
  staleS: number                                // past this age it is hidden and forgotten; it is dead-reckoned up to it
  gapS: number                                  // its usual gap between samples, s (a running average; 0 before a second one)
  quality: Quality
  info: AircraftInfo | null
  // Chase traffic with its own Track (app.ts): the smoothed attitude, its position and speeds written over the entry's
  // dead reckoning for this frame. Absent or null: from the newest sample (traffic.ts trafficHpr).
  att?: { headingDeg: number; pitchDeg: number; rollDeg: number } | null
}

/** The user’s scene toggles (design D11) and map layers (the Layers button). Persisted: URL > localStorage > defaults. */
export interface ScenePrefs {
  topo: boolean                                 // 3-D terrain: exaggeration TOPO_ON, else flat (0) around relH
  light: boolean                                // sun lighting in chase (browse stays unlit)
  glass: boolean                                // 3-D buildings see-through (translucent) instead of solid
  mapTop: boolean                               // the top-down view shows the street map (else the satellite imagery)
  mapChase: boolean                             // the chase view shows the street map (else the satellite imagery)
  dark: boolean                                 // the street map in its dark theme (Esri Dark Gray Canvas), both views
  roads: boolean                                // roads and place names over the satellite imagery
  wx: boolean                                   // aviation weather on the top-down map: radar, METARs, SIGMETs
}

/**
 * Terrain exaggeration for one frame, returned by Topography.update() and passed to the app, the runways and the fleet
 * layer. Topography reuses one object: read it during the frame, never keep it.
 */
export interface TerrainFrame {
  fSampled: number                              // factor the tiles held when globe.getHeight ran this frame (last render’s)
  fNow: number                                  // factor drawn this frame (scene.verticalExaggeration)
  relHM: number                                 // scene.verticalExaggerationRelativeHeight drawn this frame, HAE metres
}
