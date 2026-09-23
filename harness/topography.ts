// harness/topography.ts
// WP-E1 harness: the real chase model and ChaseCamera fly a level circle over Innsbruck (LOWI) that crosses the
// Nordkette ridge, on the app's terrain (makeTerrain: Re:Earth with vertex normals) and imagery. T or the button
// flattens the relief into the map and grows it back through Topography. The overlay compares the ground drawn this
// frame (globe.getHeight, lag-corrected) with the provider's true height (sampleTerrainMostDetailed, 1 Hz, so up to
// 70 m behind the aircraft; ?hold=1 for exact comparisons) at the current factor, and counts undefined ground readings
// under the aircraft (the TerrainPicker race that the nudge fixes). Lighting is on only so the relief reads; WP-E2
// owns the sun. ?memo=1 passes a GroundMemo for the aircraft and one for the camera, as the app does, and checks the
// ground and the camera's clearance against the provider's heights at the same frame and points (stats().truth).
// Query: ?topo=0 (start flat)  ?r=6000 (circle radius m)  ?h=2700 (HAE m)  ?at=0 (s into the circle)  ?hold=1 (stand
//        still)  ?memo=1  ?time=2026-06-21T10:30:00Z (sun)  ?terrain=reearth|ion|ellipsoid  ?imagery=eox|ion|none
// window.harness = { viewer, topo, setTopo(on), stats() } for the gate GE bench.
import { Cartographic, JulianDate, sampleTerrainMostDetailed } from 'cesium'
import { readConfig } from '../client/config.ts'
import { ChaseCamera } from '../client/scene/chaseCamera.ts'
import { drawnHeightM } from '../client/scene/exaggeration.ts'
import { ChaseModel } from '../client/scene/model.ts'
import { Topography, groundMemo, pickRelHM } from '../client/scene/topography.ts'
import { createViewer } from '../client/scene/viewer.ts'
import type { ModelManifest, RenderState, TerrainFrame } from '../client/types.ts'
import type { Airport } from '../shared/airports.ts'

const q = new URLSearchParams(location.search)
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d)
const LOWI = { lat: 47.2602, lon: 11.3439 }
const RADIUS_M = num('r', 6000) // the northern half crosses the Nordkette ridge (Hafelekar 2,334 m)
const H_M = num('h', 2700)
const SPEED_MS = 70
const M_PER_DEG = 111_320
const QUIET_MS = 600 // a factor change resets the pickers; undefined readings this soon after one are expected
const TRUTH_TOL_M = 2 // drawn against true ground: the level-of-detail difference (gate GE: at most 1.4 m at rest)
const info = document.getElementById('info')!
const button = document.getElementById('topo')!

const ac: RenderState = {
  hex: '440abc', lat: LOWI.lat, lon: LOWI.lon, hM: H_M, headingDeg: 0, pitchDeg: 0, rollDeg: -12,
  gsKt: SPEED_MS / 0.514444, trackDeg: 0, altBaroFt: H_M / 0.3048, vsFpm: 0, mode: 'interp', altSource: 'geom',
  onGround: false, ageS: 1, quality: 'adsb2', callsign: 'HOP1', typeCode: 'A320',
}

/** Level counter-clockwise circle around LOWI, tS seconds in (one RenderState for the whole run). */
function fly(tS: number): void {
  const th = (SPEED_MS / RADIUS_M) * tS
  ac.lat = LOWI.lat + (RADIUS_M * Math.sin(th)) / M_PER_DEG
  ac.lon = LOWI.lon + (RADIUS_M * Math.cos(th)) / (M_PER_DEG * Math.cos((LOWI.lat * Math.PI) / 180))
  ac.headingDeg = ac.trackDeg = ((Math.atan2(-Math.sin(th), Math.cos(th)) * 180) / Math.PI + 360) % 360
}

