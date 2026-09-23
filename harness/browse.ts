// harness/browse.ts
// WP-B-V3 harness: /harness/browse.html starts over LLBG and flies into browse (north-up, top-down, street map).
// B = browse over LLBG, H = browse over the point under the camera, C = leave browse for a low oblique "chase" view
// (street map hidden, tilt unlocked). The panel shows the camera, the view rectangle, the controller locks, how many
// OSM tiles the page has requested, and FPS. Query: ?terrain= / ?imagery= as in the viewer harness, ?instant=1 jumps
// instead of flying, ?points=5000 adds that many coloured points near LLBG (FPS with a crowded view).
import { Cartesian3, Color, Math as CesiumMath, PointPrimitiveCollection, type Viewer } from 'cesium'
import { readConfig } from '../client/config.ts'
import { enterBrowse, exitBrowse, isBrowsing, viewRectangleDeg, viewWidthM } from '../client/scene/browseCamera.ts'
import { makeMapLayer } from '../client/scene/mapLayer.ts'
import { createViewer } from '../client/scene/viewer.ts'

const LLBG = { lat: 32.0114, lon: 34.8867 }
const COLORS = ['darkorange', 'gold', 'limegreen', 'cyan', 'dodgerblue', 'magenta', 'gray'].map((c) => Color.fromCssColorString(c))
const status = document.getElementById('status')!
const q = new URLSearchParams(location.search)
const flyS = q.get('instant') === '1' ? 0 : undefined

/** Contrast check: seven coloured dots in a row east of LLBG, plus ?points=N scattered ones. */
function addPoints(viewer: Viewer, n: number): void {
  const pts = viewer.scene.primitives.add(new PointPrimitiveCollection()) as PointPrimitiveCollection
  COLORS.forEach((color, i) => pts.add({ position: Cartesian3.fromDegrees(LLBG.lon + 0.15 + i * 0.12, LLBG.lat, 3000), color, pixelSize: 9, outlineColor: Color.BLACK, outlineWidth: 1 }))
  for (let i = 0; i < n; i++) {
    const lon = LLBG.lon + (Math.random() - 0.5) * 3
    const lat = LLBG.lat + (Math.random() - 0.5) * 3
    pts.add({ position: Cartesian3.fromDegrees(lon, lat, 1000 + Math.random() * 11000), color: COLORS[i % COLORS.length], pixelSize: 6 })
  }
}

/** Frame intervals from postRender into a fixed ring; p50 and p5 FPS over the last 240 frames. */
function fpsMeter(viewer: Viewer): { fps(): { p50: number; p5: number; frames: number } } {
  const ring = new Float64Array(240)
  const sorted = new Float64Array(240)
  let n = 0
  let last = -1
  viewer.scene.postRender.addEventListener(() => {
    const now = performance.now()
    if (last >= 0) ring[n++ % ring.length] = now - last
    last = now
  })
  return {
    fps() {
      const k = Math.min(n, ring.length)
      if (k === 0) return { p50: 0, p5: 0, frames: 0 }
      sorted.set(ring)
      const s = sorted.subarray(0, k).sort()
      return { p50: 1000 / s[Math.floor(k * 0.5)], p5: 1000 / s[Math.min(k - 1, Math.floor(k * 0.95))], frames: n }
    },
  }
}

