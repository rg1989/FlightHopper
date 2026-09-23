// harness/lod.ts
// Headless measurement of the chase view's level of detail: (1) tiles evicted and loaded again when the camera looks away
// and back, (2) coarse ("blurry") tiles drawn while their own detail loads, and how abruptly it then pops in.
// The scene is the app's own: createViewer (Re:Earth terrain, forced: the keyless one the app uses; base imagery from the
// Vite env as client/main.ts builds it, or ?imagery=eox), the
// night-lights layer, the hidden street map, Topography, the Sun (on, as in chase with the sun toggle), the 3-D buildings
// and the ChaseCamera. So a later change under client/scene/ shows here unchanged. The aircraft is a synthetic point.
// URL params (all optional):
//   ?lat=&lon=     start point (default: over Patscherkofel, south-east of LOWI)     ?hdg=   aircraft heading, degrees
//   ?agl=300       height above the true ground (sampleTerrainMostDetailed)           ?alt=   height above the ellipsoid instead
//   ?freeze=1      the aircraft never moves            ?hold=1  it waits for __lod.go()     ?speed=90  m/s along hdg
//   ?tileCache=auto|N  globe.tileCacheSize through ViewerOpts (default auto, as the app; 100 = Cesium's own default)
//   ?fade=0        no imagery cross-fade (imageryFade.ts; default 1, as the app)   ?sse=N  globe.maximumScreenSpaceError (2)
//   ?sun=<ISO>     the sun's time (default 2026-09-22T09:30:00Z, mid-morning)       ?buildings=0  no 3-D buildings
//   ?imagery=eox   force the keyless imagery          ?range=150 ?pitch=-12  initial orbit          ?hud=0  no overlay
//   ?scan=0        no per-frame blur-debt scan (to measure the harness's own cost)
// window.__lod: stats() (with imageryFade.stats() as .fade), timeline(), resetCounters(), setOrbit(h, p, r), orbitBy(deg, ms),
// waitIdle(ms), go(), viewer, swapBaseLayer() (base imagery → a new EOX layer at the same index, as imagery.ts
// eoxOnEsriFailure does at runtime: tests the fade's layer-removal release; returns the fade stats before and after),
// toggleTopo() (the T key: flatten or grow the relief, the flat plane at the ground under the aircraft as app.ts latches it;
// resolves when the TOPO_ANIM_MS animation ends, with the frame times over it), toggleMap() (show or hide the street map,
// as app.ts does on every chase ↔ browse switch: Cesium walks every loaded tile; resolves after 1 s with the frame times),
// capture(everyMs, count), captures(), shotData(i) (timed frame grabs, labelled), clock() (the sun time), chase (the camera).
import { Cartesian3, Cartographic, Color, ImageryLayer, JulianDate, PointPrimitiveCollection, sampleTerrainMostDetailed } from 'cesium'
import type { ImageryProvider, Viewer } from 'cesium'
import { readConfig } from '../client/config.ts'
import { ChaseCamera } from '../client/scene/chaseCamera.ts'
import { eoxOnEsriFailure, eoxProvider } from '../client/scene/imagery.ts'
import { imageryFade } from '../client/scene/imageryFade.ts'
import { makeMapLayer } from '../client/scene/mapLayer.ts'
import { makeNightLayer } from '../client/scene/nightLights.ts'
import { Buildings } from '../client/scene/buildings.ts'
import { Sun, parseSunParam, sunTimeMs } from '../client/scene/sun.ts'
import { Topography, groundMemo } from '../client/scene/topography.ts'
import { createViewer } from '../client/scene/viewer.ts'
import type { RenderState, TerrainFrame } from '../client/types.ts'

const q = new URLSearchParams(location.search)
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d)
const START = { lat: num('lat', 47.2085), lon: num('lon', 11.4185) } // 3 km west of the Patscherkofel summit, over its flank
const HDG = num('hdg', 95)
const AGL_M = num('agl', 300)
const FREEZE = q.get('freeze') === '1'
const HOLD = q.get('hold') === '1'
const SPEED_MS = FREEZE ? 0 : num('speed', 90)
const HUD = q.get('hud') !== '0'
const SCAN = q.get('scan') !== '0' // ?scan=0: no per-frame blur scan (to measure the harness's own cost)
const FADE = q.get('fade') !== '0'
const TILE_CACHE: 'auto' | number = !q.has('tileCache') || q.get('tileCache') === 'auto' ? 'auto' : num('tileCache', 100)
const M_PER_DEG = 111_320
const PROFILE_STEP_M = 50
const PROFILE_LEN_M = Math.max(2000, SPEED_MS * 150) // the flight path whose ground is sampled up front
const LOOK_BACK_M = 400 // the terrain-following height is the highest ground this far behind …
const LOOK_AHEAD_M = 900 // … to this far ahead, plus agl, smoothed
const SMOOTH_M = 600

