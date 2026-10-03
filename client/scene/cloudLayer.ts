// client/scene/cloudLayer.ts
// The chase's clouds drawn: every CloudSpec (cloudField.ts) as a Cesium cumulus cloud in one CloudCollection. It is the one
// place clouds are drawn: Weather3D hands it the specs of every source at once. A spec's heights are above sea level, so a
// cloud stands that high plus the geoid there (EGM96) above the ellipsoid; as the relief is flattened or grown
// (exaggeration.ts) it moves with its station's ground, keeping its height above the ground drawn. Its brightness follows
// the Sun's night (cloudField.ts sunBrightness). frame() runs every frame while the weather shows and writes only on a change;
// fade() at each look fades each cloud by its distance from the aircraft (cloudField.ts fadeAlpha), hiding those faded out.
// Cesium's clouds are billboards that face the camera, each a puff ray-cast through a noise texture: they read best from the
// side, as from a cockpit or the chase camera; straight from above or below, a deck shows as strips.
// A cloud is drawn whole at its middle's depth, so one the camera flies through fills the view until its middle passes behind
// the camera, then goes at once. A spec with clearKm (the model's puffs, 12 to 27 km wide at the aircraft's own height) is hidden
// at each look while the aircraft is at a height its puff spans (and a margin: the camera is a little off the aircraft) and within
// clearKm of it, and fades back in over as far again.
// ponytail: a cloud without clearKm (a report's, the radar's) is not: one the camera flies through fills the view as above.
// Upgrade: clearKm for every cloud, by its size.
import { Cartesian2, Cartesian3, CloudCollection, Color, Ellipsoid, type CumulusCloud, type PrimitiveCollection } from 'cesium'
import { geoidN } from '../../shared/geoid.ts'
import type { TerrainFrame } from '../types.ts'
import { PUFF_FILL, fadeAlpha, sunBrightness, type CloudSpec } from './cloudField.ts'
import { drawnHeightM, smoothstep } from './exaggeration.ts'

export const NOISE_DETAIL = 16 // Cesium's default: the detail of its cloud noise texture (a power of two, 8–32)
const TINT_GREY = [0.55, 0.52, 0.48] // red, green and blue taken away at tint 1: a dark grey, a little blue
const NIGHT_STEP = 0.02 // the brightness is written again when the night has changed by this
const FADE_STEP = 0.05 // a cloud's fade is written again when it has changed by this
const CLEAR_MARGIN_M = 300 // a puff with clearKm also hides for an aircraft this far over or under the height it spans: the camera is that far off it
const STRIDE = 7 // per cloud in #at: its place at its true height (x, y, z), the ellipsoid's up there (x, y, z), its ground above the ellipsoid

const scratch = new Cartesian3()

/** A cloud's colour for its tint (0 white … 1 dark grey) and its fade (alpha): Cesium multiplies the puff's own shading by it. */
export function tintColor(tint: number, alpha = 1): Color {
  const t = Number.isFinite(tint) ? Math.min(1, Math.max(0, tint)) : 0
  return new Color(1 - TINT_GREY[0] * t, 1 - TINT_GREY[1] * t, 1 - TINT_GREY[2] * t, alpha)
}

export class CloudLayer {
  readonly #primitives: PrimitiveCollection
  readonly #coll = new CloudCollection({ show: false, noiseDetail: NOISE_DETAIL })
  readonly #geoid: (lat: number, lon: number) => number
  #clouds: CumulusCloud[] = []
  #specs: readonly CloudSpec[] = []
  #at = new Float64Array(0)
  #alpha = new Float64Array(0) // each cloud's fade as written (in steps)
  #from: Cartesian3 | null = null // where the clouds are faded from (the aircraft at the last look); none: not faded
  #f = 1 // the factor and relH the clouds are placed for: the true relief until the first frame()
  #relHM = 0
  #night = 0 // the night their brightness is written for, in steps
  #destroyed = false

