// client/scene/placeLabels.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian2, Cartesian3, Cartographic, Ellipsoid, EllipsoidalOccluder, Math as CesiumMath } from 'cesium'
import type { Scene, Viewer } from 'cesium'
import { destination } from '../../shared/geo.ts'
import type { CountriesJson, SeasJson } from '../../shared/mapOverlays.ts'
import type { Places } from '../../shared/places.ts'
import type { TerrainFrame } from '../types.ts'
import { GAP_PX, MAX_LABELS, PlaceLabels, RANK, cityReachKm, declutter, inSight, indexPlaces, placeCandidates } from './placeLabels.ts'

const NM_PER_KM = 1 / 1.852
/** The point km away from (lat, lon) on a bearing. */
const at = (lat: number, lon: number, brg: number, km: number): { lat: number; lon: number } => destination(lat, lon, brg, km * NM_PER_KM)
type City = Places['cities'][number]
type Country = CountriesJson['countries'][number]
type Sea = SeasJson['seas'][number]
const city = (name: string, p: { lat: number; lon: number }, pop: number): City => [name, 'IL', -1, p.lat, p.lon, pop]
/** A country named at p, of Natural Earth's label rank (2 the largest). */
const country = (name: string, p: { lat: number; lon: number }, rank = 4): Country => [name, p.lon, p.lat, rank]
const sea = (name: string, p: { lat: number; lon: number }, scalerank: number): Sea => [name, p.lon, p.lat, scalerank]

test('cityReachKm: the bigger the city, the farther its name shows', () => {
  const tiers = [[8e6, 1500], [5e6, 1500], [4_999_999, 600], [1e6, 600], [3e5, 250], [1e5, 120], [3e4, 60], [29_999, 25], [15_000, 25]]
  for (const [pop, km] of tiers) assert.equal(cityReachKm(pop), km, `${pop}`)
})

const HOME = { lat: 32, lon: 35 }

test('placeCandidates: each city within the reach of its size; countries from 150 km to 3,000 (4,000 the largest, rank ≤ 2); seas from 50 km to 4,000 (scalerank ≤ 2) or 800', () => {
  const ix = indexPlaces(
    [
      city('Big', at(32, 35, 0, 1000), 6e6), city('Million', at(32, 35, 0, 700), 2e6), city('Million2', at(32, 35, 180, 500), 2e6),
      city('Small', at(32, 35, 270, 30), 20_000), city('Small2', at(32, 35, 270, 20), 20_000), city('Town', at(32, 35, 45, 50), 50_000),
    ],
    [
      country('Near', at(32, 35, 90, 100)), country('Mid', at(32, 35, 90, 1000)), country('Far', at(32, 35, 90, 3500)),
      country('Large', at(32, 35, 90, 3500), 2), country('Larger', at(32, 35, 90, 4500), 2),
    ],
    [sea('Close', at(32, 35, 0, 30), 1), sea('Major', at(32, 35, 270, 3000), 1), sea('Minor', at(32, 35, 270, 3000), 4), sea('Minor2', at(32, 35, 270, 500), 4)],
  )
  const name = (c: { kind: string; i: number }): string => c.kind === 'city' ? ix.cities[c.i][0] : c.kind === 'country' ? ix.countries[c.i][0] : ix.seas[c.i][0]
  const got = placeCandidates(ix, HOME.lat, HOME.lon).map((c) => `${c.kind}:${name(c)}`).sort()
  assert.deepEqual(got, ['city:Big', 'city:Million2', 'city:Small2', 'city:Town', 'country:Large', 'country:Mid', 'sea:Major', 'sea:Minor2'])
})

test('placeCandidates: a name fades out over the last 20 % of its reach', () => {
  const ix = indexPlaces([city('A', at(32, 35, 0, 400), 5e5), city('B', at(32, 35, 0, 225), 5e5), city('C', at(32, 35, 0, 100), 5e5)], [], [])
  const alpha = new Map(placeCandidates(ix, HOME.lat, HOME.lon).map((c) => [ix.cities[c.i][0], c.alpha]))
  assert.equal(alpha.has('A'), false, 'out of reach (250 km)')
  assert.ok(Math.abs(alpha.get('B')! - 0.5) < 0.01, `${alpha.get('B')}: 225 km of 250, halfway through the fade`)
  assert.equal(alpha.get('C'), 1)
})

