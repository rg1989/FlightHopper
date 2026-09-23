// client/scene/fleetLayer.ts
import {
  BillboardCollection,
  BlendOption,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Ellipsoid,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  VerticalOrigin,
} from 'cesium'
import type { Billboard, Label, PerspectiveFrustum, Scene, Viewer } from 'cesium'
import type { FleetEntry, TerrainFrame } from '../types.ts'
import { ALTITUDE_RGBA, COLOR_COUNT, altitudeIndex } from './altitudeColor.ts'
import { drawnHeightM, trueHeightM } from './exaggeration.ts'
import { HALO_ID, HALO_PX, ICON_ID, ICON_PX, haloCanvas, iconCanvas, iconFor } from './icons.ts'
import type { IconKind } from './icons.ts'

const RAD = Math.PI / 180
export const SELECTED_SCALE = 1.4
export const GROUND_LIFT_M = 2 // above the drawn terrain, so a ground icon never z-fights the surface
const AXIS_STEP_DEG = 0.05 // re-aim a billboard's north axis after moving this far (0.05° of arc is invisible)
const MIN_MOVE_PX = 0.25 // a position change smaller than this on screen is not written (see #draw)
const M_PER_DEG = 111_320
const GROUND_STEP_DEG = 0.002 // re-sample the terrain under a ground aircraft after ~200 m
const GROUND_REFRESH_FRAMES = 600 // … and every ~10 s anyway, as finer terrain tiles load
const GROUND_RETRY_FRAMES = 30 // tile not loaded yet, or the terrain flat: try again in ~0.5 s (staggered per aircraft)

/** One shared Color per colour-table entry: frames allocate none. */
const COLORS: readonly Color[] = Array.from(
  { length: COLOR_COUNT },
  (_, i) => new Color(ALTITUDE_RGBA[i * 4], ALTITUDE_RGBA[i * 4 + 1], ALTITUDE_RGBA[i * 4 + 2], ALTITUDE_RGBA[i * 4 + 3]),
)
const HALO_COLOR = Color.fromCssColorString('#ffd23f')
const LABEL_BG = Color.fromCssColorString('#16181d')
/** Icons shrink to half size between 300 km and 8,000 km from the camera (continental views stay readable). */
const SIZE_BY_DISTANCE = new NearFarScalar(3e5, 1, 8e6, 0.5)
const LABEL_OFFSET = new Cartesian2(0, -(ICON_PX / 2 + 2))
const LABEL_OFFSET_SELECTED = new Cartesian2(0, -(HALO_PX / 2 + 2)) // above the selection ring

/** Local east-north-up "north" unit vector at a geodetic lat/lon, written into `out`. */
export function northAt(latDeg: number, lonDeg: number, out: Cartesian3): Cartesian3 {
  const lat = latDeg * RAD
  const lon = lonDeg * RAD
  const s = Math.sin(lat)
  out.x = -s * Math.cos(lon)
  out.y = -s * Math.sin(lon)
  out.z = Math.cos(lat)
  return out
}

/** Per-hex state: what was last written to the billboard, so unchanged properties are never touched. */
interface Slot {
  b: Billboard
  frame: number
  n: number // creation order, staggers terrain re-samples
  show: boolean
  lat: number // last written position (degrees, metres, and the Cartesian)
  lon: number
  h: number
  x: number
  y: number
  z: number
  cosLat: number
  axisLat: number
  axisLon: number
  rot: number
  color: number
  cat: string | null | undefined
  type: string | null | undefined
  kind: IconKind | null
  sel: boolean | null
  groundH: number // TRUE terrain height (HAE m) under the aircraft; NaN = none yet
  groundLat: number
  groundLon: number
  groundAt: number
}

/**
 * Every aircraft of the browse view as a small silhouette, rotated to its track and tinted by altitude, in ONE
 * BillboardCollection (one draw call; one texture per silhouette kind). Billboards are keyed by hex and kept across
 * frames; each frame only writes the properties that changed. Aircraft that leave are hidden and their billboards
 * pooled for the next new hex (adding or removing a billboard makes Cesium rebuild the whole vertex array).
 * One reused Label shows the hovered (else selected) callsign; one reused ring marks the selected aircraft.
 */