// Cesium internal enum values (ImageryState, QuadtreeTileLoadState, TerrainState in @cesium/engine/Source/Scene).
const IMG_FAILED = 5
const IMG_INVALID = 6
const TILE_DONE = 2
const TERRAIN_READY = 6

/* eslint-disable @typescript-eslint/no-explicit-any -- the counters read Cesium's private tile structures */
type Any = any

function pathPoint(sM: number): { lat: number; lon: number } {
  const h = (HDG * Math.PI) / 180
  return {
    lat: START.lat + (sM * Math.cos(h)) / M_PER_DEG,
    lon: START.lon + (sM * Math.sin(h)) / (M_PER_DEG * Math.cos((START.lat * Math.PI) / 180)),
  }
}

/** Heights (HAE) the aircraft flies at every PROFILE_STEP_M along its path: a smoothed terrain-following line. */
async function flightProfile(viewer: Viewer): Promise<{ ground: number[]; fly: number[] }> {
  const n = Math.ceil(PROFILE_LEN_M / PROFILE_STEP_M) + 1
  const pts = Array.from({ length: n }, (_, i) => {
    const p = pathPoint(i * PROFILE_STEP_M)
    return Cartographic.fromDegrees(p.lon, p.lat)
  })
  const ground = (await sampleTerrainMostDetailed(viewer.terrainProvider, pts)).map((c) => c.height)
  if (q.has('alt')) return { ground, fly: ground.map(() => num('alt', 0)) }
  const back = LOOK_BACK_M / PROFILE_STEP_M
  const ahead = LOOK_AHEAD_M / PROFILE_STEP_M
  const env = ground.map((_, i) => Math.max(...ground.slice(Math.max(0, i - back), i + ahead + 1)) + AGL_M)
  const w = SMOOTH_M / PROFILE_STEP_M / 2
  const fly = env.map((_, i) => {
    const s = env.slice(Math.max(0, i - w), i + w + 1)
    return Math.max(ground[i] + AGL_M, s.reduce((a, b) => a + b, 0) / s.length)
  })
  return { ground, fly }
}

function profileAt(profile: number[], sM: number): number {
  const x = Math.min(profile.length - 1.001, sM / PROFILE_STEP_M)
  const i = Math.floor(x)
  return profile[i] + (profile[i + 1] - profile[i]) * (x - i)
}

const pct = (sorted: number[], p: number): number | null => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null)
const r1 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10)
interface Pcts { p50: number | null; p95: number | null; max: number | null }