test('placeCandidates: a city in the latitude band but far along it is out; one across the antimeridian is in', () => {
  const ix = indexPlaces([city('Same latitude', { lat: 0, lon: 120 }, 20_000), city('Across', { lat: 0.05, lon: -179.95 }, 20_000)], [], [])
  assert.deepEqual(placeCandidates(ix, 0, 179.95).map((c) => ix.cities[c.i][0]), ['Across'])
})

/** Boxes as x0, y0, x1, y1 each. */
const boxes = (...b: number[][]): Float64Array => Float64Array.from(b.flat())

test('declutter: in order, each box kept unless it comes within 4 px of one kept before it', () => {
  assert.equal(GAP_PX, 4)
  const b = boxes([0, 0, 100, 20], [50, 10, 150, 30], [103, 0, 150, 20], [105, 0, 150, 20], [0, 50, 40, 70])
  const keep = new Uint8Array(5)
  assert.equal(declutter(b, 5, 0, keep), 3)
  assert.deepEqual([...keep], [1, 0, 0, 1, 1], 'the overlapping one and the one 3 px away go; 5 px away stays')
})

test('declutter: a box hidden by an earlier one that was itself dropped still shows', () => {
  const b = boxes([0, 0, 100, 20], [90, 0, 200, 20], [195, 0, 300, 20])
  const keep = new Uint8Array(3)
  declutter(b, 3, 0, keep)
  assert.deepEqual([...keep], [1, 0, 1])
})

test('declutter: the fixed areas first are always there and keep every box off them; at most MAX_LABELS kept', () => {
  const b = boxes([0, 0, 50, 50], [10, 10, 30, 20], [100, 0, 120, 10])
  const keep = new Uint8Array(3)
  assert.equal(declutter(b, 3, 1, keep), 1)
  assert.deepEqual([...keep.subarray(1)], [0, 1])
  assert.equal(MAX_LABELS, 60)
  const many = boxes(...Array.from({ length: 70 }, (_, i) => [i * 20, 0, i * 20 + 10, 10]))
  const keepMany = new Uint8Array(70)
  assert.equal(declutter(many, 70, 0, keepMany), 60)
  assert.deepEqual([...keepMany.subarray(60)], new Array(10).fill(0))
})

test('inSight: a point ahead of the camera and above the horizon; behind the camera, or beyond the globe\'s edge, it is not', () => {
  const pos = Cartesian3.fromDegrees(35, 32, 10_000)
  const toward = (p: { lat: number; lon: number }, hM: number): Cartesian3 => Cartesian3.fromDegrees(p.lon, p.lat, hM)
  const ahead = Cartesian3.normalize(Cartesian3.subtract(toward(at(32, 35, 0, 50), 10_000), pos, new Cartesian3()), new Cartesian3())
  const cam = { positionWC: pos, directionWC: ahead } // looking north, level, 10 km up
  const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, pos)
  assert.equal(inSight(toward(at(32, 35, 0, 50), 0), cam, occluder), true, '50 km ahead')
  assert.equal(inSight(toward(at(32, 35, 180, 50), 0), cam, occluder), false, '50 km behind')
  assert.equal(inSight(toward(at(32, 35, 0, 600), 0), cam, occluder), false, '600 km ahead on the ground: the horizon is ~357 km')
  assert.equal(inSight(toward(at(32, 35, 0, 600), 30_000), cam, occluder), true, '600 km ahead and 30 km up: over the horizon')
})

// The overlay itself, with a fake viewer (a camera straight down over a point, a flat projection of 1° to `scale` px on
// a 1000 × 600 canvas) and just enough DOM.
interface FakeEl {
  className: string
  dataset: Record<string, string>
  style: Record<string, string>
  textContent: string
  hidden: boolean
  removed: boolean
  remove(): void
}
function fakeLayer() {
  const children: FakeEl[] = []
  return { children, append: (el: FakeEl) => void children.push(el) }
}
const shown = (layer: { children: FakeEl[] }): FakeEl[] => layer.children.filter((e) => !e.hidden)
const TF: TerrainFrame = { fSampled: 1, fNow: 1, relHM: 0 }

