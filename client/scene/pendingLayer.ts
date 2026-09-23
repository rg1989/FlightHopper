// client/scene/pendingLayer.ts
// The areas of a wide view the server has not loaded yet (StatusBrief.pendingBoxes: its ≈ 4° grid cells), veiled on the
// map, so an empty patch reads as "not loaded yet", not "no aircraft there". The one loading now (the first) is half
// veiled, a light running round its edge (the rail's busy loader, on the map). A cell's veil goes when its first answer
// lands. Never pickable: a tap on an aircraft over a veiled cell still selects it (fleetLayer picks the topmost object).
import {
  ArcType, Cartesian3, Color, ColorGeometryInstanceAttribute, GeometryInstance, GroundPolylineGeometry, GroundPolylinePrimitive,
  GroundPrimitive, Material, PerInstanceColorAppearance, PolylineColorAppearance, PolylineMaterialAppearance, Rectangle,
  RectangleGeometry, ShowGeometryInstanceAttribute, type Viewer,
} from 'cesium'

export type Box = readonly [south: number, north: number, west: number, east: number]

const ACCENT = Color.fromCssColorString('#5aa9ff') // --fh-accent
// Not loaded: veiled a little darker (the street map and the satellite imagery both), each cell outlined in the accent.
const VEIL = Color.fromCssColorString('#0b1422')
const FILL = ColorGeometryInstanceAttribute.fromColor(VEIL.withAlpha(0.28))
const HALF = ColorGeometryInstanceAttribute.fromColor(VEIL.withAlpha(0.12)) // loading now: between veiled and clear
const EDGE = ColorGeometryInstanceAttribute.fromColor(ACCENT.withAlpha(0.6))
const LAP_MS = 1400 // one lap of the light round the loading cell, as the rail's (rail.css)
// The light: bright at the head (s = offset along the edge), fading over the half lap behind it.
const COMET = `czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  float t = fract(materialInput.s - offset);
  m.diffuse = color.rgb;
  m.alpha = color.a * smoothstep(0.5, 1.0, t);
  return m;
}`
const SHOWN = ShowGeometryInstanceAttribute.toValue(true)
const HIDDEN = ShowGeometryInstanceAttribute.toValue(false)

export interface PendingLayer {
  /**
   * The boxes still to load, the one loading now first (undefined or none: clear). show false hides them all (the
   * chase); loading false marks none as loading (in trouble no answer is coming). Call it every frame.
   */
  update(boxes: readonly Box[] | undefined, show: boolean, loading: boolean): void
  destroy(): void
}

interface Batch {
  fill: GroundPrimitive
  edge: GroundPolylinePrimitive
  keys: Set<string>
  shown: Set<string>
  lit: string | null // the cell drawn half veiled
}

const keyOf = (b: Box): string => b.join()

/**
 * Cells are drawn in batches (two ground primitives), built once per set of cells and swapped in when drawn; a cell that
 * loads is hidden in place and the loading one lightened in place (per-instance show and colour), so nothing is rebuilt,
 * and nothing blinks, as a view fills. The light round the loading cell is its own small primitive.
 */
