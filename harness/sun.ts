// harness/sun.ts
// WP-E2 harness: /harness/sun.html. The chase model holds a point on the PoC's 6 km circle round LOWI (Innsbruck) at
// 2,700 m HAE and the chase camera follows it (drag to orbit, wheel to zoom, double-click to reset). Re:Earth terrain
// with vertex normals, EOX day imagery and the GIBS night layer; Sun lights it all from the sun time.
//   ?sun=2026-09-22T05:00:00Z | +6h | -30m   start time (default now; see parseSunParam)
//   ?at=0      seconds into the circle where the aircraft holds (default 0: 6 km east, heading north: the PoC's view)
//   ?light=0   start with the Sun off (the browse look)
// Keys: [ ] −/+ 1 h   { } −/+ 10 min   P time-lapse ×600 (and clears the hitch log)   L Sun on/off
// window.harness = { viewer, sun, setTime(iso), stats() }
import { Cartesian3, CesiumTerrainProvider, Ellipsoid, ImageryLayer, Resource, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { ChaseCamera } from '../client/scene/chaseCamera.ts'
import { makeImagery } from '../client/scene/imagery.ts'
import { ChaseModel } from '../client/scene/model.ts'
import { makeNightLayer } from '../client/scene/nightLights.ts'
import { Sun, parseSunParam, sunTimeMs, type SunState } from '../client/scene/sun.ts'
import { REEARTH_TERRAIN_URL } from '../client/scene/terrain.ts'
import type { ModelManifest, RenderState } from '../client/types.ts'

const q = new URLSearchParams(location.search)
const LOWI = { lat: 47.2602, lon: 11.3439 }
const RADIUS_M = 6000 // the PoC's circle: its north side crosses the Nordkette ridge (Hafelekar 2,334 m)
const H_M = 2700
const SPEED_MS = 70
const M_PER_DEG = 111_320
const AT_S = Number(q.get('at')) || 0
const HOUR_MS = 3_600_000
const LAPSE = 600

/** The PoC's counter-clockwise circle round LOWI, level. */
function stateAt(tS: number): RenderState {
  const th = (SPEED_MS / RADIUS_M) * tS
  const headingDeg = ((Math.atan2(-Math.sin(th), Math.cos(th)) * 180) / Math.PI + 360) % 360
  return {
    hex: '440abc', lat: LOWI.lat + (RADIUS_M * Math.sin(th)) / M_PER_DEG,
    lon: LOWI.lon + (RADIUS_M * Math.cos(th)) / (M_PER_DEG * Math.cos((LOWI.lat * Math.PI) / 180)),
    hM: H_M, headingDeg, pitchDeg: 0, rollDeg: 0, gsKt: SPEED_MS / 0.514444, trackDeg: headingDeg, altBaroFt: H_M / 0.3048,
    vsFpm: 0, mode: 'interp', altSource: 'geom', onGround: false, ageS: 1, quality: 'adsb2', callsign: 'HOP1', typeCode: 'A320',
  }
}

const iso = (t: number): string => (Math.abs(t) <= 8.64e15 ? new Date(t).toISOString().slice(0, 19) + 'Z' : 'invalid')

async function main(): Promise<void> {
  const [terrainProvider, dayProvider, manifest] = await Promise.all([
    // Normals for slope shading; the query gives normal tiles their own browser-cache key (design D1).
    CesiumTerrainProvider.fromUrl(new Resource({ url: REEARTH_TERRAIN_URL, queryParameters: { extensions: 'octvertexnormals' } }), { requestVertexNormals: true }),
    makeImagery({ terrain: 'reearth', imagery: 'eox', ionToken: null, arcgisKey: null, apiBase: '/api' }),
    fetch('/models/manifest.json').then((r) => r.json() as Promise<ModelManifest>),
  ])
  const day = dayProvider ? new ImageryLayer(dayProvider) : null
  const viewer = new Viewer('globe', {
    terrainProvider, baseLayer: day ?? false,
    timeline: false, animation: false, geocoder: false, baseLayerPicker: false, sceneModePicker: false,
    navigationHelpButton: false, homeButton: false, infoBox: false, selectionIndicator: false, fullscreenButton: false,
    requestRenderMode: false,
  })
  viewer.scene.globe.depthTestAgainstTerrain = true
  const night = makeNightLayer()
  viewer.imageryLayers.add(night)
  const sun = new Sun(viewer, { day, night })
  const model = await ChaseModel.load(viewer, manifest.models.find((m) => m.id === manifest.default)!)
  model.model.enableVerticalExaggeration = false // design D6 (WP-E1 moves it into ChaseModel.load)
  sun.attachModel(model.model)
  let lit = q.get('light') !== '0'
  sun.setEnabled(lit)
  const chase = new ChaseCamera(viewer)
  const s = stateAt(AT_S)
  const aircraftWC = Cartesian3.fromDegrees(s.lon, s.lat, s.hM, Ellipsoid.WGS84)

  let tSunMs = sunTimeMs(Date.now(), parseSunParam(location.search))
  let lapse = false
  let state: SunState | null = null
  let last = performance.now()
  const frameMs: number[] = []
  // Frames over 50 ms since the last P, with the sun elevation: the dusk's shader compiles (the night layer's first draw).
  const hitches: { ms: number; elevDeg: number }[] = []
  const fps = (): number => (1000 * frameMs.length) / frameMs.reduce((a, b) => a + b, 0)
  const info = document.getElementById('info')!
  let infoAt = 0

  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    const dtMs = now - last
    last = now
    frameMs.push(dtMs)
    if (frameMs.length > 240) frameMs.shift()
    if (dtMs > 50 && state !== null && hitches.length < 100) hitches.push({ ms: Math.round(dtMs), elevDeg: Math.round(state.elevDeg * 10) / 10 })
    if (lapse) tSunMs += dtMs * LAPSE
    model.update(s)
    chase.update(s, Math.min(0.1, dtMs / 1000))
    state = sun.update(tSunMs, aircraftWC)
    if (now - infoAt < 250) return
    infoAt = now
    info.textContent = [
      `time   ${iso(tSunMs)}${lapse ? `  time-lapse ×${LAPSE}` : ''}`,
      state === null ? 'sun    —' : `sun    elev ${state.elevDeg.toFixed(1)}°  night ${state.night.toFixed(2)}  golden ${state.golden.toFixed(2)}`,
      `light  ${lit ? 'Sun on' : 'Sun off'}  night layer ${night.show ? `shown, alpha ${night.alpha.toFixed(2)}` : 'hidden'}`,
      `fps    ${fps().toFixed(0)}  worst frame (last 60) ${Math.max(...frameMs.slice(-60)).toFixed(1)} ms  over 50 ms since P ${hitches.length}`,
      'keys   [ ] ±1 h   { } ±10 min   P time-lapse   L Sun',
    ].join('\n')
  })

  window.addEventListener('keydown', (e) => {
    if (e.key === '[') tSunMs -= HOUR_MS
    else if (e.key === ']') tSunMs += HOUR_MS
    else if (e.key === '{') tSunMs -= HOUR_MS / 6
    else if (e.key === '}') tSunMs += HOUR_MS / 6
    else if (e.key === 'p' || e.key === 'P') {
      lapse = !lapse
      hitches.length = 0
    } else if (e.key === 'l' || e.key === 'L') sun.setEnabled((lit = !lit))
  })

  ;(window as unknown as { harness: object }).harness = {
    viewer,
    sun,
    setTime: (t: string) => void (tSunMs = Date.parse(t)),
    stats: () => ({
      time: iso(tSunMs), elevDeg: state?.elevDeg ?? null, night: state?.night ?? null, golden: state?.golden ?? null, lit,
      nightShown: night.show, dayBrightness: day?.brightness ?? null, fps: fps(), worstMs: Math.max(...frameMs.slice(-60)),
      hitches: hitches.slice(),
      tilesLoaded: viewer.scene.globe.tilesLoaded,
    }),
  }
}

main().catch((err: unknown) => {
  document.getElementById('info')!.textContent = `error: ${err instanceof Error ? err.message : String(err)}`
  console.error(err)
})