function fakeViewer(o: { lat?: number; lon?: number; scale?: number; heights?: Map<string, number>; onRead?: () => void } = {}) {
  const cam = { lat: o.lat ?? HOME.lat, lon: o.lon ?? HOME.lon }
  const scale = o.scale ?? 1000
  const asked: string[] = []
  const camera = {
    get positionWC(): Cartesian3 {
      return Cartesian3.fromDegrees(cam.lon, cam.lat, 20_000)
    },
    get directionWC(): Cartesian3 {
      return Cartesian3.negate(Ellipsoid.WGS84.geodeticSurfaceNormal(this.positionWC, new Cartesian3()), new Cartesian3())
    },
    get positionCartographic(): Cartographic {
      return Cartographic.fromDegrees(cam.lon, cam.lat, 20_000)
    },
  }
  const globe = {
    getHeight: (c: Cartographic): number | undefined => {
      const key = `${CesiumMath.toDegrees(c.latitude).toFixed(3)},${CesiumMath.toDegrees(c.longitude).toFixed(3)}`
      asked.push(key)
      o.onRead?.()
      return o.heights?.get(key)
    },
  }
  const scene = { camera, globe, canvas: { clientWidth: 1000, clientHeight: 600 } }
  const projected: Cartesian3[] = []
  const project = (_s: Scene, p: Cartesian3, out: Cartesian2): Cartesian2 => {
    projected.push(Cartesian3.clone(p))
    const c = Cartographic.fromCartesian(p)
    out.x = 500 + (CesiumMath.toDegrees(c.longitude) - cam.lon) * scale
    out.y = 300 - (CesiumMath.toDegrees(c.latitude) - cam.lat) * scale
    return out
  }
  return { viewer: { scene } as unknown as Viewer, cam, asked, project, projected }
}

/** Runs with a document whose elements are plain objects, and a device pixel ratio, then puts them back. */
async function withDom(run: () => Promise<void>, dpr = 1): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = (['document', 'devicePixelRatio'] as const).map((k) => [k, g[k]] as const)
  const createElement = (): FakeEl => ({
    className: '', dataset: {}, style: {}, textContent: '', hidden: false, removed: false,
    remove(): void {
      this.removed = true
    },
  })
  Object.assign(g, { document: { createElement }, devicePixelRatio: dpr })
  try {
    await run()
  } finally {
    for (const [k, v] of saved) g[k] = v
  }
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const measure = (text: string): number => text.length * 7

const URLS = { placesUrl: 'places.json', countriesUrl: 'countries.json', seasUrl: 'seas.json' }
/** The files' contents as the overlay reads them: places.json's cities, countries.json, seas.json. */
const files = (data: { cities?: City[]; countries?: Country[]; seas?: Sea[] }) => (url: string): unknown =>
  url === URLS.placesUrl ? { cities: data.cities ?? [] } : url === URLS.countriesUrl ? { countries: data.countries ?? [] } : { seas: data.seas ?? [] }

function overlay(data: { cities?: City[]; countries?: Country[]; seas?: Sea[] }, v = fakeViewer(), now?: () => number) {
  const layer = fakeLayer()
  const urls: string[] = []
  const getJson = (url: string): Promise<unknown> => {
    urls.push(url)
    return Promise.resolve(files(data)(url))
  }
  const labels = new PlaceLabels(v.viewer, layer as unknown as HTMLElement, { ...URLS, getJson, measure, project: v.project, now })
  return { labels, layer, urls, ...v }
}

/** Runs with console.warn collected into the array it gets, then puts it back. */
async function withWarnings(run: (warned: unknown[][]) => Promise<void>): Promise<void> {
  const warn = console.warn
  const warned: unknown[][] = []
  console.warn = (...a: unknown[]) => void warned.push(a)
  try {
    await run(warned)
  } finally {
    console.warn = warn
  }
}

test('PlaceLabels: hidden, it asks for nothing and draws nothing', async () => {
  await withDom(async () => {
    const o = overlay({ cities: [city('Tel Aviv', { lat: 32.08, lon: 34.78 }, 460_000)] })
    for (let t = 0; t < 2000; t += 16) o.labels.update(TF, t)
    await flush()
    assert.deepEqual([o.urls, o.layer.children.length, o.projected.length, o.asked.length], [[], 0, 0, 0])
  })
})

