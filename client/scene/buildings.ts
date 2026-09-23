// client/scene/buildings.ts
// 3-D buildings in chase: OpenStreetMap footprints and heights from OpenFreeMap's vector tiles (keyless, OpenMapTiles
// schema, z14 layer `building`), extruded as one unpickable Primitive per tile on the terrain's TRUE heights and moved
// with the terrain exaggeration like the runways. One "clay" colour, lit by the app's sun; the see-through toggle swaps
// every tile to a translucent twin of the same shader (no geometry rebuild).
import {
  Cartesian3,
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Ellipsoid,
  GeometryInstance,
  GeometryInstanceAttribute,
  Matrix4,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  ShadowMode,
  type Viewer,
} from 'cesium'
import type { TerrainFrame } from '../types.ts'
import { decodeLayer, type Layer } from './mvt.ts'
import { followExaggeration } from './runways.ts'
import { TerrainHeights } from './terrainHeights.ts'

export const BUILDINGS_Z = 14 // OpenMapTiles has buildings at z13–14; 14 is unmerged and ~2 km a side at mid latitudes
export const BUILDINGS_RADIUS_M = 5000 // tiles touching the square of this half-side around the chased aircraft
const KEEP_MARGIN_M = 2000 // loaded tiles stay until the aircraft is this much farther away (no churn at a tile edge)
const MAX_IN_FLIGHT = 4
const RETRY_MS = 30_000 // a failed tile is asked for again at the next plan after this
const MIN_HEIGHT_M = 2 // walls, sheds and carports mapped as buildings
const FLAT_HIDE_F = 0.02 // below this factor the relief is (nearly) flat: nothing to stand up
export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet'
const OPENFREEMAP_ORIGIN = 'https://tiles.openfreemap.org'
export const BUILDINGS_CREDIT = 'Buildings: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors'

const n2 = (): number => 2 ** BUILDINGS_Z
/** The z14 slippy-map tile [x, y] of a point (Web Mercator, y down from the north). */
export function tileOf(lat: number, lon: number): [number, number] {
  const r = (lat * Math.PI) / 180
  return [Math.floor(((lon + 180) / 360) * n2()), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n2())]
}
/** Longitude of a (fractional) tile x; tileLonDeg(x + 1) is the east edge. */
export const tileLonDeg = (x: number): number => (x / n2()) * 360 - 180
/** Latitude of a (fractional) tile y; tileLatDeg(y) is the north edge. */
export const tileLatDeg = (y: number): number => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n2()))) * 180) / Math.PI

/** Every tile touching the square of half-side rM around a point, nearest (in tiles) first. */
export function tilesAround(lat: number, lon: number, rM: number): [number, number][] {
  const dLat = rM / 111_320
  const dLon = rM / (111_320 * Math.cos((lat * Math.PI) / 180))
  const [x0, y0] = tileOf(lat + dLat, lon - dLon)
  const [x1, y1] = tileOf(lat - dLat, lon + dLon)
  const [cx, cy] = tileOf(lat, lon)
  const out: [number, number][] = []
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y])
  return out.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy))
}

/** One polygon of a building (or building:part), in degrees. rnd is a stable per-building random in [0, 1). */
export interface Footprint {
  rings: [number, number][][] // [outer, ...holes], [lon, lat]
  heightM: number // render_height: the top above the ground
  minHeightM: number // render_min_height: > 0 for a part standing on another (a tower on a podium)
  rnd: number
}

const frac = (v: number): number => v - Math.floor(v)

/** A decoded z14 `building` layer → footprints. Outlines whose parts carry the shape (hide_3d) and anything under 2 m are left out. */
export function footprints(layer: Layer, x: number, y: number): Footprint[] {
  const e = layer.extent
  const out: Footprint[] = []
  for (const f of layer.features) {
    if (f.props.hide_3d === true) continue
    const heightM = Number(f.props.render_height) || 0
    if (heightM < MIN_HEIGHT_M) continue
    const minHeightM = Number(f.props.render_min_height) || 0
    for (const poly of f.polys) {
      const rings = poly.map((r) => r.map(([px, py]): [number, number] => [tileLonDeg(x + px / e), tileLatDeg(y + py / e)]))
      let lon = 0
      let lat = 0
      for (const [a, b] of rings[0]) (lon += a), (lat += b)
      out.push({ rings, heightM, minHeightM, rnd: frac(Math.sin((lon / rings[0].length) * 12.9898e4 + (lat / rings[0].length) * 78.233e3) * 43758.5453) })
    }
  }
  return out
}

