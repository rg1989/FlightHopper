// harness/runways.ts
// WP-V5 harness: /harness/runways.html?ap=KSFO|LLBG|LOWI draws the golden airports' runway planes over
// Re:Earth terrain + EOX imagery, flies to one airport and lists terrain − plane along each centreline
// (positive = terrain above the plane, which then hides it). Eyeball the planes against the terrain.
// ponytail: builds its own keyless viewer (the same settings as WP-V1's createViewer) so that WP-V5
// depends only on WP-00; the app uses createViewer.
import {
  BoundingSphere,
  Cartesian3,
  Cartographic,
  CesiumTerrainProvider,
  Credit,
  HeadingPitchRange,
  ImageryLayer,
  Math as CesiumMath,
  UrlTemplateImageryProvider,
  Viewer,
  sampleTerrainMostDetailed,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import airportsJson from '../data/fixtures/golden/airports-sample.json' with { type: 'json' }
import { addRunways } from '../client/scene/runways.ts'
import type { Airport } from '../shared/airports.ts'

const airports = airportsJson as Airport[]
const status = document.getElementById('status')!
const ident = new URLSearchParams(location.search).get('ap') ?? 'KSFO'
const ap = airports.find((a) => a.ident === ident) ?? airports[0]

const viewer = new Viewer('globe', {
  terrainProvider: await CesiumTerrainProvider.fromUrl('https://terrain.reearth.land/cesium-mesh/ellipsoid'),
  baseLayer: new ImageryLayer(
    new UrlTemplateImageryProvider({
      url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg',
      maximumLevel: 14,
      credit: new Credit('EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)', true),
    }),
  ),
  timeline: false,
  animation: false,
  geocoder: false,
  baseLayerPicker: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  homeButton: false,
  infoBox: false,
  selectionIndicator: false,
})
viewer.scene.globe.depthTestAgainstTerrain = true
const runways = addRunways(viewer, airports)

viewer.camera.flyToBoundingSphere(new BoundingSphere(Cartesian3.fromDegrees(ap.lon, ap.lat, ap.elevFt * 0.3048 + ap.nM), 1500), {
  offset: new HeadingPitchRange(CesiumMath.toRadians(200), CesiumMath.toRadians(-25), 5000),
  duration: 0,
})

// terrain − plane at 0, 25, 50, 75 and 100 % of each centreline (the plane is linear between the two end heights)
const rows = ap.runways.flatMap((r) =>
  [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const [a, b] = r.ends
    return { rwy: `${a.ident}/${b.ident}`, f, lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), planeH: a.thrHaeM + f * (b.thrHaeM - a.thrHaeM) }
  }),
)
const heights = await sampleTerrainMostDetailed(viewer.terrainProvider, rows.map((r) => Cartographic.fromDegrees(r.lon, r.lat)))
const residuals = rows.map((r, i) => ({ rwy: r.rwy, f: r.f, planeH: r.planeH, terrainH: +heights[i].height.toFixed(2), dM: +(heights[i].height - r.planeH).toFixed(2) }))
;(window as unknown as { harness: object }).harness = { viewer, runways, residuals }

const links = airports.map((a) => `<a href="?ap=${a.ident}">${a.ident}</a>`).join('')
const table = ap.runways
  .map((r) => {
    const name = `${r.ends[0].ident}/${r.ends[1].ident}`
    return `${name.padEnd(8)}${residuals.filter((x) => x.rwy === name).map((x) => x.dM.toFixed(2).padStart(7)).join('')}`
  })
  .join('\n')
status.innerHTML = `${links}\n${ap.ident} terrain − plane (m) at 0/25/50/75/100 % of the centreline\n${table}`