try {
  const cfg = readConfig({
    VITE_TERRAIN: q.get('terrain') ?? import.meta.env.VITE_TERRAIN,
    VITE_IMAGERY: q.get('imagery') ?? import.meta.env.VITE_IMAGERY,
    VITE_CESIUM_ION_TOKEN: import.meta.env.VITE_CESIUM_ION_TOKEN,
    VITE_ARCGIS_KEY: import.meta.env.VITE_ARCGIS_KEY,
    VITE_API_BASE: import.meta.env.VITE_API_BASE,
  })
  const viewer = await createViewer('globe', cfg)
  const map = makeMapLayer(viewer)
  addPoints(viewer, Number(q.get('points') ?? 0))
  const meter = fpsMeter(viewer)

  // Count the OSM tiles this page requests (policy check: viewport only, nothing while hidden).
  const osm = { tiles: 0, whileHidden: 0 }
  let hiddenSinceMs: number | null = null
  performance.setResourceTimingBufferSize(10_000)
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!e.name.includes('tile.openstreetmap.org')) continue
      osm.tiles++
      if (hiddenSinceMs !== null && e.startTime >= hiddenSinceMs) osm.whileHidden++
    }
  }).observe({ type: 'resource', buffered: true })

  const browse = (center: { lat: number; lon: number } | null): void => {
    map.show = true
    hiddenSinceMs = null
    enterBrowse(viewer, center, { flyS })
  }
  const chase = (): void => {
    exitBrowse(viewer)
    map.show = false
    hiddenSinceMs = performance.now()
    // Stand-in for the chase camera: low and oblique over LLBG's runway 30, looking along it.
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(34.905, 31.995, 700),
      orientation: { heading: CesiumMath.toRadians(300), pitch: CesiumMath.toRadians(-12), roll: 0 },
    })
  }
  document.getElementById('browse')!.onclick = () => browse(LLBG)
  document.getElementById('here')!.onclick = () => browse(null)
  document.getElementById('chase')!.onclick = chase
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase()
    if (k === 'b') browse(LLBG)
    else if (k === 'h') browse(null)
    else if (k === 'c') chase()
  })

  // Start as the app does (60 km over the hero airport, straight down), then fly into browse.
  viewer.camera.setView({ destination: Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, 60_000) })
  browse(LLBG)

  const sscc = viewer.scene.screenSpaceCameraController
  const f1 = (x: number): string => x.toFixed(1)
  const f3 = (x: number): string => x.toFixed(3)
  setInterval(() => {
    const cam = viewer.camera
    const c = cam.positionCartographic
    const r = viewRectangleDeg(viewer)
    // East-west span of the rectangle at its middle latitude (west > east wraps the antimeridian).
    const spanDeg = r ? (r.east - r.west + 360) % 360 || 360 : 0
    const widthKm = r ? (CesiumMath.toRadians(spanDeg) * 6_378.137 * Math.cos(CesiumMath.toRadians((r.north + r.south) / 2))) : null
    const fps = meter.fps()
    status.textContent = [
      `mode      ${isBrowsing(viewer) ? 'browse' : 'chase view'}   map.show ${map.show}`,
      `camera    lat ${f3(CesiumMath.toDegrees(c.latitude))} lon ${f3(CesiumMath.toDegrees(c.longitude))} h ${(c.height / 1000).toFixed(2)} km`,
      `          heading ${f1(CesiumMath.toDegrees(cam.heading))}° pitch ${f1(CesiumMath.toDegrees(cam.pitch))}° roll ${f1(CesiumMath.toDegrees(cam.roll))}°`,
      `rect      ${r ? `W ${f3(r.west)} S ${f3(r.south)} E ${f3(r.east)} N ${f3(r.north)}` : 'null'}`,
      `width     rect ${widthKm === null ? '—' : widthKm.toFixed(0)} km (mid-lat)   viewWidthM(h) ${(viewWidthM(c.height) / 1000).toFixed(0)} km`,
      `controls  tilt ${sscc.enableTilt} look ${sscc.enableLook} zoom ${sscc.minimumZoomDistance}…${sscc.maximumZoomDistance} m`,
      `osm tiles ${osm.tiles} requested, ${osm.whileHidden} while hidden   globe tilesLoaded ${viewer.scene.globe.tilesLoaded}`,
      `fps       p50 ${f1(fps.p50)}  p5 ${f1(fps.p5)}  (last ${Math.min(fps.frames, 240)} of ${fps.frames} frames)`,
    ].join('\n')
  }, 250)

  ;(window as unknown as { harness: object }).harness = { viewer, map, osm, fps: meter.fps, enterBrowse, exitBrowse, isBrowsing, viewRectangleDeg, browse, chase }
} catch (err) {
  status.textContent = `error: ${(err as Error).message}`
  status.style.color = '#ff8080'
}