export function makePendingLayer(viewer: Viewer): PendingLayer {
  const scene = viewer.scene
  const prims = scene.groundPrimitives
  let cur: Batch | null = null // drawn
  let next: Batch | null = null // building, every cell hidden until it replaces cur
  let want = new Set<string>()
  let wantList: readonly Box[] = []
  let loadingKey: string | null = null
  let comet: GroundPolylinePrimitive | null = null
  let cometKey: string | null = null
  let lastBoxes: readonly Box[] | undefined
  let lastShow = false
  let lastLoading = false

  const drop = (b: Batch | null): null => {
    if (b !== null) (prims.remove(b.fill), prims.remove(b.edge)) // and destroys them
    return null
  }
  /** Shows exactly the wanted cells of a drawn batch, the loading one half veiled, touching only those that change. */
  const paint = (b: Batch): void => {
    for (const k of b.keys) {
      const on = want.has(k)
      if (on === b.shown.has(k)) continue
      if (on) b.shown.add(k)
      else b.shown.delete(k)
      b.fill.getGeometryInstanceAttributes(k).show = on ? SHOWN : HIDDEN
      b.edge.getGeometryInstanceAttributes(k).show = on ? SHOWN : HIDDEN
    }
    const lit = loadingKey !== null && b.keys.has(loadingKey) ? loadingKey : null
    if (lit === b.lit) return
    if (b.lit !== null) b.fill.getGeometryInstanceAttributes(b.lit).color = FILL.value
    if (lit !== null) b.fill.getGeometryInstanceAttributes(lit).color = HALF.value
    b.lit = lit
  }
  const dropComet = (): void => {
    if (comet !== null) prims.remove(comet)
    comet = null
    cometKey = null
  }
  const covers = (b: Batch | null): boolean => want.size === 0 || (b !== null && [...want].every((k) => b.keys.has(k)))
  const build = (boxes: readonly Box[]): Batch => {
    const show = new ShowGeometryInstanceAttribute(false)
    return {
      fill: prims.add(new GroundPrimitive({
        geometryInstances: boxes.map((b) => new GeometryInstance({
          id: keyOf(b),
          geometry: new RectangleGeometry({ rectangle: Rectangle.fromDegrees(b[2], b[0], b[3], b[1]) }),
          attributes: { color: FILL, show },
        })),
        appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
        allowPicking: false,
      })),
      edge: prims.add(new GroundPolylinePrimitive({
        geometryInstances: boxes.map(([s, n, w, e]) => new GeometryInstance({
          id: keyOf([s, n, w, e]),
          // Rhumb lines: the north and south edges follow their parallels, as the cells do.
          geometry: new GroundPolylineGeometry({ positions: Cartesian3.fromDegreesArray([w, s, e, s, e, n, w, n]), loop: true, width: 1, arcType: ArcType.RHUMB }),
          attributes: { color: EDGE, show },
        })),
        appearance: new PolylineColorAppearance(),
        allowPicking: false,
      })),
      keys: new Set(boxes.map(keyOf)),
      shown: new Set(),
      lit: null,
    }
  }

  const removePost = scene.postRender.addEventListener(() => {
    // Swap in a built batch: its cells were hidden while cur drew, so for one frame no cell is drawn twice (darker).
    if (next !== null && next.fill.ready && next.edge.ready) {
      drop(cur)
      cur = next
      next = null
      paint(cur)
    }
    // New cells (a new view): one batch of all the wanted ones. One at a time: a set that came while one built is next.
    if (next === null && !covers(cur)) next = build(wantList)
    // The light round the loading cell: a new one when another cell starts loading, moved on every frame.
    if (cometKey !== loadingKey) {
      dropComet()
      const b = loadingKey === null ? undefined : wantList[0]
      if (b !== undefined) {
        const [s, n, w, e] = b
        cometKey = loadingKey
        comet = prims.add(new GroundPolylinePrimitive({
          geometryInstances: new GeometryInstance({
            geometry: new GroundPolylineGeometry({ positions: Cartesian3.fromDegreesArray([w, s, e, s, e, n, w, n]), loop: true, width: 4, arcType: ArcType.RHUMB }),
          }),
          appearance: new PolylineMaterialAppearance({
            material: new Material({ fabric: { uniforms: { color: ACCENT, offset: 0 }, source: COMET }, translucent: true }),
          }),
          allowPicking: false,
        }))
      }
    }
    if (comet !== null) (comet.appearance.material as Material).uniforms.offset = (performance.now() % LAP_MS) / LAP_MS
  })

  return {
    update(boxes, show, loading) {
      if (boxes === lastBoxes && show === lastShow && loading === lastLoading) return // a new status comes once a poll
      lastBoxes = boxes
      lastShow = show
      lastLoading = loading
      const list = show && boxes !== undefined ? boxes : []
      wantList = list
      want = new Set(list.map(keyOf))
      loadingKey = loading && list.length > 0 ? keyOf(list[0]) : null
      if (want.size === 0) {
        // Cleared (all loaded, or the chase): at once, and whatever was building goes too.
        next = drop(next)
        cur = drop(cur)
        dropComet()
        return
      }
      if (cur !== null) paint(cur) // cells that loaded go at once; new ones wait for the next batch (postRender)
    },
    destroy() {
      removePost()
      next = drop(next)
      cur = drop(cur)
      dropComet()
    },
  }
}
