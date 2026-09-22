// harness/fleet-layer.ts
// Manual + performance check for WP-B-V1. Open /harness/fleet-layer.html
//   ?n=5000        synthetic aircraft over Europe, moving along their tracks every frame (default 5000)
//   ?h=3000000     camera height in metres, top-down and north-up (default 3,000 km)
//   ?pitch=-90     camera pitch in degrees (e.g. -50 to check the icon rotation in a tilted view)
//   ?bg=light      light land colour like a street map (default) · dark · ne (Natural Earth II bundled with Cesium, no network)
//   ?churn=0.005   fraction of aircraft replaced by new hexes each second (exercises the billboard pool)
//   ?test=compass  12 still aircraft around 50°N 10°E, every nose pointing outward, two of each silhouette
// Hover shows the callsign, click selects (1.4× + ring), Esc clears. window.harness.stats() returns the FPS numbers;
// window.harness.reset() restarts the measurement window.
import {
  Cartesian2,
  Cartesian3,
  Color,
  EllipsoidTerrainProvider,
  ImageryLayer,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  TileMapServiceImageryProvider,
  Viewer,
  buildModuleUrl,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { AircraftInfo } from '../shared/info.ts'
import type { FleetEntry } from '../client/types.ts'
import { FleetLayer } from '../client/scene/fleetLayer.ts'
import { mountLegend } from '../client/ui/legend.ts'

const q = new URLSearchParams(location.search)
const N = Number(q.get('n') ?? 5000)
const HEIGHT_M = Number(q.get('h') ?? 3_000_000)
const PITCH_DEG = Number(q.get('pitch') ?? -90)
const BG = q.get('bg') ?? 'light'
const CHURN = Number(q.get('churn') ?? 0.005)
const COMPASS = q.get('test') === 'compass'
const RAD = Math.PI / 180
const CENTER = { lat: 50, lon: 10 }
const WARMUP_MS = 3_000
const WINDOW = 1_200 // frames kept for the percentiles

async function main(): Promise<void> {
  const viewer = new Viewer('globe', {
    terrainProvider: new EllipsoidTerrainProvider(),
    baseLayer: BG === 'ne' ? new ImageryLayer(await TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII'))) : false,
    baseLayerPicker: false,
    geocoder: false,
    timeline: false,
    animation: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  })
  const scene = viewer.scene
  scene.globe.baseColor = Color.fromCssColorString(BG === 'dark' ? '#1c2331' : '#ece8df')
  scene.globe.showGroundAtmosphere = false
  scene.globe.depthTestAgainstTerrain = true // as the app does
  scene.fog.enabled = false
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(CENTER.lon, CENTER.lat, HEIGHT_M),
    orientation: { heading: 0, pitch: PITCH_DEG * RAD, roll: 0 },
  })

  // Deterministic synthetic traffic.
  let seed = 42
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
  const AIRLINES = ['DLH', 'RYR', 'EZY', 'BAW', 'AFR', 'KLM', 'THY', 'UAE', 'WZZ', 'SAS', 'ELY', 'LOT']
  const FALLBACK_TYPES = ['B738', 'A388', 'C172', 'EC35', 'B77W', 'AT76']
  let nextId = 0

  function makeInfo(hex: string, category: string | null, typeCode: string | null, callsign: string | null): AircraftInfo {
    return { hex, callsign, reg: null, typeCode, category, squawk: null, emergency: null, military: false, route: null }
  }

  function makeEntry(): FleetEntry {
    const hex = (0x400000 + nextId++).toString(16)
    const onGround = rnd() < 0.06
    const u = rnd()
    const altFt = onGround ? null : u < 0.25 ? rnd() * 10_000 : u < 0.45 ? 10_000 + rnd() * 15_000 : 25_000 + rnd() * 18_000
    const c = rnd()
    let category: string | null = c < 0.55 ? 'A3' : c < 0.65 ? 'A1' : c < 0.75 ? 'A2' : c < 0.85 ? 'A5' : c < 0.89 ? 'A7' : c < 0.9 ? 'B1' : null
    let typeCode: string | null = category === null && c < 0.97 ? pick(FALLBACK_TYPES) : null
    if (onGround && rnd() < 0.3) [category, typeCode] = ['C2', null]
    const callsign = rnd() < 0.9 ? `${pick(AIRLINES)}${100 + Math.floor(rnd() * 900)}` : null
    return {
      hex,
      lat: 36 + rnd() * 26,
      lon: -10 + rnd() * 40,
      hM: altFt === null ? 45 : altFt * 0.3048 + 45,
      altFt,
      onGround,
      trackDeg: rnd() * 360,
      gsKt: onGround ? rnd() * 20 : 120 + rnd() * 370,
      vsFpm: !onGround && rnd() < 0.2 ? (rnd() < 0.5 ? -1500 : 1500) : 0,
      ageS: rnd() < 0.01 ? 90 : 1 + rnd() * 4,
      quality: 'adsb2',
      info: makeInfo(hex, category, typeCode, callsign),
    }
  }

  function compass(): FleetEntry[] {
    const kinds: [string | null, string | null][] = [['A3', null], ['A5', null], ['A1', null], ['A7', null], ['C2', null], [null, null]]
    return Array.from({ length: 12 }, (_, i) => {
      const [category, typeCode] = kinds[i % kinds.length]
      const brg = i * 30
      const hex = (0x500000 + i).toString(16)
      const onGround = category === 'C2'
      const altFt = onGround ? null : i * 3_500
      return {
        hex,
        lat: CENTER.lat + 1.2 * Math.cos(brg * RAD),
        lon: CENTER.lon + (1.2 * Math.sin(brg * RAD)) / Math.cos(CENTER.lat * RAD),
        hM: altFt === null ? 45 : altFt * 0.3048 + 45,
        altFt,
        onGround,
        trackDeg: brg,
        gsKt: 0,
        vsFpm: 0,
        ageS: 1,
        quality: 'adsb2',
        info: makeInfo(hex, category, typeCode, `BRG${String(brg).padStart(3, '0')}`),
      } satisfies FleetEntry
    })
  }

  const entries: FleetEntry[] = COMPASS ? compass() : Array.from({ length: N }, makeEntry)

  /** Dead-reckon every aircraft along its track (flat-earth step; reflect at the box edges). Mutates in place. */
  function move(dtS: number): void {
    for (const e of entries) {
      if (!e.gsKt || e.trackDeg === null) continue
      const nm = (e.gsKt * dtS) / 3600
      const tr = e.trackDeg * RAD
      e.lat += (nm * Math.cos(tr)) / 60
      e.lon += (nm * Math.sin(tr)) / (60 * Math.cos(e.lat * RAD))
      if (e.lat < 34 || e.lat > 64) e.trackDeg = (540 - e.trackDeg) % 360
      if (e.lon < -14 || e.lon > 36) e.trackDeg = 360 - e.trackDeg
      if (e.vsFpm && e.altFt !== null) {
        e.altFt = Math.min(43_000, Math.max(500, e.altFt + (e.vsFpm * dtS) / 60))
        e.hM = e.altFt * 0.3048 + 45
      }
    }
  }

  const layer = new FleetLayer(viewer)
  mountLegend(document.getElementById('legend') as HTMLElement)
  let selected: string | null = null
  let hover: string | null = null
  let mouse: Cartesian2 | null = null

  const frameMs: number[] = []
  const updateMs: number[] = []
  let t0 = performance.now()
  let lastFrame = 0
  let lastSim = performance.now()
  let lastChurn = performance.now()
  const pct = (xs: number[], p: number): number => {
    if (xs.length === 0) return NaN
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(p * s.length))]
  }
  const push = (xs: number[], v: number): void => {
    xs.push(v)
    if (xs.length > WINDOW) xs.shift()
  }
  const stats = () => ({
    n: entries.length,
    frames: frameMs.length,
    fpsP50: Math.round(10 * (1000 / pct(frameMs, 0.5))) / 10,
    fpsP5: Math.round(10 * (1000 / pct(frameMs, 0.95))) / 10,
    updateMsP50: Math.round(100 * pct(updateMs, 0.5)) / 100,
    updateMsP95: Math.round(100 * pct(updateMs, 0.95)) / 100,
  })
  const reset = (): void => {
    frameMs.length = 0
    updateMs.length = 0
    t0 = performance.now() - WARMUP_MS
  }

  scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    move(Math.min(0.25, (now - lastSim) / 1000))
    lastSim = now
    if (!COMPASS && CHURN > 0 && now - lastChurn >= 1000) {
      lastChurn = now
      for (let k = Math.round(entries.length * CHURN); k > 0; k--) entries[Math.floor(rnd() * entries.length)] = makeEntry()
    }
    if (mouse) {
      hover = layer.pick(mouse) // at most one pick per frame while the mouse moves
      mouse = null
    }
    const a = performance.now()
    layer.update(entries, selected, hover)
    if (now - t0 > WARMUP_MS) push(updateMs, performance.now() - a)
  })

  const info = document.getElementById('info') as HTMLElement
  scene.postRender.addEventListener(() => {
    const now = performance.now()
    if (lastFrame && now - t0 > WARMUP_MS) push(frameMs, now - lastFrame)
    lastFrame = now
    if (frameMs.length % 30 === 0) {
      const s = stats()
      info.textContent =
        `${s.n} aircraft · ${s.frames} frames\n` +
        `fps p50 ${s.fpsP50} · p5 ${s.fpsP5}\n` +
        `update p50 ${s.updateMsP50} ms · p95 ${s.updateMsP95} ms\n` +
        `selected ${selected ?? '—'} · hover ${hover ?? '—'}`
    }
  })

  const handler = new ScreenSpaceEventHandler(scene.canvas)
  handler.setInputAction((ev: ScreenSpaceEventHandler.MotionEvent) => {
    mouse = Cartesian2.clone(ev.endPosition)
  }, ScreenSpaceEventType.MOUSE_MOVE)
  handler.setInputAction((ev: ScreenSpaceEventHandler.PositionedEvent) => {
    selected = layer.pick(ev.position)
  }, ScreenSpaceEventType.LEFT_CLICK)
  addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') selected = null
  })

  /**
   * Frame cost without the display in the loop (a background tab's rAF is throttled): `frames` synchronous
   * viewer.render() calls, each followed by a 1-pixel readPixels so the GPU work is inside the measurement too.
   */
  function bench(frames = 300): { n: number; msP50: number; msP95: number; fpsP50: number; fpsP5: number; updateMsP50: number } {
    const gl = (scene as unknown as { context: { _gl: WebGL2RenderingContext } }).context._gl
    const px = new Uint8Array(4)
    const ms: number[] = []
    viewer.useDefaultRenderLoop = false
    updateMs.length = 0
    t0 = performance.now() - WARMUP_MS
    for (let i = 0; i < frames; i++) {
      const a = performance.now()
      viewer.render()
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      ms.push(performance.now() - a)
    }
    viewer.useDefaultRenderLoop = true
    const p50 = pct(ms, 0.5)
    const p95 = pct(ms, 0.95)
    const r = (x: number): number => Math.round(x * 100) / 100
    return { n: entries.length, msP50: r(p50), msP95: r(p95), fpsP50: r(1000 / p50), fpsP5: r(1000 / p95), updateMsP50: r(pct(updateMs, 0.5)) }
  }

  ;(window as unknown as { harness: object }).harness = { viewer, layer, entries, stats, reset, bench, select: (hex: string | null) => (selected = hex) }
}

void main()
