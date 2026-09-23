// harness/terrain-sun.ts
// Proof of concept for the terrain + sun feature (not a work package): the real chase model and ChaseCamera fly a level
// circle over Innsbruck (LOWI) on Re:Earth terrain with vertex normals, EOX imagery, NASA GIBS night lights, sun lighting
// from the clock and cast shadows. Everything the plan relies on is measured on screen and in window.poc.
//
// Query: ?time=2026-06-21T06:30:00Z  ?r=6000 (circle radius m)  ?h=2700 (HAE m)  ?topo=0  ?light=0  ?shadow=0
//        ?rel=ground|0 (flatten to the ground under the aircraft, or to the ellipsoid)  ?smDist=20000  ?smSize=2048
//        ?modelExag=1 (let Cesium exaggerate the aircraft too: the bug the PoC found)
//        ?anim=2.5 (grow/sink seconds)  ?nudge=1 (re-trigger the terrain pickers 0.5 s after an animation)  ?eps=1e-5 ("on" = 1 + eps, so exaggeration never returns to exactly 1)  ?at=120 (start this many seconds into the circle)  ?hold=1 (aircraft stands still)
// Keys:  T terrain (animated)  L lighting  S shadows  G globe casts shadows  P time-lapse (600×)
//        [ ] −/+ 1 h   { } −/+ 10 min   N now
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  CesiumTerrainProvider,
  Credit,
  DynamicAtmosphereLightingType,
  Ellipsoid,
  ImageryLayer,
  JulianDate,
  Matrix3,
  Color,
  DirectionalLight,
  ShadowMode,
  Simon1994PlanetaryPositions,
  Transforms,
  UrlTemplateImageryProvider,
  Viewer,
  sampleTerrainMostDetailed,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { ChaseCamera } from '../client/scene/chaseCamera.ts'
import { makeImagery } from '../client/scene/imagery.ts'
import { ChaseModel } from '../client/scene/model.ts'
import { REEARTH_TERRAIN_URL } from '../client/scene/terrain.ts'
import type { ModelManifest, RenderState } from '../client/types.ts'

const q = new URLSearchParams(location.search)
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d)
const LOWI = { lat: 47.2602, lon: 11.3439 }
const RADIUS_M = num('r', 6000) // r=6000 crosses the Nordkette ridge (Hafelekar 2,334 m) on the north side
const H_M = num('h', 2700)
const SPEED_MS = 70
const M_PER_DEG = 111_320
const ANIM_S = num('anim', 2.5)
// Cesium adds geodetic surface normals to every loaded tile when exaggeration leaves 1.0, and strips them when it comes
// back (GlobeSurfaceTile.updateExaggeration). "On" slightly above 1 keeps them, so toggling never rebuilds meshes.
const ON = 1 + num('eps', 0)
const NIGHT_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'

function stateAt(tS: number): RenderState {
  const th = (SPEED_MS / RADIUS_M) * tS
  const e = RADIUS_M * Math.cos(th)
  const n = RADIUS_M * Math.sin(th)
  const headingDeg = ((Math.atan2(-Math.sin(th), Math.cos(th)) * 180) / Math.PI + 360) % 360
  return {
    hex: '440abc', lat: LOWI.lat + n / M_PER_DEG, lon: LOWI.lon + e / (M_PER_DEG * Math.cos((LOWI.lat * Math.PI) / 180)),
    hM: H_M, headingDeg, pitchDeg: 0, rollDeg: -12, gsKt: SPEED_MS / 0.514444, trackDeg: headingDeg, altBaroFt: H_M / 0.3048,
    vsFpm: 0, mode: 'interp', altSource: 'geom', onGround: false, ageS: 1, quality: 'adsb2', callsign: 'HOP1', typeCode: 'A320',
  }
}

const smoothstep = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))

// Unit vector from pos towards the sun (Earth-fixed), from the same ephemeris Cesium's SunLight uses.
const m3 = new Matrix3()
const upV = new Cartesian3()
function toSun(time: JulianDate, pos: Cartesian3, result: Cartesian3): Cartesian3 {
  const toFixed = Transforms.computeIcrfToFixedMatrix(time, m3) ?? Transforms.computeTemeToPseudoFixedMatrix(time, m3)
  Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time, result)
  Matrix3.multiplyByVector(toFixed, result, result)
  return Cartesian3.normalize(Cartesian3.subtract(result, pos, result), result)
}