async function main(): Promise<void> {
  const cfg = readConfig({
    VITE_TERRAIN: q.get('terrain') ?? import.meta.env.VITE_TERRAIN,
    VITE_IMAGERY: q.get('imagery') ?? import.meta.env.VITE_IMAGERY,
    VITE_CESIUM_ION_TOKEN: import.meta.env.VITE_CESIUM_ION_TOKEN,
    VITE_ARCGIS_KEY: import.meta.env.VITE_ARCGIS_KEY,
    VITE_API_BASE: import.meta.env.VITE_API_BASE,
  })
  const [viewer, manifest, heroes] = await Promise.all([
    createViewer('globe', cfg),
    fetch('/models/manifest.json').then((r) => r.json() as Promise<ModelManifest>),
    fetch('/airports/heroes.json').then((r) => r.json() as Promise<Airport[]>),
  ])
  const { scene } = viewer
  const globe = scene.globe
  globe.enableLighting = true
  viewer.clock.currentTime = JulianDate.fromIso8601(q.get('time') ?? '2026-06-21T10:30:00Z')

  const model = await ChaseModel.load(viewer, manifest.models.find((m) => m.id === manifest.default)!)
  const topo = new Topography(scene, q.get('topo') !== '0')
  topo.relatch(pickRelHM(ac.lat, ac.lon, null, heroes)) // ?topo=0: flat at LOWI's runway height, as on a selection
  let frame: TerrainFrame = topo.update(performance.now())
  const memo = q.get('memo') === '1'
  const acMemo = memo ? groundMemo() : undefined
  const camMemo = memo ? groundMemo() : undefined
  let camFromMemo = false // the camera's ground (its last clearance pass) came from camMemo this frame
  const chase = new ChaseCamera(viewer, {
    groundAt: (c) => {
      const raw = globe.getHeight(c)
      const g = topo.ground(raw, frame, camMemo, c)
      camFromMemo = raw === undefined && g !== null
      return g
    },
  })

  const st = {
    toggles: 0,
    groundM: null as number | null, // drawn this frame under the aircraft (lag-corrected globe.getHeight)
    rawGroundM: null as number | null, // globe.getHeight as read (last frame's factor)
    trueGroundM: null as number | null, // sampleTerrainMostDetailed: the provider's heights, never exaggerated
    clearanceM: null as number | null,
    minClearanceM: Number.POSITIVE_INFINITY,
    below15: 0,
    clearanceUnknown: 0,
    undefinedNearChange: 0, // globe.getHeight undefined under the aircraft within QUIET_MS of a factor change
    undefinedSettled: 0, // … later, with every tile loaded (gate GE: 0)
    lastToggle: { frames: 0, avgMs: 0, worstMs: 0 }, // frames that rendered a new factor since the last toggle
    // ?memo=1: frames checked against sampleTerrainMostDetailed at the aircraft and the camera (4 Hz, and every frame a
    // memo answered), each at that frame's factor and plane
    truth: {
      samples: 0,
      acMemo: 0, // … whose aircraft ground came from the memo
      acMaxErrReadM: 0, // |ground − drawnHeightM(true, f, relH)| under the aircraft, from a reading
      acMaxErrMemoM: 0, // … from the memo
      acOverTol: 0, // samples with that error over TRUTH_TOL_M
      camMemo: 0, // samples whose camera ground came from the memo
      camBelow15: 0, // the camera's true clearance under 15 m − TRUTH_TOL_M
      camFalse: 0, // … while it reported a clearance (it believed it was clear)
    },
  }
  const setTopo = (on: boolean): void => {
    if (on === topo.on) return
    topo.set(on, performance.now(), pickRelHM(ac.lat, ac.lon, st.groundM, heroes))
    st.toggles++
    st.lastToggle = { frames: 0, avgMs: 0, worstMs: 0 }
    button.setAttribute('aria-pressed', String(on))
  }
  button.setAttribute('aria-pressed', String(topo.on))
  button.onclick = () => setTopo(!topo.on)
  window.addEventListener('keydown', (e) => {
    if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) setTopo(!topo.on)
  })

  const hold = q.get('hold') === '1'
  const t0S = performance.now() / 1000 - num('at', 0)
  const carto = new Cartographic()
  const frameMs = new Float64Array(240) // ring buffer for the fps figure
  let frames = 0
  let last = performance.now()
  let changed = false // the previous update wrote a new factor: the frame just rendered carries its cost
  let quietFrom = 0
  let infoAt = 0
  let truthAt = 0

  // One frame against the provider's heights: the points, factor, plane, ground and clearance are taken now, so the
  // async answer is compared with what this frame drew.
  const checkTruth = (acFromMemo: boolean): void => {
    const [a, c] = [Cartographic.clone(carto), Cartographic.clone(viewer.camera.positionCartographic)]
    const camHM = c.height
    const { fNow, relHM } = frame
    const { groundM, clearanceM } = st
    const camMemoNow = camFromMemo
    sampleTerrainMostDetailed(viewer.terrainProvider, [a, c], true).then(() => {
      const t = st.truth
      t.samples++
      if (groundM !== null) {
        const err = Math.abs(groundM - drawnHeightM(a.height, fNow, relHM))
        if (acFromMemo) {
          t.acMemo++
          t.acMaxErrMemoM = Math.max(t.acMaxErrMemoM, err)
        } else t.acMaxErrReadM = Math.max(t.acMaxErrReadM, err)
        if (err > TRUTH_TOL_M) t.acOverTol++
      }
      if (camMemoNow) t.camMemo++
      if (camHM - drawnHeightM(c.height, fNow, relHM) < 15 - TRUTH_TOL_M) {
        t.camBelow15++
        if (clearanceM !== null) t.camFalse++
      }
    }, () => undefined) // a failed tile: not counted
  }

  scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    const dtMs = now - last
    last = now
    frameMs[frames++ % frameMs.length] = dtMs
    if (changed) {
      const a = st.lastToggle
      a.avgMs = (a.avgMs * a.frames + dtMs) / (a.frames + 1)
      a.frames++
      a.worstMs = Math.max(a.worstMs, dtMs)
    }
    frame = topo.update(now) // first, before any globe.getHeight
    changed = frame.fNow !== frame.fSampled
    if (changed) quietFrom = now + QUIET_MS

    fly(hold ? num('at', 0) : now / 1000 - t0S)
    const raw = globe.getHeight(Cartographic.fromDegrees(ac.lon, ac.lat, 0, carto))
    if (raw === undefined) {
      if (now < quietFrom) st.undefinedNearChange++
      else if (globe.tilesLoaded) st.undefinedSettled++
    }
    st.rawGroundM = raw ?? null
    st.groundM = topo.ground(raw, frame, acMemo, carto)
    ac.hM = st.groundM === null ? H_M : Math.max(H_M, st.groundM) // the app's placedHeightM, airborne
    model.update(ac)
    st.clearanceM = chase.update(ac, Math.min(0.1, dtMs / 1000)).clearanceM
    if (st.clearanceM === null) st.clearanceUnknown++
    else {
      st.minClearanceM = Math.min(st.minClearanceM, st.clearanceM)
      if (st.clearanceM < 15) st.below15++
    }
    const acFromMemo = raw === undefined && st.groundM !== null
    if (memo && (acFromMemo || camFromMemo || now >= truthAt)) {
      truthAt = now + 250
      checkTruth(acFromMemo)
    }
    if (now - infoAt > 250) {
      infoAt = now
      info.textContent = describe()
    }
  })

  // True ground under the aircraft, 1 Hz: the drawn ground must equal drawnHeightM(true, f, relH).
  setInterval(() => {
    sampleTerrainMostDetailed(viewer.terrainProvider, [Cartographic.fromDegrees(ac.lon, ac.lat)]).then(
      ([c]) => void (st.trueGroundM = c.height),
      () => void (st.trueGroundM = null),
    )
  }, 1000)

  const fps = (): number => {
    const n = Math.min(frames, frameMs.length)
    let sum = 0
    for (let i = 0; i < n; i++) sum += frameMs[i]
    return (1000 * n) / sum
  }
  const expectedGroundM = (): number | null => (st.trueGroundM === null ? null : drawnHeightM(st.trueGroundM, frame.fNow, frame.relHM))
  const stats = () => ({
    ...st,
    truth: { ...st.truth },
    memo,
    f: frame.fNow,
    relHM: frame.relHM,
    on: topo.on,
    animating: topo.animating,
    expectedGroundM: expectedGroundM(),
    aircraftHM: ac.hM,
    aglM: st.groundM === null ? null : ac.hM - st.groundM,
    tilesLoaded: globe.tilesLoaded,
    fps: fps(),
  })
  const fmt = (v: number | null, d = 1): string => (v === null ? '—' : v.toFixed(d))
  const truthLine = (t: typeof st.truth): string =>
    `memo check: ${t.samples} frames; aircraft error ${fmt(t.acMaxErrReadM)} m read, ${fmt(t.acMaxErrMemoM)} m memo (${t.acMemo}), ${t.acOverTol} > ${TRUTH_TOL_M} m; camera < 15 m ${t.camBelow15}, ${t.camFalse} reported clear (${t.camMemo} memo)`
  function describe(): string {
    const s = stats()
    const err = s.groundM === null || s.expectedGroundM === null ? null : s.groundM - s.expectedGroundM
    return [
      `factor ${s.f.toFixed(7)}  relH ${fmt(s.relHM)} m HAE  ${s.animating ? (s.on ? 'growing' : 'sinking') : s.on ? 'on' : 'flat'}`,
      `ground drawn ${fmt(s.groundM)} m (getHeight ${fmt(s.rawGroundM)})  true ${fmt(s.trueGroundM)} → at this factor ${fmt(s.expectedGroundM)} (Δ ${fmt(err)})`,
      `aircraft ${fmt(s.aircraftHM, 0)} m HAE  AGL ${fmt(s.aglM, 0)} m  camera clearance ${fmt(s.clearanceM)} m (min ${fmt(Number.isFinite(s.minClearanceM) ? s.minClearanceM : null)}, < 15 m: ${s.below15} frames, unknown ${s.clearanceUnknown})`,
      `last toggle: ${s.lastToggle.frames} frames with a new factor, avg ${s.lastToggle.avgMs.toFixed(1)} ms, worst ${s.lastToggle.worstMs.toFixed(1)} ms`,
      `undefined ground under the aircraft: ${s.undefinedNearChange} near a factor change, ${s.undefinedSettled} settled  tilesLoaded ${s.tilesLoaded}  fps ${s.fps.toFixed(0)}`,
      ...(s.memo ? [truthLine(s.truth)] : []),
      `T or the button: ${s.on ? 'flatten' : 'grow'}`,
    ].join('\n')
  }

  ;(window as unknown as { harness: object }).harness = { viewer, topo, setTopo, stats }
}

main().catch((err: unknown) => {
  info.textContent = `error: ${err instanceof Error ? err.message : String(err)}`
  console.error(err)
})
