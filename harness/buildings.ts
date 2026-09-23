// harness/buildings.ts
// Buildings harness: the real Buildings layer on the app's viewer (createViewer), Sun and Topography, seen from a fixed
// camera over a city, mountain cities first. X swaps solid / see-through, T sinks and grows the relief with the buildings.
// check() measures how the buildings meet the terrain: it reads the true ground every 4 m along each standing building's
// walls near the focus and reports walls floating above it and roofs below the uphill ground, for the corner rule the
// layer uses (extentM) and, for comparison, the old centre rule (centre ground − 2 m − 0.3 × radius).
// Query: ?scene=hk|monaco|haifa|rio|lapaz|ibk|tlv  ?time=ISO  ?glass=1  ?topo=0  ?check=1 (run check() once settled)  ?info=0  ?buildings=0 (baseline)
// window.harness = { viewer, buildings, stats(), check(radiusM) }
import { Cartesian3, Cartographic, JulianDate, Math as CMath, sampleTerrainMostDetailed } from 'cesium'
import { readConfig } from '../client/config.ts'
import { Buildings, extentM, footprints, groundPoints, openFreeMapLayer, tilesAround, type Footprint } from '../client/scene/buildings.ts'
import { makeNightLayer } from '../client/scene/nightLights.ts'
import { Sun } from '../client/scene/sun.ts'
import { TerrainHeights } from '../client/scene/terrainHeights.ts'
import { Topography } from '../client/scene/topography.ts'
import { createViewer } from '../client/scene/viewer.ts'
import type { TerrainFrame } from '../client/types.ts'

const q = new URLSearchParams(location.search)
// cam = [lat, lon, HAE m, heading°, pitch°]; focus = where the aircraft would be (the layer loads around it)
interface Scene { cam: [number, number, number, number, number]; focus: [number, number]; time: string; what: string }
const SCENES: Record<string, Scene> = {
  hk: { cam: [22.2885, 114.1545, 260, 195, -6], focus: [22.279, 114.151], time: '2026-09-23T02:30:00Z', what: 'Hong Kong: Central and the Mid-Levels up the Peak' },
  monaco: { cam: [43.7322, 7.4355, 190, 318, -7], focus: [43.7395, 7.4275], time: '2026-09-23T13:00:00Z', what: 'Monaco: Monte Carlo on the slope under La Turbie' },
  haifa: { cam: [32.8295, 34.9975, 260, 205, -7], focus: [32.8155, 34.9905], time: '2026-09-23T13:30:00Z', what: 'Haifa: downtown and the Carmel slope' },
  rio: { cam: [-23.0035, -43.2575, 230, 18, -3], focus: [-22.9885, -43.2485], time: '2026-09-23T14:00:00Z', what: 'Rio: Rocinha on the slope of Dois Irmãos' },
  lapaz: { cam: [-16.527, -68.117, 4020, 332, -8], focus: [-16.503, -68.132], time: '2026-09-23T15:00:00Z', what: 'La Paz: the city in its canyon' },
  ibk: { cam: [47.2655, 11.3935, 880, 355, -2], focus: [47.2805, 11.3955], time: '2026-06-21T15:00:00Z', what: 'Innsbruck: Hungerburg on the Nordkette slope' },
  tlv: { cam: [32.0712, 34.7665, 330, 92, -12], focus: [32.0735, 34.785], time: '2026-09-23T14:40:00Z', what: 'Tel Aviv (flat, for comparison)' },
}
const scene = SCENES[q.get('scene') ?? 'hk'] ?? SCENES.hk
const timeMs = Date.parse(q.get('time') ?? scene.time)
const info = document.getElementById('info')!
if (q.get('info') === '0') info.style.display = 'none'

// Main-thread stalls while tiles load (the ground reads and decoding run there).
const longTasks: number[] = []
new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(e.duration))).observe({ type: 'longtask', buffered: true })

const pct = (xs: number[], p: number): number => (xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))])
const r1 = (v: number): number => Math.round(v * 10) / 10