// Walls reach this far below the lowest ground read. Hidden by depthTestAgainstTerrain wherever the terrain covers them
// (no extra vertices), they fill the gap where Cesium draws coarser terrain than the true one: 1–4 km out it sits up to
// ~16 m lower on hilltops (harness check, six mountain cities); there a building shows a slightly taller, darker foot.
const FOUNDATION_M = 20
const STOREY_M = 3 // at least this much of a building stays above its highest corner
const MAX_GROUND_POINTS = 24
const WALL_STEP_M = 10

/**
 * Where a footprint's ground is read: every corner of its outer ring, plus a point every 10 m along longer walls (a wall
 * across a dip would float between its corners), thinned evenly to at most 24.
 */
export function groundPoints(f: Footprint): [number, number][] {
  const r = f.rings[0]
  const mLon = 111_320 * Math.cos((r[0][1] * Math.PI) / 180)
  const pts: [number, number][] = []
  for (let i = 0; i < r.length; i++) {
    const [a, b] = [r[i], r[(i + 1) % r.length]]
    pts.push(a)
    const lenM = Math.hypot((b[0] - a[0]) * mLon, (b[1] - a[1]) * 111_320)
    for (let d = WALL_STEP_M; d < lenM - 0.01; d += WALL_STEP_M) pts.push([a[0] + ((b[0] - a[0]) * d) / lenM, a[1] + ((b[1] - a[1]) * d) / lenM])
  }
  if (pts.length <= MAX_GROUND_POINTS) return pts
  return Array.from({ length: MAX_GROUND_POINTS }, (_, i) => pts[Math.floor((i * pts.length) / MAX_GROUND_POINTS)])
}

/**
 * Base and top (HAE m) of a footprint from the true ground read at its groundPoints. OSM measures height from the lowest
 * ground the building touches, so it stands on the lowest corner, on a 20 m foundation (FOUNDATION_M): on a hillside the downhill wall reaches the ground and the uphill side is dug in, as real hillside houses are.
 * Where the slope under it is steeper than it is tall, its top rises to one storey (3 m, or its own height if lower) above
 * the highest corner, so it never vanishes into the hill: the downhill side then shows extra floors, as hillside buildings
 * do (harness check: Hong Kong's Mid-Levels had 23 % of roofs under the uphill ground without this).
 * A part on a podium starts at its min height above that ground. groundM (the mean of the reads) feeds the contact shadow.
 * ponytail: parts of one building each read their own corners, so on a slope a tower can shift a few metres against its
 * podium. Upgrade: one ground per OSM building (OpenMapTiles drops the relation).
 */
export function extentM(f: Footprint, groundsM: number[]): { baseM: number; topM: number; groundM: number } {
  const lowM = Math.min(...groundsM)
  const highM = Math.max(...groundsM)
  return {
    baseM: f.minHeightM > 0 ? lowM + f.minHeightM : lowM - FOUNDATION_M,
    topM: f.minHeightM > 0 ? lowM + f.heightM : Math.max(lowM + f.heightM, highM + Math.min(f.heightM, STOREY_M)),
    groundM: groundsM.reduce((a, b) => a + b, 0) / groundsM.length,
  }
}

let tileUrl: Promise<string> | null = null
/** The `building` layer of one tile from OpenFreeMap; null where there is none. The tile URL comes from its TileJSON (it is versioned). */
export async function openFreeMapLayer(x: number, y: number): Promise<Layer | null> {
  tileUrl ??= fetch(OPENFREEMAP_TILEJSON)
    .then((r) => (r.ok ? (r.json() as Promise<{ tiles?: unknown[] }>) : Promise.reject(new Error(`TileJSON: HTTP ${r.status}`))))
    .then((j) => {
      const u = j.tiles?.[0]
      // the TileJSON is outside data: its URL must stay on OpenFreeMap
      if (typeof u !== 'string' || new URL(u).origin !== OPENFREEMAP_ORIGIN) throw new Error(`TileJSON: unexpected tile URL ${String(u)}`)
      return u
    })
  let url: string
  try {
    url = await tileUrl
  } catch (e) {
    tileUrl = null // asked again with the next tile
    throw e
  }
  const res = await fetch(url.replace('{z}', String(BUILDINGS_Z)).replace('{x}', String(x)).replace('{y}', String(y)))
  if (res.status === 204 || res.status === 404) return null
  if (!res.ok) throw new Error(`building tile ${x}/${y}: HTTP ${res.status}`)
  return decodeLayer(new Uint8Array(await res.arrayBuffer()), 'building')
}