export class FleetLayer {
  #scene: Scene
  #bbs: BillboardCollection
  #labels: LabelCollection
  #halo: Billboard
  #label: Label
  #byHex = new Map<string, Slot>()
  #free: Billboard[] = []
  #frame = 0
  #made = 0
  #labelHex: string | null = null
  #labelCallsign: string | null = null
  #pos = new Cartesian3()
  #axis = new Cartesian3()
  #cam = new Cartesian3()
  #moveK2 = 0 // (MIN_MOVE_PX × radians per pixel)²; 0 = write every change
  #carto = new Cartographic()
  #fSampled = 1 // terrain exaggeration of this frame (setTerrain); until the first call, the terrain as loaded
  #fNow = 1
  #relHM = 0

  constructor(viewer: Viewer) {
    this.#scene = viewer.scene
    // TRANSLUCENT: one pass instead of opaque + translucent (icons have soft edges; they still depth-test against the globe).
    this.#bbs = this.#scene.primitives.add(new BillboardCollection({ blendOption: BlendOption.TRANSLUCENT }))
    this.#halo = this.#bbs.add({ position: Cartesian3.ZERO, show: false, color: HALO_COLOR, scaleByDistance: SIZE_BY_DISTANCE })
    this.#halo.setImage(HALO_ID, haloCanvas())
    this.#labels = this.#scene.primitives.add(new LabelCollection())
    this.#label = this.#labels.add({
      position: Cartesian3.ZERO,
      show: false,
      font: '600 13px system-ui, sans-serif',
      fillColor: Color.WHITE,
      style: LabelStyle.FILL,
      showBackground: true,
      backgroundColor: LABEL_BG, // opaque: drawn in the opaque pass, so no icon paints over it
      backgroundPadding: new Cartesian2(6, 3),
      verticalOrigin: VerticalOrigin.BOTTOM,
      horizontalOrigin: HorizontalOrigin.CENTER,
      pixelOffset: LABEL_OFFSET,
      pixelOffsetScaleByDistance: SIZE_BY_DISTANCE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    })
  }

  /**
   * This frame's terrain exaggeration (design D7): call it before update(). Ground icons keep the TRUE terrain height and
   * are drawn where the terrain is drawn this frame. The numbers are copied (Topography reuses the object); a frame with
   * a non-finite one is ignored (it would reach the billboard positions).
   */
  setTerrain(frame: TerrainFrame): void {
    if (!(Number.isFinite(frame.fSampled) && Number.isFinite(frame.fNow) && Number.isFinite(frame.relHM))) return
    this.#fSampled = frame.fSampled
    this.#fNow = frame.fNow
    this.#relHM = frame.relHM
  }

  /**
   * modelShown: the chased aircraft is drawn as the 3-D model, so its icon, ring and label go (the icon sits at the
   * fleet's dead-reckoned position, which can run ahead of the model and read as a second aircraft). Otherwise the
   * selected icon shows at any distance: focus is on the top-down map, zoomed in as close as it goes.
   */
  update(entries: readonly FleetEntry[], selectedHex: string | null, hoverHex: string | null, modelShown = false): void {
    const frame = ++this.#frame
    this.#frameMoveThreshold()
    let touched = 0
    let sel: Slot | null = null
    let selE: FleetEntry | null = null
    let hover: Slot | null = null
    let hoverE: FleetEntry | null = null
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const s = this.#byHex.get(e.hex) ?? this.#add(e.hex)
      if (s.frame !== frame) touched++
      s.frame = frame
      // The Fleet's own age limit per aircraft (it prunes them later); the chased one gives way to its 3-D model.
      const visible = e.ageS <= e.staleS && !(modelShown && e.hex === selectedHex)
      if (visible !== s.show) {
        s.b.show = visible
        s.show = visible
      }
      if (!visible) continue
      this.#draw(s, e)
      const isSel = e.hex === selectedHex
      if (isSel !== s.sel) {
        s.b.scale = isSel ? SELECTED_SCALE : 1
        s.sel = isSel
      }
      if (isSel) {
        sel = s
        selE = e
      }
      if (e.hex === hoverHex) {
        hover = s
        hoverE = e
      }
    }
    if (touched < this.#byHex.size) this.#sweep(frame)

    const halo = this.#halo
    if (sel && selE) {
      halo.position = sel.b.position
      halo.id = selE.hex
      if (!halo.show) halo.show = true
    } else if (halo.show) halo.show = false
    this.#updateLabel(hover ?? sel, hoverE ?? selE, sel !== null && (hover ?? sel) === sel)
  }

  /** The aircraft under windowPos; sizePx widens the search (Cesium spirals out from the centre: the nearest wins). */
  pick(windowPos: Cartesian2, sizePx = 3): string | null {
    const id: unknown = this.#scene.pick(windowPos, sizePx, sizePx)?.id
    return typeof id === 'string' && this.#byHex.has(id) ? id : null
  }

  destroy(): void {
    this.#scene.primitives.remove(this.#bbs)
    this.#scene.primitives.remove(this.#labels)
    this.#byHex.clear()
    this.#free.length = 0
  }

  #add(hex: string): Slot {
    const b = this.#free.pop() ?? this.#bbs.add({ position: Cartesian3.ZERO, scaleByDistance: SIZE_BY_DISTANCE })
    b.id = hex
    const s: Slot = {
      b, frame: 0, n: this.#made++, show: b.show, lat: NaN, lon: NaN, h: NaN, x: 0, y: 0, z: 0, cosLat: NaN, axisLat: NaN, axisLon: NaN, rot: NaN, color: -1,
      cat: undefined, type: undefined, kind: null, sel: null, groundH: NaN, groundLat: NaN, groundLon: NaN, groundAt: 0,
    }
    this.#byHex.set(hex, s)
    return s
  }

  /** Hides the billboards of hexes missing from this frame and pools them for reuse. */
  #sweep(frame: number): void {
    for (const [hex, s] of this.#byHex) {
      if (s.frame === frame) continue
      s.b.show = false
      s.b.id = undefined
      this.#free.push(s.b)
      this.#byHex.delete(hex)
    }
  }

  /**
   * Movement below MIN_MOVE_PX on screen is not written: every position write makes Cesium re-encode that billboard,
   * and above 10 % dirty it rewrites the whole buffer. Screen size of a move ≈ metres / distance ÷ (radians per pixel).
   * Without a perspective camera (e.g. in Node tests) every change is written.
   */
  #frameMoveThreshold(): void {
    const cam = this.#scene.camera
    const fovy = (cam?.frustum as PerspectiveFrustum | undefined)?.fovy
    const hPx = this.#scene.drawingBufferHeight
    if (!cam || !(typeof fovy === 'number' && fovy > 0) || !(hPx > 0)) {
      this.#moveK2 = 0
      return
    }
    Cartesian3.clone(cam.positionWC, this.#cam)
    const k = (MIN_MOVE_PX * fovy) / hPx
    this.#moveK2 = k * k
  }

  #draw(s: Slot, e: FleetEntry): void {
    const b = s.b
    const h = e.onGround ? this.#groundHeight(s, e) : this.#airHeight(e.hM)
    if (e.lat !== s.lat || e.lon !== s.lon || h !== s.h) {
      const dN = (e.lat - s.lat) * M_PER_DEG
      const dE = (e.lon - s.lon) * M_PER_DEG * s.cosLat
      const dH = h - s.h
      const dx = s.x - this.#cam.x
      const dy = s.y - this.#cam.y
      const dz = s.z - this.#cam.z
      // NaN (first write) fails the test and writes
      if (!(dN * dN + dE * dE + dH * dH <= this.#moveK2 * (dx * dx + dy * dy + dz * dz))) {
        const p = Cartesian3.fromDegrees(e.lon, e.lat, h, Ellipsoid.WGS84, this.#pos)
        b.position = p
        s.lat = e.lat
        s.lon = e.lon
        s.h = h
        s.x = p.x
        s.y = p.y
        s.z = p.z
        if (!(Math.abs(e.lat - s.axisLat) <= AXIS_STEP_DEG && Math.abs(e.lon - s.axisLon) <= AXIS_STEP_DEG)) {
          // rotation is measured from this axis: with north as the axis, rotation = −track points the nose along the track
          b.alignedAxis = northAt(e.lat, e.lon, this.#axis)
          s.axisLat = e.lat
          s.axisLon = e.lon
          s.cosLat = Math.cos(e.lat * RAD)
        }
      }
    }
    if (e.trackDeg !== null) {
      const rot = -e.trackDeg * RAD
      if (rot !== s.rot) {
        b.rotation = rot
        s.rot = rot
      }
    } else if (Number.isNaN(s.rot)) {
      b.rotation = 0
      s.rot = 0
    }
    const c = altitudeIndex(e.altFt, e.onGround)
    if (c !== s.color) {
      b.color = COLORS[c]
      s.color = c
    }
    const cat = e.info === null ? null : e.info.category
    const type = e.info === null ? null : e.info.typeCode
    if (cat !== s.cat || type !== s.type) {
      s.cat = cat
      s.type = type
      const kind = iconFor(cat, type)
      if (kind !== s.kind) {
        b.setImage(ICON_ID[kind], iconCanvas(kind)) // stable id → one atlas entry per kind
        s.kind = kind
      }
    }
  }

  /**
   * FleetEntry.hM on the ground is the geoid (≈ sea level), which can be under the terrain; the loaded terrain height is
   * sampled instead, cached per aircraft. globe.getHeight returns the exaggerated surface of the last render, so the
   * cache holds it un-exaggerated with that factor (fSampled): the TRUE height. It is drawn at this frame's factor
   * every frame, which is arithmetic: a grow or sink animation costs no extra sample. A reading that holds no height
   * keeps the cache, and the terrain is re-sampled ~0.5 s later: undefined (a tile not loaded yet, or Cesium's picker
   * race, during every grow or sink and until Topography's nudge) or taken below factor 0.5 (flat, or too flat to
   * invert: trueHeightM is null). Only an aircraft never sampled falls back to hM.
   * ponytail: coarse tiles can sit a little off the true surface until the ~10 s refresh; upgrade: re-sample on the
   * globe's tileLoadProgressEvent reaching 0. While flat, every ground aircraft re-samples every ~0.5 s (as for a tile
   * not loaded yet): N ground icons cost N / 30 globe.getHeight calls per frame; upgrade: skip the sample while
   * trueHeightM would return null.
   */
  #groundHeight(s: Slot, e: FleetEntry): number {
    const globe = this.#scene.globe
    if (!globe) return e.hM
    const moved = !(Math.abs(e.lat - s.groundLat) <= GROUND_STEP_DEG && Math.abs(e.lon - s.groundLon) <= GROUND_STEP_DEG)
    if (moved || this.#frame >= s.groundAt) {
      const h = globe.getHeight(Cartographic.fromDegrees(e.lon, e.lat, 0, this.#carto))
      const t = h === undefined ? null : trueHeightM(h, this.#fSampled, this.#relHM) // null: no height, keep the cache
      if (t !== null) s.groundH = t
      s.groundLat = e.lat
      s.groundLon = e.lon
      s.groundAt = this.#frame + (t === null ? GROUND_RETRY_FRAMES : GROUND_REFRESH_FRAMES) + (s.n % GROUND_RETRY_FRAMES)
    }
    if (!Number.isNaN(s.groundH)) return drawnHeightM(s.groundH, this.#fNow, this.#relHM) + GROUND_LIFT_M
    // No terrain height yet: hM at factor 1, as always. As the ground flattens onto relH, so does the icon, and it
    // takes the lift there, since that plane IS the drawn terrain.
    return drawnHeightM(e.hM, this.#fNow, this.#relHM) + GROUND_LIFT_M * (1 - this.#fNow)
  }

  /**
   * An airborne aircraft keeps its true HAE (D4), except under a flattened relief: below relH while f < 1 it would be
   * drawn under the drawn terrain and hidden (billboards depth-test against the globe, and the flat plane is global, D9:
   * in browse and far from the airport relH was picked at too). There it is drawn where its own height is drawn, like a
   * ground icon with no sample: on the plane, + the lift, when flat. It stays above the drawn ground under it, which is
   * no higher than the drawn hM (below relH) or than max(ground, relH) ≤ hM (above it).
   */
  #airHeight(hM: number): number {
    const f = this.#fNow
    return hM < this.#relHM && f < 1 ? drawnHeightM(hM, f, this.#relHM) + GROUND_LIFT_M * (1 - f) : hM
  }

  #updateLabel(s: Slot | null, e: FleetEntry | null, selected: boolean): void {
    const l = this.#label
    if (!s || !e) {
      if (l.show) l.show = false
      return
    }
    const callsign = e.info === null ? null : e.info.callsign
    if (e.hex !== this.#labelHex || callsign !== this.#labelCallsign) {
      l.text = callsign ?? e.hex.toUpperCase()
      l.id = e.hex
      this.#labelHex = e.hex
      this.#labelCallsign = callsign
    }
    l.position = s.b.position
    l.pixelOffset = selected ? LABEL_OFFSET_SELECTED : LABEL_OFFSET
    if (!l.show) l.show = true
  }
}