test('PlaceLabels: shown, it fetches its three files once; a city\'s name centred above its place, a country\'s in spaced capitals at its label point, a sea\'s', async () => {
  await withDom(async () => {
    const o = overlay({
      cities: [city('Tel Aviv', { lat: 32.08, lon: 34.78 }, 460_000)],
      countries: [country('Jordan', { lat: 31.9, lon: 37.2 })],
      seas: [sea('Mediterranean Sea', { lat: 32.6, lon: 33.6 }, 1)],
    }, fakeViewer({ scale: 100 }))
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 16)
    o.labels.update(TF, 32)
    assert.deepEqual(o.urls, ['places.json', 'countries.json', 'seas.json'])
    const els = shown(o.layer)
    assert.deepEqual(els.map((e) => [e.dataset.kind, e.textContent]).sort(), [['city', 'Tel Aviv'], ['country', 'JORDAN'], ['sea', 'Mediterranean Sea']])
    const tlv = els.find((e) => e.dataset.kind === 'city')!
    // Tel Aviv at x 478, y 292: 8 characters 56 px wide centred over it, the text's bottom 3 px above it (13 px × 1.2 high).
    assert.equal(tlv.style.transform, 'translate(450px, 273px)')
    assert.equal(tlv.className, 'fh-place')
  })
})

test('PlaceLabels: a name whose box would touch a bigger city\'s is left out', async () => {
  await withDom(async () => {
    const o = overlay({ cities: [city('Bat Yam', { lat: 32.0, lon: 35.005 }, 160_000), city('Holon', { lat: 32.0, lon: 35.0 }, 190_000)] })
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 1)
    assert.deepEqual(shown(o.layer).map((e) => e.textContent), ['Holon'])
  })
})

test('PlaceLabels: at most MAX_LABELS nodes, the biggest cities first; reused as the view moves', async () => {
  await withDom(async () => {
    // A 10 × 10 grid of cities, 90 × 50 px apart (none touching), C00 the smallest … C99 the biggest.
    const grid: City[] = []
    for (let i = 0; i < 100; i++) grid.push(city(`C${String(i).padStart(2, '0')}`, { lat: 31.76 + Math.floor(i / 10) * 0.05, lon: 34.56 + (i % 10) * 0.09 }, 1e6 + i))
    const o = overlay({ cities: grid })
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 1)
    const first = shown(o.layer).map((e) => e.textContent)
    assert.equal(first.length, MAX_LABELS)
    assert.deepEqual(first.sort(), grid.slice(40).map((c) => c[0]), 'the 60 biggest: C40–C99')
    assert.equal(o.layer.children.length, MAX_LABELS)
    o.cam.lon += 0.45 // the grid's left half goes off the left edge
    o.labels.update(TF, 600)
    const second = shown(o.layer).map((e) => e.textContent).sort()
    const onScreen = grid.filter((c) => c[4] > 35).map((c) => c[0]) // columns 5–9: 50 cities, all under the cap
    assert.deepEqual(second, onScreen)
    assert.equal(o.layer.children.length, MAX_LABELS, 'the nodes of the names that went are reused for those that came (C00–C39\'s right half)')
  })
})

test('PlaceLabels: a name fades over the last 20 % of its reach', async () => {
  await withDom(async () => {
    const o = overlay({ cities: [city('Near', { lat: 32.1, lon: 35 }, 20_000), city('Edge', { lat: 32, lon: 35.24 }, 20_000)] })
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 1)
    const op = new Map(shown(o.layer).map((e) => [e.textContent, e.style.opacity ?? '']))
    assert.equal(op.get('Near'), '', 'fully shown: no opacity written')
    const edge = Number(op.get('Edge')) // 22.6 km of 25
    assert.ok(edge > 0.4 && edge < 0.6, `Edge ${op.get('Edge')}`)
  })
})