  constructor(primitives: PrimitiveCollection, opts: { geoid?: (lat: number, lon: number) => number } = {}) {
    this.#primitives = primitives
    this.#geoid = opts.geoid ?? geoidN
    primitives.add(this.#coll)
  }

  get show(): boolean {
    return !this.#destroyed && this.#coll.show
  }

  set show(on: boolean) {
    if (!this.#destroyed) this.#coll.show = on
  }

  /** The clouds drawn. */
  get count(): number {
    return this.#clouds.length
  }

  /** These clouds in place of those drawn before (Cesium rewrites its buffer once, at its next update). */
  draw(specs: readonly CloudSpec[]): void {
    if (this.#destroyed) return
    this.#coll.removeAll()
    const at = new Float64Array(specs.length * STRIDE)
    const b = sunBrightness(this.#night)
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i]
      const n = this.#geoid(s.lat, s.lon)
      const p = Cartesian3.fromDegrees(s.lon, s.lat, s.heightM + n, Ellipsoid.WGS84, scratch)
      const k = i * STRIDE
      at[k] = p.x
      at[k + 1] = p.y
      at[k + 2] = p.z
      const up = Ellipsoid.WGS84.geodeticSurfaceNormal(p, scratch)
      at[k + 3] = up.x
      at[k + 4] = up.y
      at[k + 5] = up.z
      at[k + 6] = s.groundM + n
    }
    this.#at = at
    this.#specs = specs
    this.#alpha = new Float64Array(specs.length)
    this.#clouds = specs.map((s, i) => {
      const a = (this.#alpha[i] = this.#alphaAt(i))
      return this.#coll.add({
        position: this.#placed(i), scale: new Cartesian2(s.scale[0], s.scale[1]), maximumSize: new Cartesian3(s.maxSize[0], s.maxSize[1], s.maxSize[2]),
        slice: s.slice, brightness: s.brightness * b, color: tintColor(s.tint, a), show: a > 0,
      })
    })
  }

  /** Each look: every cloud faded by its distance from `from` (the aircraft), written only when it has changed by a step. */
  fade(from: Cartesian3): void {
    if (this.#destroyed) return
    this.#from = Cartesian3.clone(from, this.#from ?? new Cartesian3())
    for (let i = 0; i < this.#clouds.length; i++) {
      const a = this.#alphaAt(i)
      if (a === this.#alpha[i]) continue
      this.#alpha[i] = a
      const c = this.#clouds[i]
      c.color = tintColor(this.#specs[i].tint, a)
      c.show = a > 0
    }
  }

  /** Every frame: the clouds moved with the relief drawn when its factor or plane changed, brightened or dimmed when the night did. */
  frame(tf: TerrainFrame, night: number): void {
    if (this.#destroyed) return
    if ((tf.fNow !== this.#f || tf.relHM !== this.#relHM) && Number.isFinite(tf.fNow) && Number.isFinite(tf.relHM)) {
      this.#f = tf.fNow
      this.#relHM = tf.relHM
      for (let i = 0; i < this.#clouds.length; i++) this.#clouds[i].position = this.#placed(i) // the setter copies it
    }
    const q = Number.isFinite(night) ? Math.round(Math.min(1, Math.max(0, night)) / NIGHT_STEP) * NIGHT_STEP : 0
    if (q !== this.#night) {
      this.#night = q
      const b = sunBrightness(q)
      for (let i = 0; i < this.#clouds.length; i++) this.#clouds[i].brightness = this.#specs[i].brightness * b
    }
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#clouds = []
    this.#primitives.remove(this.#coll) // and destroys it
  }

  /** How much of cloud i shows from where it is faded from, in steps (all of it before any fade): by its distance, and, for a puff with clearKm, by how near the aircraft is at its height. */
  #alphaAt(i: number): number {
    const from = this.#from
    if (from === null) return 1
    const a = this.#at
    const k = i * STRIDE
    const [dx, dy, dz] = [a[k] - from.x, a[k + 1] - from.y, a[k + 2] - from.z]
    const m = Math.hypot(dx, dy, dz)
    const s = this.#specs[i]
    let alpha = fadeAlpha(s, m / 1000)
    if (s.clearKm !== undefined && alpha > 0) {
      const above = -(dx * a[k + 3] + dy * a[k + 4] + dz * a[k + 5]) // the aircraft's height over the puff's middle, along the up there
      if (Math.abs(above) <= (PUFF_FILL * s.scale[1]) / 2 + CLEAR_MARGIN_M) alpha *= smoothstep((Math.sqrt(Math.max(0, m * m - above * above)) / 1000 / s.clearKm) - 1)
    }
    return Math.round(alpha / FADE_STEP) * FADE_STEP
  }

  /** Cloud i where it is drawn: its true place moved along up by as much as its ground is moved (scratch: read it at once). */
  #placed(i: number): Cartesian3 {
    const a = this.#at
    const k = i * STRIDE
    const g = a[k + 6]
    const shift = drawnHeightM(g, this.#f, this.#relHM) - g
    scratch.x = a[k] + a[k + 3] * shift
    scratch.y = a[k + 1] + a[k + 4] * shift
    scratch.z = a[k + 2] + a[k + 5] * shift
    return scratch
  }
}