async function main(): Promise<void> {
  const env = { ...import.meta.env, VITE_TERRAIN: 'reearth', VITE_IMAGERY: q.get('imagery') ?? import.meta.env.VITE_IMAGERY }
  const cfg = readConfig(env as unknown as Record<string, string | undefined>)
  const viewer = await createViewer('globe', cfg, { tileCache: TILE_CACHE, fade: FADE })
  const { scene } = viewer
  const globe = scene.globe
  if (q.has('sse')) globe.maximumScreenSpaceError = num('sse', 2)

  // As app.ts wires the chase view: topography on, city lights above the day layer, the street map hidden, the Sun on.
  let imagerySource: string = cfg.imagery
  const topo = new Topography(scene, true)
  let day: ImageryLayer | null = viewer.imageryLayers.length > 0 ? viewer.imageryLayers.get(0) : null
  const night = makeNightLayer()
  viewer.imageryLayers.add(night)
  const sun = new Sun(viewer, { day, night })
  if (cfg.imagery === 'esri' && day) {
    eoxOnEsriFailure(viewer.imageryLayers, day, (eox, why) => {
      console.warn(`lod harness: Esri → EOX (${why})`)
      sun.setDay(eox)
      day = eox
      wrapImagery(eox.imageryProvider)
      imagerySource = `eox (${why})`
    })
  }
  sun.setEnabled(true)
  const map = makeMapLayer(viewer)
  map.show = false
  const sunParam = parseSunParam(q.has('sun') ? location.search : '?sun=2026-09-22T09:30:00Z')
  const buildings = q.get('buildings') === '0' ? null : new Buildings(viewer)
  const { ground: groundProfile, fly: profile } = await flightProfile(viewer)

  const marker = scene.primitives.add(new PointPrimitiveCollection()).add({ pixelSize: 8, color: Color.RED, outlineColor: Color.WHITE, outlineWidth: 2 })
  const camGround = groundMemo()
  let tf: TerrainFrame = { fSampled: 1, fNow: 1, relHM: 0 }
  const chase = new ChaseCamera(viewer, { groundAt: (c) => topo.ground(globe.getHeight(c), tf, camGround, c) })
  chase.orbit.set(0, num('pitch', -12), num('range', 150))

  // ---------- counters ----------
  const surface: Any = (globe as Any)._surface
  const resident = new Set<string>() // tiles DONE and not freed since
  const freed = new Set<string>() // tiles freed after being DONE, not loaded again yet
  const everDone = new Set<string>()
  const terrainResident = new Set<string>()
  const terrainFreed = new Set<string>()
  const imgFetched = new Set<string>()
  const c = {
    tilesLoadedTotal: 0, // QuadtreeTile LOADING → DONE (terrain and all imagery), every time, reloads included
    tileReloads: 0, // … of a tile that was DONE before and then freed
    tilesFreed: 0, // freeResources on a tile that was DONE
    terrainReadyTotal: 0, // terrain mesh reached READY (renderable geometry)
    terrainReloads: 0,
    imageryRequests: 0, // base layer requestImage calls that started a request
    imageryRerequests: 0, // … for a tile already fetched once
    imageryDistinct: 0,
    imageryFailed: 0, // 404 (no deeper tile) and errors
    peakReplacementQueue: 0,
    peakTilesToRender: 0,
    imageryPops: 0, // a drawn tile's base imagery replaced by a sharper one
    imageryPopLevels: 0, // … summed level gain (1 = twice as sharp)
    maxPopLevels: 0,
    refines: 0, // a drawn tile replaced by its children in one frame
    coarsens: 0, // children replaced by their parent
  }
  const key = (t: Any): string => `${t.level}/${t.x}/${t.y}`

  const provider: Any = surface.tileProvider
  const loadTile = provider.loadTile.bind(provider)
  provider.loadTile = (frameState: unknown, tile: Any): void => {
    const before = tile.state
    const terrainBefore = tile.data?.terrainState
    loadTile(frameState, tile)
    const k = key(tile)
    if (terrainBefore !== TERRAIN_READY && tile.data?.terrainState === TERRAIN_READY) {
      c.terrainReadyTotal++
      if (terrainFreed.delete(k)) c.terrainReloads++
      terrainResident.add(k)
    }
    if (before !== TILE_DONE && tile.state === TILE_DONE) {
      c.tilesLoadedTotal++
      if (freed.delete(k)) c.tileReloads++
      resident.add(k)
      everDone.add(k)
    }
  }
  let freeHooked = false
  function hookFree(): void {
    const tiles: Any[] | undefined = surface._levelZeroTiles
    if (freeHooked || !tiles?.length) return
    freeHooked = true
    const proto = Object.getPrototypeOf(tiles[0])
    const free = proto.freeResources
    proto.freeResources = function (this: Any): void {
      const k = key(this)
      if (resident.delete(k)) {
        c.tilesFreed++
        freed.add(k)
      }
      if (terrainResident.delete(k)) terrainFreed.add(k)
      free.call(this)
    }
  }

  const wrapped = new WeakSet<object>()
  function wrapImagery(p: ImageryProvider): void {
    if (wrapped.has(p)) return
    wrapped.add(p)
    const requestImage = p.requestImage.bind(p)
    ;(p as Any).requestImage = (x: number, y: number, level: number, request?: unknown) => {
      const r = requestImage(x, y, level, request as never)
      if (r === undefined) return r // throttled: Cesium asks again later
      const k = `${level}/${x}/${y}`
      c.imageryRequests++
      if (imgFetched.has(k)) c.imageryRerequests++
      else {
        imgFetched.add(k)
        c.imageryDistinct++
      }
      Promise.resolve(r).catch(() => c.imageryFailed++)
      return r
    }
  }
  if (day) wrapImagery(day.imageryProvider)

  // Per frame (postRender): what was drawn, with what imagery; frame times.
  const lastLevel = new WeakMap<object, number>() // TileImagery → level of the imagery it drew last frame
  let lastDrawn = new Set<Any>()
  const frameMs: number[] = []
  const cpuMs: number[] = []
  let tPre = 0
  let tLastPost: number | null = null
  let frame: Frame = zeroFrame()
  let sec: Second | null = null
  let timeline: Second[] = []
  let t0Reset = performance.now()

  interface Frame { blurTiles: number; noImagery: number; blurLevels: number; maxGap: number; waiting: number; drawn: number; maxLevel: number; high: number }
  interface Second { t: number; frames: number; blurTilesAvg: number; blurTilesMax: number; blurLevelsAvg: number; maxGap: number; noImageryMax: number; waitingAvg: number; drawnAvg: number; maxLevel: number; highQueueMax: number; tilesDone: number; imageryRequests: number; imageryPops: number; imageryPopLevels: number; refines: number; frameMsMax: number; sums: { blur: number; lv: number; wait: number; drawn: number } }
  function zeroFrame(): Frame { return { blurTiles: 0, noImagery: 0, blurLevels: 0, maxGap: 0, waiting: 0, drawn: 0, maxLevel: 0, high: 0 } }

  function scan(): void {
    const tiles: Any[] = surface._tilesToRender
    const f = zeroFrame()
    f.drawn = tiles.length
    f.waiting = surface._debug.tilesWaitingForChildren
    f.high = surface._tileLoadQueueHigh.length
    const drawn = new Set<Any>()
    const newParents = new Set<Any>()
    for (const t of tiles) {
      drawn.add(t)
      if (t.level > f.maxLevel) f.maxLevel = t.level
      if (!lastDrawn.has(t) && t.parent && lastDrawn.has(t.parent)) newParents.add(t.parent)
      if (!lastDrawn.has(t) && !(t.parent && lastDrawn.has(t.parent))) {
        // a parent drawn now whose children were drawn last frame
        for (const ch of [t._southwestChild, t._southeastChild, t._northwestChild, t._northeastChild]) if (ch && lastDrawn.has(ch)) { c.coarsens++; break }
      }
      const imgs: Any[] = t.data?.imagery ?? []
      let blurred = false
      let none = false
      let gap = 0
      for (const ti of imgs) {
        const layer = (ti.loadingImagery ?? ti.readyImagery)?.imageryLayer
        if (!layer || layer !== day) continue
        const want = ti.loadingImagery
        const have = ti.readyImagery
        if (want && want.state !== IMG_FAILED && want.state !== IMG_INVALID) {
          blurred = true
          if (!have) none = true
          gap = Math.max(gap, want.level - (have ? have.level : want.level))
        }
        if (have) {
          const prev = lastLevel.get(ti)
          if (prev !== undefined && have.level > prev) {
            c.imageryPops++
            c.imageryPopLevels += have.level - prev
            c.maxPopLevels = Math.max(c.maxPopLevels, have.level - prev)
            if (sec) { sec.imageryPops++; sec.imageryPopLevels += have.level - prev }
          }
          lastLevel.set(ti, have.level)
        }
      }
      if (blurred) f.blurTiles++
      if (none) f.noImagery++
      f.blurLevels += gap
      f.maxGap = Math.max(f.maxGap, gap)
    }
    c.refines += newParents.size
    if (sec) sec.refines += newParents.size
    lastDrawn = drawn
    frame = f
    c.peakReplacementQueue = Math.max(c.peakReplacementQueue, surface._tileReplacementQueue.count)
    c.peakTilesToRender = Math.max(c.peakTilesToRender, tiles.length)
  }

  function newSecond(t: number): Second {
    return { t, frames: 0, blurTilesAvg: 0, blurTilesMax: 0, blurLevelsAvg: 0, maxGap: 0, noImageryMax: 0, waitingAvg: 0, drawnAvg: 0, maxLevel: 0, highQueueMax: 0, tilesDone: c.tilesLoadedTotal, imageryRequests: c.imageryRequests, imageryPops: 0, imageryPopLevels: 0, refines: 0, frameMsMax: 0, sums: { blur: 0, lv: 0, wait: 0, drawn: 0 } }
  }
  function closeSecond(s: Second): void {
    const n = Math.max(1, s.frames)
    s.blurTilesAvg = +(s.sums.blur / n).toFixed(1)
    s.blurLevelsAvg = +(s.sums.lv / n).toFixed(1)
    s.waitingAvg = +(s.sums.wait / n).toFixed(1)
    s.drawnAvg = +(s.sums.drawn / n).toFixed(0)
    s.tilesDone = c.tilesLoadedTotal - s.tilesDone
    s.imageryRequests = c.imageryRequests - s.imageryRequests
    s.frameMsMax = +s.frameMsMax.toFixed(1)
    timeline.push(s)
  }

  interface Shot extends Frame { tMs: number; bitmap: Promise<ImageBitmap>; loads: number; pops: number; refines: number; fading: number }
  let shots: { t0: number; nextAt: number; everyMs: number; count: number; list: Shot[] } | null = null
  /** The i-th capture as a PNG data URL, labelled with its time and the frame's blur debt. */
  async function shotData(i: number): Promise<string> {
    const sh = shots!.list[i]
    const bmp = await sh.bitmap
    const cv = new OffscreenCanvas(bmp.width, bmp.height)
    const g = cv.getContext('2d')!
    g.drawImage(bmp, 0, 0)
    g.fillStyle = 'rgba(0,0,0,0.6)'
    g.fillRect(0, 0, 600, 26)
    g.fillStyle = '#fff'
    g.font = '14px ui-monospace, monospace'
    g.fillText(`t ${(sh.tMs / 1000).toFixed(2)} s  blur ${sh.blurTiles} tiles  waiting ${sh.waiting}  pops ${sh.pops}  fading ${sh.fading}`, 8, 18)
    const blob = await cv.convertToBlob({ type: 'image/png' })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    for (let k = 0; k < buf.length; k += 0x8000) bin += String.fromCharCode(...buf.subarray(k, k + 0x8000))
    return btoa(bin)
  }

  scene.postRender.addEventListener(() => {
    const now = performance.now()
    hookFree()
    if (SCAN) scan()
    if (shots && now >= shots.nextAt && shots.list.length < shots.count) {
      // A snapshot of the frame just drawn: same task as the render, so the drawing buffer still holds it (no
      // preserveDrawingBuffer); the PNG is encoded later, off the render path.
      shots.list.push({ tMs: Math.round(now - shots.t0), bitmap: createImageBitmap(scene.canvas), ...frame, loads: c.tilesLoadedTotal, pops: c.imageryPops, refines: c.refines, fading: imageryFade.stats().active })
      shots.nextAt += shots.everyMs
    }
    if (tLastPost !== null) frameMs.push(now - tLastPost)
    cpuMs.push(now - tPre)
    tLastPost = now
    const tS = Math.floor((now - t0Reset) / 1000)
    if (!sec || tS !== sec.t) {
      if (sec) closeSecond(sec)
      sec = newSecond(tS)
    }
    const f = frame
    sec.frames++
    sec.sums.blur += f.blurTiles
    sec.sums.lv += f.blurLevels
    sec.sums.wait += f.waiting
    sec.sums.drawn += f.drawn
    sec.blurTilesMax = Math.max(sec.blurTilesMax, f.blurTiles)
    sec.maxGap = Math.max(sec.maxGap, f.maxGap)
    sec.noImageryMax = Math.max(sec.noImageryMax, f.noImagery)
    sec.maxLevel = Math.max(sec.maxLevel, f.maxLevel)
    sec.highQueueMax = Math.max(sec.highQueueMax, f.high)
    if (frameMs.length) sec.frameMsMax = Math.max(sec.frameMsMax, frameMs[frameMs.length - 1])
  })

  // ---------- the aircraft, the camera, the sun ----------
  let tGoMs: number | null = FREEZE || HOLD ? null : performance.now()
  let orbitAnim: { from: number; deg: number; t0: number; ms: number; done: () => void } | null = null
  let last = performance.now()
  let s: RenderState = stateAt(0)
  let sNow = 0 // metres flown
  const info = document.getElementById('info') as HTMLElement
  if (!HUD) info.style.display = 'none'
  let lastHud = 0

  function stateAt(sM: number): RenderState {
    const p = pathPoint(sM)
    return {
      hex: '440abc', lat: p.lat, lon: p.lon, hM: profileAt(profile, sM), headingDeg: HDG, pitchDeg: 0, rollDeg: 0,
      gsKt: SPEED_MS / 0.514444, trackDeg: HDG, altBaroFt: null, vsFpm: 0, mode: 'interp', altSource: 'geom',
      onGround: false, ageS: 1, quality: 'adsb2', callsign: 'LOD1', typeCode: 'A320',
    }
  }

  scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    tPre = now
    tf = topo.update(now)
    const dtS = Math.min(0.1, (now - last) / 1000)
    last = now
    const sM = tGoMs === null ? 0 : (SPEED_MS * (now - tGoMs)) / 1000
    sNow = sM
    s = stateAt(sM)
    if (orbitAnim) {
      const u = Math.min(1, (now - orbitAnim.t0) / orbitAnim.ms)
      chase.orbit.set(orbitAnim.from + orbitAnim.deg * u, chase.orbit.pitchDeg, chase.orbit.rangeM)
      if (u >= 1) {
        const done = orbitAnim.done
        orbitAnim = null
        done()
      }
    }
    const at = Cartesian3.fromDegrees(s.lon, s.lat, s.hM)
    marker.position = at
    chase.update(s, dtS)
    sun.update(sunTimeMs(Date.now(), sunParam), at)
    buildings?.setNight(0)
    buildings?.update(s, tf)
    if (HUD && now - lastHud > 250) {
      lastHud = now
      const st = stats()
      info.textContent = [
        `imagery ${imagerySource}  cache ${globe.tileCacheSize}  sse ${globe.maximumScreenSpaceError}`,
        `aircraft ${s.hM.toFixed(0)} m  s ${sM.toFixed(0)} m  orbit ${chase.orbit.headingOffsetDeg.toFixed(0)}°`,
        `drawn ${frame.drawn}  blur ${frame.blurTiles} (+${frame.blurLevels} lv)  waiting ${frame.waiting}`,
        `loads ${st.tilesLoadedTotal}  reloads ${st.tileReloads}  freed ${st.tilesFreed}  queue ${st.replacementQueueCount}`,
        `imagery req ${st.imageryRequests}  re-req ${st.imageryRerequests}  fps ${st.fps.p50 ?? '—'}`,
        fadeLine(st.fade),
      ].join('\n')
    }
  })

  function fadeLine(f: ReturnType<typeof imageryFade.stats>): string {
    if (!f.enabled) return `fade off${f.installed ? '' : ' (not installed)'}`
    return `fade ${f.active} now (refs ${f.refsHeld})  started ${f.started}  done ${f.finished}  expired ${f.expired}  cancelled ${f.cancelled}  skip off ${f.skippedOffscreen} ref ${f.skippedRefined} cap ${f.skippedCap}`
  }

  function stats() {
    const d = frameMs.toSorted((a, b) => a - b)
    const cp = cpuMs.toSorted((a, b) => a - b)
    const mem = (performance as Any).memory
    let imageryCache = 0
    for (const l of [day, night]) if (l) imageryCache += Object.keys((l as Any)._imageryCache ?? {}).length
    return {
      ...c,
      replacementQueueCount: surface._tileReplacementQueue.count as number,
      tilesToRender: surface._tilesToRender.length as number,
      tilesLoaded: globe.tilesLoaded,
      loadQueue: { high: surface._tileLoadQueueHigh.length, medium: surface._tileLoadQueueMedium.length, low: surface._tileLoadQueueLow.length },
      blurDebt: { ...frame },
      residentTiles: resident.size,
      distinctTilesEverDone: everDone.size,
      imageryCacheEntries: imageryCache,
      frames: frameMs.length,
      fps: { p50: r1(d.length ? 1000 / pct(d, 0.5)! : null), p5: r1(d.length ? 1000 / pct(d, 0.95)! : null) },
      frameMs: { p50: r1(pct(d, 0.5)), p95: r1(pct(d, 0.95)), p99: r1(pct(d, 0.99)), max: r1(d.at(-1) ?? null) },
      cpuMs: { p50: r1(pct(cp, 0.5)), p95: r1(pct(cp, 0.95)), max: r1(cp.at(-1) ?? null) },
      usedJSHeapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
      sinceResetS: +((performance.now() - t0Reset) / 1000).toFixed(1),
      tileCacheSize: globe.tileCacheSize,
      sse: globe.maximumScreenSpaceError,
      fade: imageryFade.stats(),
      imagery: imagerySource,
      aircraft: { lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5), flownM: Math.round(sNow), hM: Math.round(s.hM), groundM: Math.round(profileAt(groundProfile, sNow)) },
      orbit: { headingOffsetDeg: chase.orbit.headingOffsetDeg, pitchDeg: chase.orbit.pitchDeg, rangeM: chase.orbit.rangeM },
    }
  }

  function resetCounters(): void {
    for (const k of Object.keys(c) as (keyof typeof c)[]) c[k] = 0
    frameMs.length = 0
    cpuMs.length = 0
    tLastPost = null
    timeline = []
    sec = null
    t0Reset = performance.now()
    imageryFade.resetStats()
  }

  async function waitIdle(timeoutMs = 60_000): Promise<{ idle: boolean; ms: number }> {
    const t0 = performance.now()
    let since: number | null = null
    while (performance.now() - t0 < timeoutMs) {
      const now = performance.now()
      if (globe.tilesLoaded) {
        since ??= now
        if (now - since >= 1000) return { idle: true, ms: Math.round(since - t0) }
      } else since = null
      await new Promise((r) => setTimeout(r, 50))
    }
    return { idle: false, ms: Math.round(performance.now() - t0) }
  }

  ;(window as unknown as { __lod: object }).__lod = {
    viewer,
    chase,
    ready: true,
    stats,
    timeline: () => [...timeline, ...(sec ? [{ ...sec, open: true }] : [])],
    resetCounters,
    setOrbit: (h: number, p: number, r: number) => chase.orbit.set(h, p, r),
    orbitBy: (deg: number, ms: number) =>
      new Promise<void>((done) => (orbitAnim = { from: chase.orbit.headingOffsetDeg, deg, t0: performance.now(), ms, done })),
    waitIdle,
    capture: (everyMs: number, count: number) => {
      const t0 = performance.now()
      shots = { t0, nextAt: t0, everyMs, count, list: [] }
    },
    captures: () => (shots ? shots.list.map(({ bitmap: _b, ...rest }) => rest) : []),
    shotData,
    go: () => {
      tGoMs = performance.now()
    },
    clock: () => JulianDate.toIso8601(viewer.clock.currentTime, 0),
    toggleTopo: () =>
      new Promise<{ on: boolean; ms: number; frames: number; frameMs: Pcts; cpuMs: Pcts }>((done) => {
        const t0 = performance.now()
        const [fromF, fromC] = [frameMs.length, cpuMs.length]
        topo.set(!topo.on, t0, profileAt(groundProfile, sNow))
        const pcts = (xs: number[]): Pcts => {
          const d = xs.sort((a, b) => a - b)
          return { p50: r1(pct(d, 0.5)), p95: r1(pct(d, 0.95)), max: r1(d.at(-1) ?? null) }
        }
        const poll = (): void => {
          if (topo.animating) return void setTimeout(poll, 20)
          const f = frameMs.slice(fromF)
          done({ on: topo.on, ms: Math.round(performance.now() - t0), frames: f.length, frameMs: pcts(f), cpuMs: pcts(cpuMs.slice(fromC)) })
        }
        setTimeout(poll, 20)
      }),
    toggleMap: () =>
      new Promise<{ show: boolean; frames: number; frameMs: Pcts; cpuMs: Pcts }>((done) => {
        const [fromF, fromC] = [frameMs.length, cpuMs.length]
        map.show = !map.show
        const pcts = (xs: number[]): Pcts => {
          const d = xs.sort((a, b) => a - b)
          return { p50: r1(pct(d, 0.5)), p95: r1(pct(d, 0.95)), max: r1(d.at(-1) ?? null) }
        }
        setTimeout(() => {
          const f = frameMs.slice(fromF)
          done({ show: map.show, frames: f.length, frameMs: pcts(f), cpuMs: pcts(cpuMs.slice(fromC)) })
        }, 1000)
      }),
    swapBaseLayer: () => {
      const layers = viewer.imageryLayers
      const old = day ?? (layers.length > 0 ? layers.get(0) : null)
      const before = imageryFade.stats()
      const eox = new ImageryLayer(eoxProvider())
      const at = old ? Math.max(0, layers.indexOf(old)) : 0
      if (old) layers.remove(old) // and destroys it: layerRemoved fires first (ImageryLayerCollection.js:164-176)
      layers.add(eox, at)
      sun.setDay(eox)
      day = eox
      wrapImagery(eox.imageryProvider)
      imagerySource = 'eox (swapBaseLayer)'
      return { before, after: imageryFade.stats() }
    },
  }
}

void main()