async function main(): Promise<void> {
  const cfg = readConfig(import.meta.env) // the app's terrain and imagery
  const viewer = await createViewer('globe', cfg)
  const topo = new Topography(viewer.scene, q.get('topo') !== '0')
  const day = viewer.imageryLayers.length > 0 ? viewer.imageryLayers.get(0) : null
  const night = makeNightLayer()
  viewer.imageryLayers.add(night)
  const sun = new Sun(viewer, { day, night })
  sun.setEnabled(true)
  // ?ground=flat: no terrain reads (profiling their cost)
  const buildings = new Buildings(viewer, q.get('ground') === 'flat' ? { groundM: async (at) => at.map(() => 0) } : {})
  let glass = q.get('glass') === '1'
  buildings.setGlass(glass)

  const [clat, clon, ch, chdg, cpitch] = scene.cam
  viewer.camera.setView({ destination: Cartesian3.fromDegrees(clon, clat, ch), orientation: { heading: CMath.toRadians(chdg), pitch: CMath.toRadians(cpitch), roll: 0 } })
  const focus = { lat: scene.focus[0], lon: scene.focus[1] }
  const [focusGround] = await sampleTerrainMostDetailed(viewer.terrainProvider, [Cartographic.fromDegrees(focus.lon, focus.lat)])
  let tf: TerrainFrame
  let checkText = ''
  const frameMs: number[] = []
  let last = performance.now()
  let infoAt = 0
  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    frameMs.push(now - last)
    if (frameMs.length > 120) frameMs.shift()
    last = now
    tf = topo.update(now)
    const st = sun.update(timeMs, viewer.camera.positionWC)
    if (q.get('buildings') !== '0') buildings.update(focus, tf)
    if (now - infoAt < 300) return
    infoAt = now
    info.textContent = [
      `${scene.what}  ${glass ? 'see-through' : 'solid'}  fps ${(1000 / (frameMs.reduce((a, b) => a + b, 0) / frameMs.length)).toFixed(0)}`,
      `buildings settled ${buildings.settled}  terrain loaded ${viewer.scene.globe.tilesLoaded}  f ${tf.fNow.toFixed(3)}`,
      `sun ${JulianDate.toIso8601(JulianDate.fromDate(new Date(timeMs)), 0)}  elev ${st?.elevDeg.toFixed(1) ?? '—'}°`,
      `long tasks ${longTasks.length}  max ${r1(Math.max(0, ...longTasks))} ms`,
      checkText,
    ].join('\n')
  })

  /** How standing buildings within rM of the focus meet the true terrain (see the header). */
  async function check(rM = 700): Promise<unknown> {
    const mLat = 111_320
    const mLon = 111_320 * Math.cos(CMath.toRadians(focus.lat))
    const all: Footprint[] = []
    for (const [x, y] of tilesAround(focus.lat, focus.lon, rM)) {
      const l = await openFreeMapLayer(x, y)
      if (l) all.push(...footprints(l, x, y))
    }
    const fs = all.filter((f) => f.minHeightM === 0 && Math.hypot((f.rings[0][0][0] - focus.lon) * mLon, (f.rings[0][0][1] - focus.lat) * mLat) < rM).slice(0, 1500)
    // per building: its corner reads, its centre, then points every 4 m along its outer walls
    const plan = fs.map((f) => {
      const ring = f.rings[0]
      const wall: [number, number][] = []
      for (let i = 0; i < ring.length; i++) {
        const [a, b] = [ring[i], ring[(i + 1) % ring.length]]
        const n = Math.max(1, Math.ceil(Math.hypot((b[0] - a[0]) * mLon, (b[1] - a[1]) * mLat) / 4))
        for (let k = 0; k < n; k++) wall.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
      }
      const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length
      const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length
      const w = Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0]))
      const h = Math.max(...ring.map((p) => p[1])) - Math.min(...ring.map((p) => p[1]))
      return { f, corners: groundPoints(f), centre: [lon, lat] as [number, number], wall, radiusM: Math.hypot(w * mLon, h * mLat) / 2 }
    })
    const pts = plan.flatMap((p) => [...p.corners, p.centre, ...p.wall]).map(([lon, lat]) => Cartographic.fromDegrees(lon, lat))
    const t0 = performance.now()
    const hs = (await sampleTerrainMostDetailed(viewer.terrainProvider, pts)).map((c) => c.height)
    const sampleMs = performance.now() - t0
    // the layer's fast reader must give Cesium's heights on the real terrain
    const t1 = performance.now()
    const fast = await new TerrainHeights(viewer.terrainProvider).heights(pts)
    const fastMs = performance.now() - t1
    const readerMaxDiffM = Math.max(...fast.map((h, k) => Math.abs((h ?? NaN) - hs[k])))
    const out = { corner: { float: [] as number[], buried: [] as number[] }, centre: { float: [] as number[], buried: [] as number[] }, drawn: { float: [] as number[], buried: [] as number[] }, dropM: [] as number[] }
    const globe = viewer.scene.globe
    const carto = new Cartographic()
    const worst: { lon: number; lat: number; gapM: number; distM: number; drawnM: number; trueM: number; baseM: number }[] = []
    let i = 0
    for (const p of plan) {
      const corners = hs.slice(i, (i += p.corners.length))
      const centre = hs[i++]
      const wall = hs.slice(i, (i += p.wall.length))
      const lo = Math.min(...wall)
      const hi = Math.max(...wall)
      out.dropM.push(hi - lo)
      const e = extentM(p.f, corners)
      out.corner.float.push(e.baseM - lo) // > 0: the lowest wall point is under the building's base: a gap shows
      out.corner.buried.push(hi - e.topM) // > 0: on the uphill side the roof is under the ground
      // the same walls against the terrain as drawn now (its level of detail at this camera distance)
      // 0.5 m inside the wall: a wall on a tile seam (a building cut by the tile clip) would read Cesium's skirt, ~20 m down
      const inward = ([lon, lat]: [number, number]): [number, number] => {
        const d = Math.hypot((p.centre[0] - lon) * mLon, (p.centre[1] - lat) * mLat) || 1
        return [lon + ((p.centre[0] - lon) * 0.5) / d, lat + ((p.centre[1] - lat) * 0.5) / d]
      }
      const drawn = p.wall.map((w) => inward(w)).map(([lon, lat]) => globe.getHeight(Cartographic.fromDegrees(lon, lat, 0, carto))).filter((h): h is number => h !== undefined)
      if (drawn.length > 0) {
        const k = drawn.indexOf(Math.min(...drawn))
        const at = Cartesian3.fromDegrees(p.wall[k][0], p.wall[k][1], lo)
        worst.push({ lon: p.wall[k][0], lat: p.wall[k][1], gapM: r1(e.baseM - drawn[k]), distM: Math.round(Cartesian3.distance(at, viewer.camera.positionWC)), drawnM: r1(drawn[k]), trueM: r1(wall[k]), baseM: r1(e.baseM) })
        out.drawn.float.push(e.baseM - Math.min(...drawn))
        out.drawn.buried.push(Math.max(...drawn) - e.topM)
      }
      out.centre.float.push(centre - (2 + 0.3 * p.radiusM) - lo)
      out.centre.buried.push(hi - (centre + p.f.heightM))
    }
    const sum = (r: { float: number[]; buried: number[] }): Record<string, number> => ({
      floatOver0_5mPct: r1((100 * r.float.filter((v) => v > 0.5).length) / r.float.length),
      floatOver2mPct: r1((100 * r.float.filter((v) => v > 2).length) / r.float.length),
      floatP95M: r1(pct(r.float, 0.95)),
      floatMaxM: r1(Math.max(...r.float)),
      roofUnderGroundPct: r1((100 * r.buried.filter((v) => v > 0).length) / r.buried.length),
    })
    const report = {
      scene: scene.what, buildings: plan.length, points: pts.length, sampleMs: Math.round(sampleMs), fastMs: Math.round(fastMs), readerMaxDiffM,
      dropAcrossBuildingM: { p50: r1(pct(out.dropM, 0.5)), p90: r1(pct(out.dropM, 0.9)), max: r1(Math.max(...out.dropM)) },
      cornerRule: sum(out.corner), cornerRuleOnDrawnTerrain: { ...sum(out.drawn), walls: out.drawn.float.length },
      worstOnDrawn: worst.sort((a, b) => b.gapM - a.gapM).slice(0, 8), centreRule: sum(out.centre),
    }
    checkText = `check ${JSON.stringify(report)}`.replace(/,"(cornerRule|centreRule|dropAcross)/g, ',\n  "$1')
    console.log('buildings check', report)
    return report
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'x' || e.key === 'X') buildings.setGlass((glass = !glass))
    if (e.key === 't' || e.key === 'T') topo.set(tf.fNow < 0.5, performance.now(), focusGround.height ?? 0)
  })
  ;(window as unknown as { harness: unknown }).harness = {
    viewer, buildings, check,
    stats: () => ({ settled: buildings.settled, tilesLoaded: viewer.scene.globe.tilesLoaded, longTasks: longTasks.length, longMaxMs: Math.max(0, ...longTasks), shaders: (viewer.scene as unknown as { context: { shaderCache: { numberOfShaders: number } } }).context.shaderCache.numberOfShaders }),
  }
  if (q.get('check') === '1') {
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 500))
    while (!(buildings.settled && viewer.scene.globe.tilesLoaded)) await wait()
    await check()
  }
}

main().catch((err: unknown) => {
  info.textContent = `error: ${err instanceof Error ? err.message : String(err)}`
  console.error(err)
})