// Cesium 1.145 ignores ImageryLayer.dayAlpha/nightAlpha once terrain has vertex normals (GlobeSurfaceShaderSet:
// ENABLE_VERTEX_LIGHTING replaces ENABLE_DAYNIGHT_SHADING, and GlobeFS only blends day/night under the latter), and a
// SunLight below the horizon still lights slopes that face it. So the app owns the light: one DirectionalLight whose
// direction follows the sun but never comes from below the horizon, fading to a dim light from overhead at night.
const night01 = (elevDeg: number): number => smoothstep((2 - elevDeg) / 10) // 0 at +2°, 1 at −8° (lights on)
const golden01 = (elevDeg: number): number => smoothstep((15 - elevDeg) / 15) // 0 at +15°, 1 at 0°
const WARM = new Color(1.0, 0.8, 0.62)
const MIN_ELEV = Math.tan((2 * Math.PI) / 180)
const hV = new Cartesian3()
const dirV = new Cartesian3()
function aimLight(light: DirectionalLight, sunDir: Cartesian3, up: Cartesian3, elevDeg: number): number {
  const n = night01(elevDeg)
  // Split into horizontal + vertical, raise the vertical part to ≥ 2° elevation, then blend towards straight up.
  const v = Cartesian3.dot(sunDir, up)
  Cartesian3.subtract(sunDir, Cartesian3.multiplyByScalar(up, v, hV), hV)
  const hLen = Cartesian3.magnitude(hV)
  const vUp = Math.max(v, MIN_ELEV * hLen)
  Cartesian3.add(hV, Cartesian3.multiplyByScalar(up, vUp, dirV), dirV)
  Cartesian3.normalize(dirV, dirV)
  Cartesian3.lerp(dirV, up, n, dirV)
  Cartesian3.normalize(dirV, dirV)
  Cartesian3.negate(dirV, light.direction) // DirectionalLight.direction = where the light travels
  light.intensity = 2.0 + (0.45 - 2.0) * n
  const g = golden01(elevDeg) * (1 - n)
  Color.lerp(Color.WHITE, WARM, g, light.color)
  return n
}

