// harness/chase-camera.ts
// Manual check for WP-V4: a synthetic aircraft flies a descending 2.5 km circle over LOWI (Innsbruck, Inn valley)
// and the chase camera follows it over Re:Earth terrain (keyless; ?terrain=ellipsoid forces the fallback).
// The overlay shows clearance (camera height − terrain height) and counts frames below 15 m. Press R to release / re-chase.
// ?t=380 starts 380 s into the loop (hM ≈ 920 m HAE, near the bottom), where the clearance logic works hardest.
import { Cartesian3, CesiumTerrainProvider, Color, Credit, EllipsoidTerrainProvider, JulianDate, PointPrimitiveCollection, Viewer } from 'cesium'
import type { TerrainProvider } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { RenderState } from '../client/types.ts'
import { ChaseCamera } from '../client/scene/chaseCamera.ts'

const LOWI = { lat: 47.2602, lon: 11.3439 }
const REEARTH_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid' // WGS84 ellipsoidal heights, as the scene needs
const REEARTH_CREDIT = 'Re:Earth Terrain · Mapterhorn (CC BY 4.0)'
const RADIUS_M = 2500
const SPEED_MS = 70
const TOP_M = 3200
const SINK_MS = 6
const LOOP_S = 415 // 3200 m → 710 m HAE (about 80 m above the valley floor at LOWI), then start over
const M_PER_DEG = 111_320

async function loadTerrain(): Promise<{ provider: TerrainProvider; name: string }> {
  if (new URLSearchParams(location.search).get('terrain') === 'ellipsoid') return { provider: new EllipsoidTerrainProvider(), name: 'ellipsoid' }
  try {
    const provider = await CesiumTerrainProvider.fromUrl(REEARTH_URL, { requestVertexNormals: true, credit: new Credit(REEARTH_CREDIT) })
    return { provider, name: 'reearth' }
  } catch (err) {
    console.warn('Re:Earth terrain unavailable; falling back to the ellipsoid', err)
    return { provider: new EllipsoidTerrainProvider(), name: 'ellipsoid (Re:Earth failed)' }
  }
}

/** Counter-clockwise descending circle centred on LOWI. */
function stateAt(tS: number): RenderState {
  const t = tS % LOOP_S
  const th = (SPEED_MS / RADIUS_M) * t
  const e = RADIUS_M * Math.cos(th)
  const n = RADIUS_M * Math.sin(th)
  const headingDeg = ((Math.atan2(-Math.sin(th), Math.cos(th)) * 180) / Math.PI + 360) % 360
  return {
    hex: '440abc',
    lat: LOWI.lat + n / M_PER_DEG,
    lon: LOWI.lon + e / (M_PER_DEG * Math.cos((LOWI.lat * Math.PI) / 180)),
    hM: TOP_M - SINK_MS * t,
    headingDeg,
    pitchDeg: (Math.atan2(-SINK_MS, SPEED_MS) * 180) / Math.PI,
    rollDeg: 0,
    gsKt: SPEED_MS / 0.514444,
    trackDeg: headingDeg,
    altBaroFt: (TOP_M - 48 - SINK_MS * t) / 0.3048,
    vsFpm: (-SINK_MS / 0.3048) * 60,
    mode: 'interp',
    altSource: 'geom',
    onGround: false,
    ageS: 1,
    quality: 'adsb2',
    callsign: 'HOP1',
    typeCode: 'A320',
  }
}

async function main(): Promise<void> {
  const terrain = await loadTerrain()
  const t0S = Number(new URLSearchParams(location.search).get('t') ?? 0) - performance.now() / 1000
  const viewer = new Viewer('globe', {
    terrainProvider: terrain.provider,
    baseLayer: false,
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
  // No imagery here: sun shading on a neutral base colour makes the relief readable.
  viewer.scene.globe.baseColor = Color.fromCssColorString('#8d927f')
  viewer.scene.globe.enableLighting = true
  viewer.scene.globe.depthTestAgainstTerrain = true
  viewer.clock.currentTime = JulianDate.fromIso8601('2026-06-21T10:30:00Z')
  viewer.clock.shouldAnimate = false

  const marker = viewer.scene.primitives.add(new PointPrimitiveCollection()).add({ pixelSize: 10, color: Color.RED, outlineColor: Color.WHITE, outlineWidth: 2 })
  const chase = new ChaseCamera(viewer)
  const stats = { frames: 0, violations: 0, unknown: 0, minClearanceM: Number.POSITIVE_INFINITY, lastClearanceM: null as number | null }
  let chasing = true
  let last = performance.now()
  const info = document.getElementById('info') as HTMLElement

  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    const dtS = Math.min(0.1, (now - last) / 1000)
    last = now
    const s = stateAt(t0S + now / 1000)
    marker.position = Cartesian3.fromDegrees(s.lon, s.lat, s.hM)
    if (chasing) {
      const { clearanceM } = chase.update(s, dtS)
      stats.frames++
      stats.lastClearanceM = clearanceM
      if (clearanceM === null) stats.unknown++
      else {
        stats.minClearanceM = Math.min(stats.minClearanceM, clearanceM)
        if (clearanceM < 15) stats.violations++
      }
    }
    info.textContent = [
      `terrain    ${terrain.name}`,
      `aircraft   hM ${s.hM.toFixed(0)} m  hdg ${s.headingDeg.toFixed(0)}°`,
      `clearance  ${stats.lastClearanceM === null ? 'terrain not loaded' : `${stats.lastClearanceM.toFixed(1)} m`}`,
      `min        ${Number.isFinite(stats.minClearanceM) ? `${stats.minClearanceM.toFixed(1)} m` : '—'}`,
      `frames     ${stats.frames}  < 15 m: ${stats.violations}  unknown: ${stats.unknown}`,
      `R          ${chasing ? 'release camera' : 'chase again'}`,
    ].join('\n')
  })

  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'r' && ev.key !== 'R') return
    chasing = !chasing
    if (!chasing) chase.release()
  })

  ;(window as unknown as { harness: object }).harness = { viewer, chase, stats, stateAt, terrain: terrain.name }
}

void main()