test('PlaceLabels: other layers\' labels show without the place names, decluttered by their rank, and go when cleared', async () => {
  await withDom(async () => {
    const o = overlay({ cities: [city('Haifa', { lat: 32.0, lon: 35.0 }, 280_000)] })
    const storm = { text: 'Thunderstorms · FL250–FL450', position: Cartesian3.fromDegrees(35, 32.004, 13_000), color: '#ff8a3d' }
    o.labels.setLayer('hazards', RANK.sea + 0.5, [storm])
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 1)
    assert.deepEqual(o.urls, [], 'the place names are off: their data is not fetched')
    let els = shown(o.layer)
    assert.deepEqual(els.map((e) => [e.dataset.kind, e.textContent, e.style.color]), [['layer', storm.text, '#ff8a3d']])
    o.labels.show = true
    o.labels.update(TF, 2)
    await flush()
    o.labels.update(TF, 3)
    els = shown(o.layer)
    assert.deepEqual(els.map((e) => e.textContent), [storm.text], 'Haifa\'s name would touch the storm\'s, which ranks above cities')
    o.labels.setLayer('hazards', RANK.sea + 0.5, [])
    o.labels.update(TF, 4)
    assert.deepEqual(shown(o.layer).map((e) => e.textContent), ['Haifa'])
    o.labels.show = false
    o.labels.update(TF, 5)
    assert.deepEqual(shown(o.layer), [])
    const projected = o.projected.length
    o.labels.update(TF, 1000)
    assert.equal(o.projected.length, projected, 'off, and no layer labels: no work')
  })
})

test('PlaceLabels: active while the names show or another layer has labels set (the app measures the areas kept off only then)', async () => {
  await withDom(async () => {
    const o = overlay({})
    assert.equal(o.labels.active, false)
    o.labels.show = true
    assert.equal(o.labels.active, true)
    o.labels.show = false
    o.labels.setLayer('hazards', 1.5, [{ text: 'Icing', position: Cartesian3.fromDegrees(35, 32, 5000), color: '#5aa9ff' }])
    assert.equal(o.labels.active, true)
    o.labels.setLayer('hazards', 1.5, [])
    assert.equal(o.labels.active, false)
  })
})

test('PlaceLabels: no name over the chased aircraft\'s outline; one beside it, inside its brackets, shows', async () => {
  await withDom(async () => {
    const o = overlay({ cities: [city('Under the aircraft', { lat: 32, lon: 35 }, 1e6), city('Beside', { lat: 32.04, lon: 35.04 }, 1e5)] })
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 1, [], { n: 1, d: Float64Array.of(500, 300, 20) })
    assert.deepEqual(shown(o.layer).map((e) => e.textContent), ['Beside'], 'the name under the aircraft keeps no room either')
    o.labels.update(TF, 2, [], { n: 0, d: new Float64Array(0) })
    assert.deepEqual(shown(o.layer).map((e) => e.textContent).sort(), ['Beside', 'Under the aircraft'], 'the aircraft gone, its name is back')
  })
})

test('PlaceLabels: no name over the areas kept off (the flight-data frame\'s cards)', async () => {
  await withDom(async () => {
    const o = overlay({ cities: [city('Under the aircraft', { lat: 32, lon: 35 }, 1e6), city('Clear', { lat: 32.2, lon: 35.3 }, 1e6)] })
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 1, [{ x: 450, y: 250, w: 100, h: 100 }])
    assert.deepEqual(shown(o.layer).map((e) => e.textContent), ['Clear'])
  })
})

test('PlaceLabels: a name stands on the ground once its tile is in (cached), at the ellipsoid before; flat, on the flat plane', async () => {
  await withDom(async () => {
    const heights = new Map<string, number>()
    const v = fakeViewer({ heights })
    const o = overlay({ cities: [city('Jerusalem', { lat: 31.95, lon: 35.1 }, 900_000)] }, v)
    const heightNow = (): number => Cartographic.fromCartesian(o.projected[o.projected.length - 1]).height
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 1)
    assert.ok(Math.abs(heightNow()) < 0.01, 'unknown: at 0')
    heights.set('31.950,35.100', 780)
    o.labels.update(TF, 17) // read after this frame's names are placed: they stand on it from the next frame
    o.labels.update(TF, 33)
    assert.ok(Math.abs(heightNow() - 780) < 0.01, `${heightNow()}`)
    const asks = o.asked.length
    o.labels.update(TF, 1200)
    assert.equal(o.asked.length, asks, 'known: not asked again')
    o.labels.update({ fSampled: 0, fNow: 0, relHM: 50 }, 1201) // the topography toggle flattens the ground onto a 50 m plane
    assert.ok(Math.abs(heightNow() - 50) < 0.01, `${heightNow()}`)
  })
})

test('PlaceLabels: written at whole device pixels, so the text stays crisp', async () => {
  await withDom(async () => {
    const o = overlay({ cities: [city('Ashdod', { lat: 31.80123, lon: 34.65037 }, 220_000)] })
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 1)
    const [x, y] = shown(o.layer)[0].style.transform.match(/-?[\d.]+/g)!.map(Number)
    assert.ok(Number.isInteger(x * 2) && Number.isInteger(y * 2), `${x}, ${y}: half-pixels at a device ratio of 2`)
  }, 2)
})