// ---------- look ----------
// v_h: height above the ground under the footprint, from the camera (czm_eyeHeight + the offset along the camera's up +
// the Earth's curvature) minus the per-instance `ground`; exact only while the tile is unexaggerated (v_exact: its
// modelMatrix scales nothing along up), so the contact shadow switches off while the relief grows, sinks or is flat.
const VS = /* glsl */ `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in vec4 color;
in float batchId;
out vec3 v_positionEC;
out vec3 v_normalEC;
out vec4 v_color;
out float v_h;
out float v_exact;
void main() {
  vec4 p = czm_computePosition();
  v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
  v_normalEC = czm_normal * normal;
  v_color = color;
  float up = dot(v_positionEC, czm_eyeEllipsoidNormalEC);
  float s2 = dot(v_positionEC, v_positionEC) - up * up;
  v_h = czm_eyeHeight + up + s2 / 12742000.0 - czm_batchTable_ground(batchId);
  vec3 n = normalize(position3DHigh + position3DLow);
  v_exact = step(abs(dot(n, mat3(czm_model) * n) - 1.0), 1e-3);
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`

// Walls take the sun (Lambert: the stock czm_phong lights from the camera) plus a sky term favouring up-facing surfaces;
// roofs are a touch darker and greyer. The streets darken the walls' feet (contact shadow). Night = the app's light
// dimming (intensity 2 → 0.45, WP-E2): a faint warm glow on half the buildings (v_color.a is a per-building random).
// Haze towards the terrain's. Within NEAR_M of the camera nothing is drawn: the chase camera clears the terrain, not the
// buildings, and must not end up boxed in by walls.
// ponytail: flat roofs, no windows; OpenMapTiles has no roof shape. Upgrade: roof:shape from OSM (another source).
const FS = /* glsl */ `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec4 v_color;
in float v_h;
in float v_exact;
const float NEAR_M = 30.0;
void main() {
  float dist = length(v_positionEC);
  if (dist < NEAR_M) discard;
  vec3 n = normalize(v_normalEC);
  vec3 upEC = normalize(czm_viewRotation * normalize((czm_inverseView * vec4(v_positionEC, 1.0)).xyz));
  float up = dot(n, upEC);
  float roof = smoothstep(0.6, 0.8, up);
  vec3 base = mix(v_color.rgb, v_color.rgb * vec3(0.80, 0.79, 0.78), roof);
  float I = length(czm_lightColorHdr) / 1.7320508;
  float night = clamp((1.3 - I) / 0.8, 0.0, 1.0);
  float sun = max(dot(n, czm_lightDirectionEC), 0.0);
  float sky = 0.40 + 0.15 * up;
  vec3 c = base * (sky * mix(1.0, 0.30, night) + 0.55 * sun * czm_lightColor * (1.0 - night));
  float contact = mix(0.62, 1.0, smoothstep(0.0, 9.0, v_h)) * mix(0.94, 1.06, smoothstep(10.0, 160.0, v_h));
  c *= mix(1.0, contact, v_exact);
  float lit = step(0.5, fract(v_color.a * 7.13)) * (1.0 - roof);
  c += night * lit * vec3(1.0, 0.72, 0.38) * (0.10 + 0.10 * v_color.a);
  vec3 haze = vec3(0.72, 0.79, 0.87) * mix(1.0, 0.05, night);
  c = mix(c, haze, 1.0 - exp(-dist / 16000.0));
#ifdef GLASS
  // faces seen head-on are the clearest, edge-on ones stay denser: silhouettes stay readable
  out_FragColor = vec4(c, mix(0.55, 0.18, abs(dot(n, normalize(-v_positionEC)))));
#else
  out_FragColor = vec4(c, 1.0);
#endif
}`

// closed: false, so no back-face culling: the bottoms are left open (buried) and see-through shows the far walls.
const SOLID = new PerInstanceColorAppearance({ flat: false, translucent: false, closed: false, vertexShaderSource: VS, fragmentShaderSource: FS })
const GLASS = new PerInstanceColorAppearance({ flat: false, translucent: true, closed: false, vertexShaderSource: VS, fragmentShaderSource: `#define GLASS\n${FS}` })
const CLAY = new Color(0.9, 0.88, 0.84)