async function main(): Promise<void> {
  const [terrainProvider, day, manifest] = await Promise.all([
    CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL, { requestVertexNormals: true, requestWaterMask: true }),
    makeImagery({ terrain: 'reearth', imagery: 'eox', ionToken: null, apiBase: '/api' }),
    fetch('/models/manifest.json').then((r) => r.json() as Promise<ModelManifest>),
  ])
  const viewer = new Viewer('globe', {
    terrainProvider,
    baseLayer: day ? new ImageryLayer(day) : false,
    timeline: false, animation: false, geocoder: false, baseLayerPicker: false, sceneModePicker: false,
    navigationHelpButton: false, homeButton: false, infoBox: false, selectionIndicator: false, fullscreenButton: false,
    requestRenderMode: false,
  })
  const { scene } = viewer
  const globe = scene.globe
  globe.depthTestAgainstTerrain = true
  // Night: city lights, faded in by the app as the sun sets (see aimLight).
  const night = viewer.imageryLayers.addImageryProvider(
    new UrlTemplateImageryProvider({ url: NIGHT_URL, maximumLevel: 8, credit: new Credit('Night lights: NASA Earth Observatory / GIBS (VIIRS Black Marble 2016)') }),
  )
  night.alpha = 0 // set every frame from the sun elevation (dayAlpha/nightAlpha do nothing with vertex normals)
  scene.atmosphere.dynamicLighting = DynamicAtmosphereLightingType.SUNLIGHT
  globe.dynamicAtmosphereLightingFromSun = true

  let time = q.has('time') ? JulianDate.fromIso8601(q.get('time')!) : JulianDate.now()
  viewer.clock.shouldAnimate = false
  viewer.clock.currentTime = time

  const entry = manifest.models.find((m) => m.id === manifest.default)!
  const model = await ChaseModel.load(viewer, entry)
  // Model.enableVerticalExaggeration defaults to true: Cesium would squash the aircraft towards relH with the terrain
  // (at exaggeration 0 it is flat and invisible). The aircraft keeps its true HAE; only the ground moves.
  if (q.get('modelExag') !== '1') model.model.enableVerticalExaggeration = false
  const chase = new ChaseCamera(viewer)

  // ---------- state + toggles ----------
  const sun = new DirectionalLight({ direction: new Cartesian3(0, 0, -1) })
  scene.light = sun
  const sunDir = new Cartesian3()
  const iblFactor = new Cartesian2(1, 1)
  let nightness = 0
  const opt = {
    topo: q.get('topo') !== '0',
    light: q.get('light') !== '0',
    shadow: q.get('shadow') !== '0',
    globeCasts: true,
    lapse: false,
    relMode: q.get('rel') === '0' ? 'ellipsoid' : 'ground',
  }
  const anim = { from: opt.topo ? ON : 0, to: opt.topo ? ON : 0, t0: 0, running: false, maxFrameMs: 0, frames: 0, sumMs: 0, nullFrames: 0, endAt: null as number | null }
  const nudge = q.get('nudge') === '1'
  scene.verticalExaggeration = anim.to
  const shadowMap = viewer.shadowMap
  shadowMap.softShadows = true
  shadowMap.size = num('smSize', 2048)
  shadowMap.maximumDistance = num('smDist', 20_000)
  shadowMap.darkness = 0.35

  const carto = new Cartographic()
  const aircraftPos = new Cartesian3()
  let groundM: number | null = null // globe.getHeight under the aircraft: the RENDERED (exaggerated) ground
  let trueGroundM: number | null = null // sampleTerrainMostDetailed: the provider's heights, never exaggerated
  let clearanceM: number | null = null
  let s: RenderState = stateAt(0)

  function applyLight(): void {
    globe.enableLighting = opt.light
    viewer.shadows = opt.light && opt.shadow
    globe.shadows = opt.globeCasts ? ShadowMode.ENABLED : ShadowMode.RECEIVE_ONLY
    for (const [id, on] of [['topo', opt.topo], ['light', opt.light], ['shadow', opt.shadow]] as const) {
      document.getElementById(id)!.setAttribute('aria-pressed', String(on))
    }
  }

  function setTopo(on: boolean): void {
    opt.topo = on
    // Flatten around the ground under the aircraft (read while the terrain is still at 1×), so the aircraft keeps its
    // true height above the ground right below it. At exaggeration 1 the relative height changes nothing.
    if (!on && scene.verticalExaggeration >= 1) {
      scene.verticalExaggerationRelativeHeight = opt.relMode === 'ground' && groundM !== null ? groundM : 0
    }
    Object.assign(anim, { from: scene.verticalExaggeration, to: on ? ON : 0, t0: performance.now(), running: true, maxFrameMs: 0, frames: 0, sumMs: 0, nullFrames: 0, endAt: null })
    applyLight()
  }

  const t0S = performance.now() / 1000 - num('at', 0)
  const hold = q.get('hold') === '1'
  let last = performance.now()
  const frameMs: number[] = []
  const info = document.getElementById('info')!
  let infoAt = 0

  scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    const dtMs = now - last
    last = now
    frameMs.push(dtMs)
    if (frameMs.length > 240) frameMs.shift()
    if (opt.lapse) time = JulianDate.addSeconds(time, (dtMs / 1000) * 600, time)
    viewer.clock.currentTime = time

    if (anim.running) {
      const u = (now - anim.t0) / 1000 / ANIM_S
      scene.verticalExaggeration = anim.from + (anim.to - anim.from) * smoothstep(u)
      anim.frames++
      anim.sumMs += dtMs
      anim.maxFrameMs = Math.max(anim.maxFrameMs, dtMs)
      if (u >= 1) {
        anim.running = false
        anim.endAt = now
      }
    }
    // TerrainPicker builds its quadtree on a worker, and every exaggeration change resets it; a worker result that
    // lands after a reset can leave the picker empty, so globe.getHeight returns undefined until the next mesh change.
    // One tiny change once the workers are idle forces a clean rebuild.
    if (nudge && anim.endAt !== null && now - anim.endAt > 500) {
      anim.endAt = null
      scene.verticalExaggeration = anim.to + 1e-7
    }

    s = stateAt(hold ? num('at', 0) : now / 1000 - t0S)
    Cartesian3.fromDegrees(s.lon, s.lat, s.hM, Ellipsoid.WGS84, aircraftPos)
    toSun(time, aircraftPos, sunDir)
    Ellipsoid.WGS84.geodeticSurfaceNormal(aircraftPos, upV)
    const elev = (Math.asin(Cartesian3.dot(sunDir, upV)) * 180) / Math.PI
    nightness = aimLight(sun, sunDir, upV, elev)
    // One blend for the whole view (the terminator moves ~15°/h; a chase view spans < 1°).
    night.alpha = opt.light ? nightness : 0
    night.brightness = 1.6
    // Skylight: raise the ambient floor while the sun is low, so golden hour is warm, not black.
    globe.vertexShadowDarkness = 0.3 + 0.2 * golden01(elev) * (1 - nightness)
    // The model's image-based light does not follow the app's light: dim it at night, or the aircraft glows.
    const ibl = 1 - 0.85 * nightness
    iblFactor.x = iblFactor.y = ibl
    model.model.imageBasedLighting.imageBasedLightingFactor = iblFactor
    if (day) viewer.imageryLayers.get(0).brightness = 1 - 0.7 * nightness
    viewer.shadows = opt.light && opt.shadow && nightness < 0.5
    groundM = globe.getHeight(Cartographic.fromDegrees(s.lon, s.lat, 0, carto)) ?? null
    if (anim.running && groundM === null) anim.nullFrames++
    const placed = { ...s, hM: groundM === null ? s.hM : Math.max(s.hM, groundM) } // app.ts placedHeightM, airborne
    model.update(placed)
    clearanceM = chase.update(placed, Math.min(0.1, dtMs / 1000)).clearanceM

    if (now - infoAt > 250) {
      infoAt = now
      const avg = frameMs.reduce((a, b) => a + b, 0) / frameMs.length
      const worst = Math.max(...frameMs.slice(-60))
      const f = scene.verticalExaggeration
      const expected = trueGroundM === null ? null : (trueGroundM - scene.verticalExaggerationRelativeHeight) * f + scene.verticalExaggerationRelativeHeight
      info.textContent = [
        `fps ${(1000 / avg).toFixed(0)}  worst frame (last 60) ${worst.toFixed(1)} ms`,
        `time ${JulianDate.toIso8601(time, 0)}  sun elev ${elev.toFixed(1)}°  night ${nightness.toFixed(2)}  light ${opt.light} lapse ${opt.lapse}`,
        `shadows ${viewer.shadows} (globe ${opt.globeCasts ? 'casts+receives' : 'receives'}) size ${shadowMap.size} maxDist ${shadowMap.maximumDistance} m`,
        `exaggeration ${f.toFixed(3)}  relH ${scene.verticalExaggerationRelativeHeight.toFixed(1)} m (${opt.relMode})  anim ${anim.running ? 'running' : 'idle'}`,
        `last anim: ${anim.frames} frames, avg ${(anim.sumMs / Math.max(1, anim.frames)).toFixed(1)} ms, worst ${anim.maxFrameMs.toFixed(1)} ms`,
        `aircraft ${s.hM.toFixed(0)} m HAE  ground(rendered) ${groundM?.toFixed(1) ?? '—'}  ground(true) ${trueGroundM?.toFixed(1) ?? '—'}  expected ${expected?.toFixed(1) ?? '—'}`,
        `AGL(rendered) ${groundM === null ? '—' : (placed.hM - groundM).toFixed(0)} m  camera clearance ${clearanceM?.toFixed(1) ?? '—'} m  tilesLoaded ${globe.tilesLoaded}`,
      ].join('\n')
    }
  })

  // True ground under the aircraft, 1 Hz: proves getHeight returns the exaggerated surface.
  setInterval(() => {
    const p = [Cartographic.fromDegrees(s.lon, s.lat)]
    sampleTerrainMostDetailed(terrainProvider, p).then(([c]) => (trueGroundM = c.height), () => (trueGroundM = null))
  }, 1000)

  const shift = (sec: number): void => void (time = JulianDate.addSeconds(time, sec, new JulianDate()))
  window.addEventListener('keydown', (e) => {
    const k = e.key
    if (k === 't' || k === 'T') setTopo(!opt.topo)
    else if (k === 'l' || k === 'L') (opt.light = !opt.light), applyLight()
    else if (k === 's' || k === 'S') (opt.shadow = !opt.shadow), applyLight()
    else if (k === 'g' || k === 'G') (opt.globeCasts = !opt.globeCasts), applyLight()
    else if (k === 'p' || k === 'P') opt.lapse = !opt.lapse
    else if (k === '[') shift(-3600)
    else if (k === ']') shift(3600)
    else if (k === '{') shift(-600)
    else if (k === '}') shift(600)
    else if (k === 'n' || k === 'N') time = JulianDate.now()
  })
  document.getElementById('topo')!.onclick = () => setTopo(!opt.topo)
  document.getElementById('light')!.onclick = () => ((opt.light = !opt.light), applyLight())
  document.getElementById('shadow')!.onclick = () => ((opt.shadow = !opt.shadow), applyLight())
  applyLight()

  ;(window as unknown as { poc: unknown }).poc = {
    viewer, opt, anim, setTopo, applyLight,
    setTime: (iso: string) => void (time = JulianDate.fromIso8601(iso)),
    // Rendered vs provider height at any point: rendered should equal (true − relH)·f + relH.
    probe: async (lat: number, lon: number) => {
      const rendered = globe.getHeight(Cartographic.fromDegrees(lon, lat)) ?? null
      const [c] = await sampleTerrainMostDetailed(terrainProvider, [Cartographic.fromDegrees(lon, lat)])
      const f = scene.verticalExaggeration
      const relH = scene.verticalExaggerationRelativeHeight
      return { rendered, true: c.height, f, relH, expected: (c.height - relH) * f + relH }
    },
    stats: () => ({ fps: 1000 / (frameMs.reduce((a, b) => a + b, 0) / frameMs.length), groundM, trueGroundM, clearanceM, f: scene.verticalExaggeration, relH: scene.verticalExaggerationRelativeHeight, tilesLoaded: globe.tilesLoaded }),
  }
}

main().catch((err: unknown) => {
  document.getElementById('info')!.textContent = `error: ${err instanceof Error ? err.message : String(err)}`
  console.error(err)
})