/** n towns of 50 000 on screen round HOME, 150 × 100 px apart, each with its ground height in heights. */
function towns(n: number, heights: Map<string, number>): City[] {
  const out: City[] = []
  for (let i = 0; i < n; i++) {
    const p = { lat: 31.8 + Math.floor(i / 5) * 0.1, lon: 34.7 + (i % 5) * 0.15 }
    out.push(city(`T${i}`, p, 50_000))
    heights.set(`${p.lat.toFixed(3)},${p.lon.toFixed(3)}`, 100 + i)
  }
  return out
}

test('PlaceLabels: ground heights are read under a time budget, a few a frame and spread over frames (a tile\'s first pick scans its whole mesh)', async () => {
  await withDom(async () => {
    let clock = 0
    const heights = new Map<string, number>()
    const cities = towns(20, heights)
    const o = overlay({ cities }, fakeViewer({ heights, onRead: () => (clock += 0.4) }), () => clock)
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    const perFrame: number[] = []
    for (let f = 1; f <= 12; f++) {
      const before = o.asked.length
      o.labels.update(TF, f * 16)
      perFrame.push(o.asked.length - before)
    }
    assert.ok(perFrame.every((n) => n <= 3), `${perFrame}: at 0.4 ms a read, none starts once 1 ms has gone`)
    assert.equal(o.asked.length, 20, 'each name read once')
    assert.deepEqual(new Set(o.asked).size, 20)
    // Instant reads: a few a frame all the same.
    const quick = overlay({ cities }, fakeViewer({ heights }))
    quick.labels.show = true
    quick.labels.update(TF, 0)
    await flush()
    quick.labels.update(TF, 16)
    assert.equal(quick.asked.length, 4)
  })
})

test('PlaceLabels: a slow pick is the frame\'s only read; with the relief flat nothing is read at all, the names standing on the flat plane', async () => {
  await withDom(async () => {
    let clock = 0
    const heights = new Map<string, number>()
    const cities = towns(6, heights)
    const slow = overlay({ cities }, fakeViewer({ heights, onRead: () => (clock += 5) }), () => clock)
    slow.labels.show = true
    slow.labels.update(TF, 0)
    await flush()
    for (let f = 1; f <= 6; f++) {
      const before = slow.asked.length
      slow.labels.update(TF, f * 16)
      assert.equal(slow.asked.length - before, 1, `frame ${f}`)
    }
    const FLAT: TerrainFrame = { fSampled: 0, fNow: 0, relHM: 40 }
    const flat = overlay({ cities }, fakeViewer({ heights }))
    flat.labels.show = true
    flat.labels.update(FLAT, 0)
    await flush()
    for (let f = 1; f <= 40; f++) flat.labels.update(FLAT, f * 100) // past several looks
    assert.equal(flat.asked.length, 0)
    assert.equal(shown(flat.layer).length, 6)
    const h = Cartographic.fromCartesian(flat.projected[flat.projected.length - 1]).height
    assert.ok(Math.abs(h - 40) < 0.01, `${h}`)
  })
})

test('PlaceLabels: files of the wrong shape are one warning, and nothing is fetched again until the next show', async () => {
  await withDom(() => withWarnings(async (warned) => {
    const v = fakeViewer()
    const layer = fakeLayer()
    const urls: string[] = []
    const getJson = (url: string): Promise<unknown> => (urls.push(url), Promise.resolve({ oops: true }))
    const labels = new PlaceLabels(v.viewer, layer as unknown as HTMLElement, { ...URLS, getJson, measure, project: v.project })
    labels.show = true
    for (let f = 0; f < 30; f++) {
      labels.update(TF, f * 16)
      await flush()
    }
    assert.deepEqual([urls.length, warned.length], [3, 1])
    labels.show = false
    labels.update(TF, 600)
    labels.show = true
    labels.update(TF, 616)
    await flush()
    assert.equal(urls.length, 6, 'asked again at the next show')
  }))
})