interface Tile {
  state: 'loading' | 'done' | 'failed'
  failedAtMs: number
  prim: Primitive | null // null while loading, and for a tile without buildings
  model: Matrix4 // followExaggeration's result for this tile, copied into prim.modelMatrix
  up: Cartesian3 // the ellipsoid normal at the tile centre
  upDotBase: number
  hM: number // the mean ground under the tile's buildings: the exaggeration's reference height
}

export interface BuildingsOpts {
  loadLayer?: (x: number, y: number) => Promise<Layer | null> // default: OpenFreeMap
  groundM?: (at: Cartographic[]) => Promise<(number | undefined)[]> // true terrain heights; default: TerrainHeights
}

/**
 * The buildings around the chased aircraft. update() every frame: with a focus (chase) it plans when the aircraft enters
 * another tile or a load finishes: drops tiles farther than the radius + 2 km, and starts up to 4 loads, nearest first.
 * Each tile reads the TRUE ground at its footprints' corners (TerrainHeights) and is built at those heights, then
 * placed with followExaggeration, so it grows and sinks with the relief. Without a focus (browse) everything is hidden
 * and nothing loads.
 * ponytail: decoding and the ground reads run on the main thread (a few ms a tile with TerrainHeights); the geometry is
 * built on Cesium's workers. Upgrade: decode in a worker if gate runs show hitches.
 */
export class Buildings {
  readonly #viewer: Viewer
  readonly #load: (x: number, y: number) => Promise<Layer | null>
  readonly #ground: (at: Cartographic[]) => Promise<(number | undefined)[]>
  readonly #tiles = new Map<string, Tile>()
  #inFlight = 0
  #glass = false
  #shown = false
  #f = 1 // the factor and relH the tiles are placed for; as built: the terrain as loaded
  #relHM = 0
  #planKey = '' // the focus tile at the last plan
  #dirty = true // a load finished since: plan again
  #warned = false
  #destroyed = false

  constructor(viewer: Viewer, opts: BuildingsOpts = {}) {
    this.#viewer = viewer
    this.#load = opts.loadLayer ?? openFreeMapLayer
    const heights = opts.groundM ? null : new TerrainHeights(viewer.terrainProvider)
    this.#ground = opts.groundM ?? ((at) => heights!.heights(at))
  }

