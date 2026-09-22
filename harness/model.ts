// harness/model.ts
// WP-V3 harness: /harness/model.html?view=overview|28L|1R|synthetic|pitch|roll[&table=0]
// The default chase model at the KSFO 28L and 1R thresholds (heading = runway bearing from the golden fixture), at
// 0/90/180/270°, and pitched +10° / rolled +20° in the air. Yellow arrows, labelled at the tip, point where each nose
// must point. The pale strips are the KSFO runways. Ellipsoid terrain and no imagery: the ground is HAE 0, so the
// ground models stand on it.
import { Cartesian2, Cartesian3, Color, EllipsoidTerrainProvider, Math as CesiumMath, PolylineArrowMaterialProperty, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { Airport } from '../shared/airports.ts'
import { bearingDeg, destination } from '../shared/geo.ts'
import type { ModelManifest, RenderState } from '../client/types.ts'
import { ChaseModel, measureGlb, modelMatrixFor, noseAzimuthDeg } from '../client/scene/model.ts'

interface Case { name: string; s: RenderState }
interface Result { name: string; headingDeg: number; noseDeg: number; errDeg: number }

const panel = document.getElementById('panel')!
const table = document.getElementById('table')!
const q = new URLSearchParams(location.search)

function at(name: string, p: { lat: number; lon: number }, hM: number, headingDeg: number, pitchDeg = 0, rollDeg = 0): Case {
  const s: RenderState = {
    hex: name, lat: p.lat, lon: p.lon, hM, headingDeg, pitchDeg, rollDeg,
    gsKt: null, trackDeg: null, altBaroFt: null, vsFpm: null, mode: 'interp', altSource: 'geom',
    onGround: hM === 0, ageS: 0, quality: 'adsb2', callsign: null, typeCode: null,
  }
  return { name, s }
}

try {
  const viewer = new Viewer('globe', {
    terrainProvider: new EllipsoidTerrainProvider(), baseLayer: false, baseLayerPicker: false, geocoder: false,
    timeline: false, animation: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
    infoBox: false, selectionIndicator: false,
  })
  viewer.scene.globe.baseColor = Color.fromCssColorString('#2f3b34')

  const [manifest, airports] = await Promise.all([
    fetch('/models/manifest.json').then((r) => r.json() as Promise<ModelManifest>),
    fetch('/data/fixtures/golden/airports-sample.json').then((r) => r.json() as Promise<Airport[]>),
  ])
  const m = manifest.models.find((x) => x.id === manifest.default)!
  const axes = measureGlb(new Uint8Array(await (await fetch(`/${m.uri}`)).arrayBuffer()))
  const ksfo = airports.find((a) => a.ident === 'KSFO')!

  for (const r of ksfo.runways) {
    const positions = Cartesian3.fromDegreesArray([r.ends[0].lon, r.ends[0].lat, r.ends[1].lon, r.ends[1].lat])
    viewer.entities.add({ corridor: { positions, width: r.widthFt * 0.3048, material: Color.WHITE.withAlpha(0.3) } })
  }

  const threshold = (ident: string): Case => {
    const r = ksfo.runways.find((x) => x.ends.some((e) => e.ident === ident))!
    const [thr, far] = r.ends[0].ident === ident ? r.ends : [r.ends[1], r.ends[0]]
    return at(`KSFO ${ident}`, { lat: thr.thrLat, lon: thr.thrLon }, 0, bearingDeg(thr.thrLat, thr.thrLon, far.thrLat, far.thrLon))
  }
  const [t28L, t1R] = [threshold('28L'), threshold('1R')]
  const row0 = destination(t28L.s.lat, t28L.s.lon, 180, 0.35)
  const row = (i: number): { lat: number; lon: number } => destination(row0.lat, row0.lon, 90, 0.07 * i)
  const pitchCase = at('pitch +10', row(4), 60, 90, 10)
  const r5 = row(5)
  const rollCase = at('roll +20', destination(r5.lat, r5.lon, 180, 0.1), 60, 90, 0, 20) // off both views' sight lines
  const cases = [t28L, t1R, ...[0, 90, 180, 270].map((h, i) => at('synthetic', row(i), 0, h)), pitchCase, rollCase]

  const results: Result[] = []
  for (const c of cases) {
    ;(await ChaseModel.load(viewer, m)).update(c.s)
    const h = c.s.hM + m.gearHeightM
    const tip = destination(c.s.lat, c.s.lon, c.s.headingDeg, 60 / 1852)
    viewer.entities.add({
      polyline: {
        positions: Cartesian3.fromDegreesArrayHeights([c.s.lon, c.s.lat, h, tip.lon, tip.lat, h]),
        width: 14,
        material: new PolylineArrowMaterialProperty(Color.YELLOW),
      },
    })
    viewer.entities.add({
      position: Cartesian3.fromDegrees(tip.lon, tip.lat, h),
      label: {
        text: `${c.name} ${c.s.headingDeg.toFixed(1)}°`, font: '13px sans-serif', showBackground: true,
        pixelOffset: new Cartesian2(0, -16), disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
    const noseDeg = noseAzimuthDeg(modelMatrixFor(c.s, m), axes.nose)
    results.push({ name: c.name, headingDeg: c.s.headingDeg, noseDeg, errDeg: Math.abs(((noseDeg - c.s.headingDeg + 540) % 360) - 180) })
  }

  const look = (p: { lat: number; lon: number }, h: number, headingDeg: number, pitchDeg: number): void =>
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(p.lon, p.lat, h),
      orientation: { heading: CesiumMath.toRadians(headingDeg), pitch: CesiumMath.toRadians(pitchDeg), roll: 0 },
    })
  const views: Record<string, () => void> = {
    overview: () => look({ lat: 37.606, lon: -122.365 }, 3000, 0, -90),
    '28L': () => look(t28L.s, 160, 0, -90),
    '1R': () => look(t1R.s, 160, 0, -90),
    synthetic: () => look(row(1.5), 500, 0, -90),
    pitch: () => look(destination(pitchCase.s.lat, pitchCase.s.lon, 180, 0.08), 64, 0, 0), // from the south: flies right
    roll: () => look(destination(rollCase.s.lat, rollCase.s.lon, 270, 0.05), 70, 90, -3), // from behind: right wing is screen-right
  }

  const pass = results.every((r) => r.errDeg <= 1)
  const v3 = (v: Cartesian3): string => [v.x, v.y, v.z].map((c) => +c.toFixed(3)).join(', ')
  table.textContent = [
    `model ${m.id}: measured nose (${v3(axes.nose)}), up (${v3(axes.up)}), length ${(axes.lengthM * m.scale).toFixed(2)} m`,
    'case          heading    nose     err',
    ...results.map((r) => `${r.name.padEnd(12)}${r.headingDeg.toFixed(1).padStart(9)}${r.noseDeg.toFixed(1).padStart(8)}${r.errDeg.toFixed(2).padStart(8)}`),
    pass ? 'PASS: every nose within 1° of its heading' : 'FAIL: a nose is more than 1° off its heading',
  ].join('\n')
  const toggle = (): void => void (table.hidden = !table.hidden)
  for (const [name, go] of [...Object.entries(views), ['table', toggle] as const]) {
    const b = document.createElement('button')
    b.textContent = name
    b.onclick = go
    panel.insertBefore(b, table)
  }
  table.hidden = q.get('table') === '0'
  ;(views[q.get('view') ?? 'overview'] ?? views.overview)()
  ;(window as unknown as { harness: unknown }).harness = { viewer, results, pass, views }
} catch (err) {
  table.textContent = `error: ${(err as Error).message}`
  table.style.color = '#ff8080'
}