test('PlaceLabels: destroy removes its nodes; a fetch that lands after it, and any update after it, do nothing', async () => {
  await withDom(async () => {
    const o = overlay({ cities: [city('Haifa', { lat: 32.05, lon: 35.05 }, 280_000)] })
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 1)
    assert.equal(shown(o.layer).length, 1)
    o.labels.destroy()
    assert.ok(o.layer.children.every((e) => e.removed))
    const projected = o.projected.length
    o.labels.update(TF, 600)
    assert.equal(o.projected.length, projected)
    // A fetch still out when the overlay goes.
    const v = fakeViewer()
    const layer = fakeLayer()
    const pending: [string, (x: unknown) => void][] = []
    const getJson = (url: string): Promise<unknown> => new Promise((r) => pending.push([url, r]))
    const late = new PlaceLabels(v.viewer, layer as unknown as HTMLElement, { ...URLS, getJson, measure, project: v.project })
    late.show = true
    late.update(TF, 0)
    late.destroy()
    for (const [url, land] of pending) land(files({ cities: [city('Haifa', { lat: 32.05, lon: 35.05 }, 280_000)] })(url))
    await flush()
    late.update(TF, 600)
    assert.deepEqual([layer.children.length, v.projected.length], [0, 0])
  })
})

test('PlaceLabels: a name all but faded out (under 10 %) keeps no room from a legible one', async () => {
  await withDom(async () => {
    // Both reach 25 km and sit side by side on screen: the bigger at 24.75 km (5 % left) would push out the other (22 km, 60 %).
    const o = overlay({ cities: [city('Aaaa', at(32, 35, 90, 24.75), 25_000), city('Bbbb', at(32, 35, 90, 22), 16_000)] })
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 1)
    assert.deepEqual(shown(o.layer).map((e) => e.textContent), ['Bbbb'])
  })
})

test('PlaceLabels: the names on screen are read first, a bigger city off screen after them', async () => {
  await withDom(async () => {
    let clock = 0
    const heights = new Map<string, number>()
    const cities = [city('Off screen', { lat: 32, lon: 36 }, 2e6), ...towns(3, heights)] // 1° east: x 1500 on a 1000-px canvas
    const o = overlay({ cities }, fakeViewer({ heights, onRead: () => (clock += 5) }), () => clock)
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    for (let f = 1; f <= 4; f++) o.labels.update(TF, f * 16)
    assert.deepEqual(o.asked, ['31.800,34.700', '31.800,34.850', '31.800,35.000', '32.000,36.000'])
  })
})

test('PlaceLabels: a countries file without its list is caught at load (one warning), not thrown from every frame after', async () => {
  await withDom(() => withWarnings(async (warned) => {
    const v = fakeViewer()
    const layer = fakeLayer()
    const good = files({ cities: [city('Haifa', { lat: 32.05, lon: 35.05 }, 280_000)] })
    const getJson = (url: string): Promise<unknown> => Promise.resolve(url === URLS.countriesUrl ? {} : good(url))
    const labels = new PlaceLabels(v.viewer, layer as unknown as HTMLElement, { ...URLS, getJson, measure, project: v.project })
    labels.show = true
    labels.update(TF, 0)
    await flush()
    for (let f = 1; f <= 40; f++) labels.update(TF, f * 50) // past several looks
    assert.equal(warned.length, 1)
  }))
})

test('PlaceLabels: a name whose tile is not in yet is asked once a frame, not once for being on screen and again in rank order', async () => {
  await withDom(async () => {
    const o = overlay({ cities: towns(2, new Map()) }) // no heights: every answer undefined
    o.labels.show = true
    o.labels.update(TF, 0)
    await flush()
    o.labels.update(TF, 16)
    assert.deepEqual(o.asked, ['31.800,34.700', '31.800,34.850'])
  })
})

test('PlaceLabels: nothing is read while the relief grows or sinks (each frame resets the tiles\' pickers: every read a whole mesh)', async () => {
  await withDom(async () => {
    const heights = new Map<string, number>()
    const o = overlay({ cities: towns(3, heights) })
    o.labels.show = true
    const growing = (f: number): TerrainFrame => ({ fSampled: 0.5 + f * 0.01, fNow: 0.51 + f * 0.01, relHM: 30 })
    o.labels.update(growing(0), 0)
    await flush()
    for (let f = 1; f <= 30; f++) o.labels.update(growing(f), f * 16)
    assert.equal(o.asked.length, 0)
    o.labels.update(TF, 600) // at rest again
    assert.equal(o.asked.length, 3)
  })
})