  update(focus: { lat: number; lon: number } | null, frame: TerrainFrame): void {
    if (this.#destroyed) return
    if ((frame.fNow !== this.#f || frame.relHM !== this.#relHM) && Number.isFinite(frame.fNow) && Number.isFinite(frame.relHM)) {
      this.#f = frame.fNow
      this.#relHM = frame.relHM
      for (const t of this.#tiles.values()) if (t.prim) this.#place(t)
    }
    const show = focus !== null && this.#f >= FLAT_HIDE_F
    if (show !== this.#shown) {
      this.#shown = show
      for (const t of this.#tiles.values()) if (t.prim) t.prim.show = show
    }
    if (focus === null || !Number.isFinite(focus.lat) || !Number.isFinite(focus.lon)) return
    const [fx, fy] = tileOf(focus.lat, focus.lon)
    const planKey = `${fx}/${fy}`
    if (planKey === this.#planKey && !this.#dirty) return
    this.#planKey = planKey
    this.#dirty = false
    const keep = new Set(tilesAround(focus.lat, focus.lon, BUILDINGS_RADIUS_M + KEEP_MARGIN_M).map(([x, y]) => `${x}/${y}`))
    for (const [k, t] of this.#tiles) if (!keep.has(k)) this.#drop(k, t)
    const nowMs = performance.now()
    for (const [x, y] of tilesAround(focus.lat, focus.lon, BUILDINGS_RADIUS_M)) {
      if (this.#inFlight >= MAX_IN_FLIGHT) break
      const k = `${x}/${y}`
      const t = this.#tiles.get(k)
      if (t && !(t.state === 'failed' && nowMs - t.failedAtMs > RETRY_MS)) continue
      void this.#fetch(x, y, k)
    }
  }

  /** Nothing loading and every loaded tile's geometry built (harnesses and gates wait for it). */
  get settled(): boolean {
    if (this.#inFlight > 0) return false
    for (const t of this.#tiles.values()) if (t.prim && !t.prim.ready) return false
    return true
  }

  /** Solid clay or see-through, for every tile now and later. Swapping Primitive.appearance recompiles the shader only. */
  setGlass(on: boolean): void {
    if (on === this.#glass) return
    this.#glass = on
    for (const t of this.#tiles.values()) if (t.prim) t.prim.appearance = on ? GLASS : SOLID
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    for (const [k, t] of this.#tiles) this.#drop(k, t)
  }

  #drop(k: string, t: Tile): void {
    this.#tiles.delete(k)
    if (t.prim && !this.#viewer.isDestroyed()) this.#viewer.scene.primitives.remove(t.prim) // and destroys it
    t.prim = null
  }

  #place(t: Tile): void {
    followExaggeration(t.up, t.upDotBase, t.hM, this.#f, this.#relHM, t.model)
    if (t.prim) Matrix4.clone(t.model, t.prim.modelMatrix) // in place: Primitive compares it every frame
  }

  async #fetch(x: number, y: number, k: string): Promise<void> {
    const t: Tile = { state: 'loading', failedAtMs: 0, prim: null, model: new Matrix4(), up: new Cartesian3(), upDotBase: 0, hM: 0 }
    this.#tiles.set(k, t)
    this.#inFlight++
    try {
      const layer = await this.#load(x, y)
      const fps = layer === null ? [] : footprints(layer, x, y)
      // Neighbours share corners (row houses, clipped parts): each distinct point is read once.
      const index = new Map<string, number>()
      const at: Cartographic[] = []
      const refs = fps.map((f) =>
        groundPoints(f).map(([lon, lat]) => {
          const key = `${lon},${lat}`
          let j = index.get(key)
          if (j === undefined) {
            index.set(key, (j = at.length))
            at.push(Cartographic.fromDegrees(lon, lat))
          }
          return j
        }),
      )
      const hs = at.length === 0 ? [] : await this.#ground(at)
      const grounds = refs.map((r) => r.map((j) => hs[j]).filter((h): h is number => h !== undefined && Number.isFinite(h)))
      if (this.#destroyed || this.#tiles.get(k) !== t) return // dropped while loading
      t.state = 'done'
      t.prim = this.#build(t, fps, grounds, x, y)
      if (t.prim) this.#viewer.scene.primitives.add(t.prim)
    } catch (e) {
      t.state = 'failed'
      t.failedAtMs = performance.now()
      if (!this.#warned) console.warn('FlightHopper: building tile failed (retried later):', e)
      this.#warned = true
    } finally {
      this.#inFlight--
      this.#dirty = true
    }
  }

  #build(t: Tile, fps: Footprint[], grounds: number[][], x: number, y: number): Primitive | null {
    const instances: GeometryInstance[] = []
    let sum = 0
    for (let i = 0; i < fps.length; i++) {
      if (grounds[i].length === 0) continue // no terrain read under it
      const f = fps[i]
      const { baseM, topM, groundM } = extentM(f, grounds[i])
      sum += groundM
      instances.push(
        new GeometryInstance({
          geometry: new PolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(
              Cartesian3.fromDegreesArray(f.rings[0].flat()),
              f.rings.slice(1).map((hole) => new PolygonHierarchy(Cartesian3.fromDegreesArray(hole.flat()))),
            ),
            height: baseM,
            extrudedHeight: topM,
            closeBottom: false,
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            // ponytail: alpha carries the per-building random for the night glow (the solid pass ignores alpha)
            color: ColorGeometryInstanceAttribute.fromColor(Color.fromAlpha(Color.multiplyByScalar(CLAY, 0.95 + 0.07 * f.rnd, new Color()), 0.5 + 0.5 * f.rnd)),
            ground: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, value: [groundM] }),
          },
        }),
      )
    }
    if (instances.length === 0) return null
    const lon = (tileLonDeg(x) + tileLonDeg(x + 1)) / 2
    const lat = (tileLatDeg(y) + tileLatDeg(y + 1)) / 2
    t.hM = sum / instances.length
    Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(Cartographic.fromDegrees(lon, lat), t.up)
    t.upDotBase = Cartesian3.dot(t.up, Cartesian3.fromDegrees(lon, lat, t.hM))
    this.#place(t)
    return new Primitive({
      geometryInstances: instances,
      appearance: this.#glass ? GLASS : SOLID,
      modelMatrix: t.model,
      show: this.#shown,
      asynchronous: true,
      allowPicking: false,
      releaseGeometryInstances: true,
      compressVertices: true,
      shadows: ShadowMode.DISABLED,
    })
  }
}
