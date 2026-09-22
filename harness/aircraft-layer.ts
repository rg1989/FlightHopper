// harness/aircraft-layer.ts
// Manual check for WP-V2: 200 synthetic aircraft circle KSFO and move every frame. Click a dot to select it, empty space to clear.
// Every 50th aircraft blinks out for 5 s at a time (exercises removal and re-creation). Open /harness/aircraft-layer.html.
import { Cartesian3, EllipsoidTerrainProvider, ScreenSpaceEventHandler, ScreenSpaceEventType, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { Quality } from '../shared/types.ts'
import type { RenderState } from '../client/types.ts'
import { AircraftLayer } from '../client/scene/aircraftLayer.ts'

const KSFO = { lat: 37.6188, lon: -122.3754 }
const N = 200
const M_PER_DEG = 111_320
const QUALITIES: Quality[] = ['adsb2', 'adsb2', 'adsb2', 'adsb01', 'mlat', 'other']

const viewer = new Viewer('globe', {
  terrainProvider: new EllipsoidTerrainProvider(),
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
viewer.camera.setView({
  destination: Cartesian3.fromDegrees(KSFO.lon, KSFO.lat - 0.75, 55_000),
  orientation: { heading: 0, pitch: -Math.PI / 4, roll: 0 },
})

const layer = new AircraftLayer(viewer)
let selected: string | null = null
let updateMsAvg = 0

/** Aircraft i circles KSFO; the first 10 taxi on the ground, a few are stale, extrapolated or have no callsign. */
function statesAt(tS: number): RenderState[] {
  const out: RenderState[] = []
  for (let i = 0; i < N; i++) {
    if (i % 50 === 0 && Math.floor(tS / 5) % 2 === 1) continue
    const onGround = i < 10
    const r = onGround ? 400 + 60 * i : 3000 + (i % 20) * 2500
    const v = onGround ? 8 : 70 + (i % 9) * 20
    const dir = i % 2 === 0 ? 1 : -1 // counter-clockwise / clockwise seen from above
    const th = (i * 2.399) + dir * (v / r) * tS
    const e = r * Math.cos(th)
    const n = r * Math.sin(th)
    const headingDeg = ((Math.atan2(-dir * Math.sin(th), dir * Math.cos(th)) * 180) / Math.PI + 360) % 360
    out.push({
      hex: (0xa00000 + i).toString(16),
      lat: KSFO.lat + n / M_PER_DEG,
      lon: KSFO.lon + e / (M_PER_DEG * Math.cos((KSFO.lat * Math.PI) / 180)),
      hM: onGround ? -30 : 300 + i * 50,
      headingDeg,
      pitchDeg: 0,
      rollDeg: 0,
      gsKt: v / 0.514444,
      trackDeg: headingDeg,
      altBaroFt: onGround ? null : (330 + i * 50) / 0.3048,
      vsFpm: 0,
      mode: i % 17 === 5 ? 'stale' : i % 13 === 3 ? 'extrap' : 'interp',
      altSource: 'geom',
      onGround,
      ageS: 1,
      quality: QUALITIES[i % QUALITIES.length],
      callsign: i % 7 === 0 ? null : `HOP${i}`,
      typeCode: 'A320',
    })
  }
  return out
}

const info = document.getElementById('info') as HTMLElement
viewer.scene.preUpdate.addEventListener(() => {
  const states = statesAt(performance.now() / 1000)
  const t0 = performance.now()
  layer.update(states, selected)
  updateMsAvg += (performance.now() - t0 - updateMsAvg) * 0.05
  info.textContent = `${states.length} aircraft · update ${updateMsAvg.toFixed(2)} ms · selected: ${selected ?? '—'} (click a dot)`
})

new ScreenSpaceEventHandler(viewer.scene.canvas).setInputAction((ev: ScreenSpaceEventHandler.PositionedEvent) => {
  selected = layer.pick(ev.position)
}, ScreenSpaceEventType.LEFT_CLICK)

;(window as unknown as { harness: object }).harness = { viewer, layer, statesAt, selected: () => selected }
