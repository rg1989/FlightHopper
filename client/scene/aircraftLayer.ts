// client/scene/aircraftLayer.ts
import { Cartesian2, Cartesian3, Cartographic, Color, Ellipsoid, LabelCollection, LabelStyle, PointPrimitiveCollection, VerticalOrigin } from 'cesium'
import type { Label, PointPrimitive, Scene, Viewer } from 'cesium'
import type { Quality } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'

const RGB: Record<Quality, string> = {
  adsb2: '56, 189, 248', //   sky blue: ADS-B v2, best position and geometric (HAE) altitude
  adsb01: '132, 204, 22', //  green: ADS-B v0/v1
  mlat: '245, 158, 11', //    amber: MLAT, noisier and further behind
  other: '161, 161, 170', //  grey: TIS-B, ADS-R, unknown
}

/** CSS fill colour of one aircraft: hue by position quality; a stale (frozen) track is dimmed, less so when selected. */
export function colorFor(quality: Quality, selected: boolean, mode: RenderState['mode']): string {
  const alpha = mode !== 'stale' ? 1 : selected ? 0.6 : 0.35
  return `rgba(${RGB[quality]}, ${alpha})`
}

const PIXEL_SIZE = 8
const PIXEL_SIZE_SELECTED = 14
const OUTLINE_SELECTED_PX = 2
const LABEL_FONT = '13px sans-serif'
const LABEL_OFFSET = new Cartesian2(0, -9)

interface Entry {
  point: PointPrimitive
  label: Label
  seen: number
}

/**
 * Every visible aircraft as one screen-space dot plus a callsign label, keyed by hex.
 * Primitives are created once per hex and moved in place each frame; hexes missing from an update are removed.
 */
export class AircraftLayer {
  #scene: Scene
  #points: PointPrimitiveCollection
  #labels: LabelCollection
  #byHex = new Map<string, Entry>()
  #colors = new Map<string, Color>()
  #frame = 0
  #pos = new Cartesian3()
  #carto = new Cartographic()

  constructor(viewer: Viewer) {
    this.#scene = viewer.scene
    this.#points = this.#scene.primitives.add(new PointPrimitiveCollection())
    this.#labels = this.#scene.primitives.add(new LabelCollection())
  }

  update(states: RenderState[], selectedHex: string | null): void {
    const frame = ++this.#frame
    for (const s of states) {
      const pos = this.#position(s)
      let e = this.#byHex.get(s.hex)
      if (!e) {
        e = {
          point: this.#points.add({ id: s.hex, position: pos, pixelSize: PIXEL_SIZE, outlineColor: Color.WHITE }),
          label: this.#labels.add({
            id: s.hex,
            position: pos,
            font: LABEL_FONT,
            style: LabelStyle.FILL_AND_OUTLINE,
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: LABEL_OFFSET,
          }),
          seen: frame,
        }
        this.#byHex.set(s.hex, e)
      }
      e.seen = frame
      const selected = s.hex === selectedHex
      const color = this.#color(colorFor(s.quality, selected, s.mode))
      e.point.position = pos // setters copy the value and skip unchanged ones
      e.point.color = color
      e.point.pixelSize = selected ? PIXEL_SIZE_SELECTED : PIXEL_SIZE
      e.point.outlineWidth = selected ? OUTLINE_SELECTED_PX : 0
      e.label.position = pos
      e.label.fillColor = color
      e.label.text = s.callsign ?? s.hex
    }
    for (const [hex, e] of this.#byHex) {
      if (e.seen === frame) continue
      this.#points.remove(e.point)
      this.#labels.remove(e.label)
      this.#byHex.delete(hex)
    }
  }

  pick(windowPos: Cartesian2): string | null {
    const id: unknown = this.#scene.pick(windowPos)?.id
    return typeof id === 'string' && this.#byHex.has(id) ? id : null
  }

  destroy(): void {
    this.#scene.primitives.remove(this.#points)
    this.#scene.primitives.remove(this.#labels)
    this.#byHex.clear()
  }

  /** Airborne: at hM. On the ground: on the loaded terrain under the aircraft, hM until that tile loads. */
  #position(s: RenderState): Cartesian3 {
    let h = s.hM
    if (s.onGround) {
      // ponytail: PointPrimitive has no heightReference (Cesium 1.145), so ground dots sample the globe every update.
      // Ceiling: one quadtree lookup per ground aircraft per frame; upgrade: cache per hex until it moves > 10 m.
      const c = Cartographic.fromDegrees(s.lon, s.lat, 0, this.#carto)
      h = this.#scene.globe.getHeight(c) ?? s.hM
    }
    return Cartesian3.fromDegrees(s.lon, s.lat, h, Ellipsoid.WGS84, this.#pos)
  }

  /** One shared Color per CSS string: a dozen at most, so frames allocate none. */
  #color(css: string): Color {
    let c = this.#colors.get(css)
    if (!c) this.#colors.set(css, (c = Color.fromCssColorString(css)))
    return c
  }
}
