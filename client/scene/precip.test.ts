// client/scene/precip.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Metar } from '../../shared/wx.ts'
import type { SourceTile } from './radar.ts'
import {
  OVERLAY, Precipitation, cloudBaseM, coverSize, nearestStation, overlayOpacity, precipFromDbz, precipFromWx, radarPixel, radarSample, tiltDeg, windOf,
  type Fall,
} from './precip.ts'

const FT = 0.3048
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const metar = (o: Partial<Metar> = {}): Metar => ({
  id: 'LLBG', name: null, lat: 32, lon: 34.9, elevM: 40, obsMs: null, cat: 'VFR', wdir: null, wspd: 0, wgst: null, visKm: 10,
  visPlus: true, tempC: null, dewC: null, qnhHpa: null, wx: null, clouds: [], vertVisFt: null, raw: '', ...o,
})

test('precipFromDbz: nothing under 15 dBZ (RainViewer\'s faintest colour); rain stronger to 45 dBZ, snow to 35', () => {
  assert.equal(precipFromDbz(14, false), null)
  assert.equal(precipFromDbz(-128, false), null, 'no echo')
  assert.deepEqual(precipFromDbz(15, false), { kind: 'rain', intensity: 0 })
  assert.deepEqual(precipFromDbz(30, false), { kind: 'rain', intensity: 0.5 })
  assert.deepEqual(precipFromDbz(45, false), { kind: 'rain', intensity: 1 })
  assert.deepEqual(precipFromDbz(60, false), { kind: 'rain', intensity: 1 })
  assert.deepEqual(precipFromDbz(25, true), { kind: 'snow', intensity: 0.5 })
  assert.deepEqual(precipFromDbz(35, true), { kind: 'snow', intensity: 1 })
  assert.equal(precipFromDbz(Number.NaN, false), null)
})

test('precipFromWx: -RA light, RA moderate, +RA or a thunderstorm with rain heavy; showers as rain; snow; drizzle lighter', () => {
  assert.deepEqual(precipFromWx('-RA'), { kind: 'rain', intensity: 0.25 })
  assert.deepEqual(precipFromWx('RA'), { kind: 'rain', intensity: 0.55 })
  assert.deepEqual(precipFromWx('+RA'), { kind: 'rain', intensity: 1 })
  assert.deepEqual(precipFromWx('TSRA'), { kind: 'rain', intensity: 1 })
  assert.deepEqual(precipFromWx('-TSRA'), { kind: 'rain', intensity: 1 })
  assert.deepEqual(precipFromWx('-SHRA'), { kind: 'rain', intensity: 0.25 })
  assert.deepEqual(precipFromWx('SN'), { kind: 'snow', intensity: 0.55 })
  assert.deepEqual(precipFromWx('-SN BR'), { kind: 'snow', intensity: 0.25 })
  assert.deepEqual(precipFromWx('+SHSN'), { kind: 'snow', intensity: 1 })
  assert.deepEqual(precipFromWx('-RASN'), { kind: 'snow', intensity: 0.25 }, 'rain and snow: the flakes show')
  assert.deepEqual(precipFromWx('DZ'), { kind: 'rain', intensity: 0.275 })
  assert.deepEqual(precipFromWx('FZRA'), { kind: 'rain', intensity: 0.55 })
  assert.deepEqual(precipFromWx('-RA +SHRA'), { kind: 'rain', intensity: 1 }, 'the strongest group')
})

test('precipFromWx: nothing for no weather, a thunderstorm with nothing falling, showers or rain nearby (VC) or recent (RE), fog alone', () => {
  for (const wx of [null, '', 'TS', 'VCSH', 'VCTS', 'RERA', 'BR', 'FG', 'HZ', 'NSW']) assert.equal(precipFromWx(wx), null, String(wx))
})

test('precipFromWx: snow blown or drifting off the ground (BLSN, DRSN) is no snow falling; with snow falling too, that falls', () => {
  assert.equal(precipFromWx('BLSN'), null)
  assert.equal(precipFromWx('DRSN'), null)
  assert.equal(precipFromWx('+BLSN'), null)
  assert.deepEqual(precipFromWx('-SN BLSN'), { kind: 'snow', intensity: 0.25 })
  assert.deepEqual(precipFromWx('BLSN SN'), { kind: 'snow', intensity: 0.55 })
})

test('radarPixel: the zoom-7 tile and the pixel in it (Web Mercator, north row first)', () => {
  assert.deepEqual(radarPixel(0, 0), { x: 64, y: 64, px: 0, py: 0 })
  assert.deepEqual(radarPixel(32, 34.9), { x: 76, y: 51, px: 104, py: 250 }) // world pixel 19560.7, 13306.9 of 32,768
  assert.deepEqual(radarPixel(-33.9, -180), { x: 0, y: 76, px: 0, py: 211 })
  assert.deepEqual(radarPixel(89.9, 0), { x: 64, y: 0, px: 0, py: 0 }, 'kept on the map')
  assert.deepEqual(radarPixel(0, 180), radarPixel(0, -180), '180° is −180°')
})

test('radarSample: the strongest echo of the 3 × 3 pixels round the pixel (inside the tile), and whether it is snow', () => {
  const tile: SourceTile = { dbz: new Int8Array(256 * 256).fill(-128), snow: new Uint8Array(256 * 256) }
  assert.equal(radarSample(tile, 10, 10), null, 'no echo')
  tile.dbz[11 * 256 + 9] = 32
  tile.dbz[10 * 256 + 10] = 20
  tile.snow[11 * 256 + 9] = 1
  assert.deepEqual(radarSample(tile, 10, 10), { dbz: 32, snow: true })
  assert.deepEqual(radarSample(tile, 10, 13), null, 'two rows off: out of reach')
  assert.deepEqual(radarSample(tile, 9, 9), { dbz: 20, snow: false }, 'the 32 two rows under it: out of reach')
  tile.dbz[0] = 40
  assert.deepEqual(radarSample(tile, 0, 0), { dbz: 40, snow: false }, 'a corner reads what of its 3 × 3 is in the tile')
  tile.dbz[255 * 256 + 255] = 18
  assert.deepEqual(radarSample(tile, 255, 255), { dbz: 18, snow: false })
})

test('nearestStation: the nearest report within 30 km', () => {
  const a = metar({ id: 'A', lat: 32, lon: 34.9 })
  const b = metar({ id: 'B', lat: 32.1, lon: 34.9 })
  assert.equal(nearestStation([a, b], 32.08, 34.9)?.id, 'B')
  assert.equal(nearestStation([a, b], 31.95, 34.9)?.id, 'A')
  assert.equal(nearestStation([a], 32.28, 34.9), null, '31 km')
  assert.equal(nearestStation([a], 32.26, 34.9)?.id, 'A', '28.9 km')
  assert.equal(nearestStation([], 32, 34.9), null)
})

test('cloudBaseM: the lowest broken, overcast or hidden-sky base above sea level, else the lowest layer\'s; none without a layer or a height', () => {
  assert.equal(cloudBaseM(metar({ clouds: [{ cover: 'FEW', baseFt: 1500, type: null }, { cover: 'BKN', baseFt: 4000, type: null }] })), 40 + 4000 * FT)
  assert.equal(cloudBaseM(metar({ clouds: [{ cover: 'SCT', baseFt: 2500, type: null }, { cover: 'FEW', baseFt: 1800, type: null }] })), 40 + 1800 * FT)
  assert.equal(cloudBaseM(metar({ clouds: [{ cover: 'OVX', baseFt: 300, type: null }], vertVisFt: 300 })), 40 + 300 * FT)
  assert.equal(cloudBaseM(metar({ clouds: [{ cover: 'OVC', baseFt: null, type: null }] })), null)
  assert.equal(cloudBaseM(metar()), null)
  assert.equal(cloudBaseM(metar({ elevM: null, clouds: [{ cover: 'BKN', baseFt: 4000, type: null }] })), null)
})

test('windOf: the surface wind as it blows, metres a second east and north; none when calm, variable or unknown', () => {
  const w = windOf(metar({ wdir: 270, wspd: 10 })) // from the west at 10 kt: blows east
  assert.ok(near(w.east, 5.144, 1e-3) && near(w.north, 0, 1e-9), `${w.east}, ${w.north}`)
  const n = windOf(metar({ wdir: 0, wspd: 20 }))
  assert.ok(near(n.north, -10.289, 1e-3) && near(n.east, 0, 1e-9))
  assert.deepEqual(windOf(metar({ wdir: null, wspd: 6 })), { east: 0, north: 0 })
  assert.deepEqual(windOf(null), { east: 0, north: 0 })
})


// ---- the overlay ---------------------------------------------------------------------------------------------------------

test('overlayOpacity: by intensity, from the kind\'s faint to its full; dimmer at night', () => {
  const f = (kind: 'rain' | 'snow', intensity: number, night = 0): Fall => ({ kind, intensity, wind: { east: 0, north: 0 }, night })
  assert.equal(overlayOpacity(f('rain', 0)), OVERLAY.rain.opacity[0])
  assert.equal(overlayOpacity(f('rain', 1)), OVERLAY.rain.opacity[1])
  assert.ok(near(overlayOpacity(f('rain', 0.5)), (OVERLAY.rain.opacity[0] + OVERLAY.rain.opacity[1]) / 2, 1e-12))
  assert.equal(overlayOpacity(f('snow', 1)), OVERLAY.snow.opacity[1])
  assert.ok(overlayOpacity(f('rain', 1, 1)) < OVERLAY.rain.opacity[1] * 0.6 && overlayOpacity(f('rain', 1, 1)) > 0, 'dimmer at night, still there')
  assert.equal(overlayOpacity(f('rain', 9)), OVERLAY.rain.opacity[1])
})

test('tiltDeg: the fall leans with the wind across the camera\'s view (a CSS rotation: negative turns it so drops go right), within the kind\'s most', () => {
  const east = { east: 4, north: 0 } // blowing towards the east
  assert.ok(near(tiltDeg('rain', east, 0), -Math.atan2(4, OVERLAY.rain.fallMs) * 180 / Math.PI, 1e-9), 'looking north: it blows to the right')
  assert.ok(near(tiltDeg('rain', east, Math.PI), Math.atan2(4, OVERLAY.rain.fallMs) * 180 / Math.PI, 1e-9), 'looking south: to the left')
  assert.ok(near(tiltDeg('rain', east, Math.PI / 2), 0, 1e-9), 'looking downwind: no lean')
  assert.equal(tiltDeg('rain', { east: 40, north: 0 }, 0), -OVERLAY.rain.maxTiltDeg)
  assert.ok(Math.abs(tiltDeg('snow', { east: 0.8, north: 0 }, 0)) > Math.abs(tiltDeg('rain', { east: 0.8, north: 0 }, 0)), 'snow, falling slower, leans more')
  assert.equal(tiltDeg('snow', { east: 0, north: 0 }, 1), 0)
})

test('coverSize: what a turned layer must span to cover the view', () => {
  const [w, h] = coverSize(1600, 900, 30)
  assert.ok(w >= 1600 * Math.cos(Math.PI / 6) + 900 * 0.5 && w <= 1600 * Math.cos(Math.PI / 6) + 900 * 0.5 + 4, String(w))
  assert.ok(h >= 1600 * 0.5 + 900 * Math.cos(Math.PI / 6) && h <= 1600 * 0.5 + 900 * Math.cos(Math.PI / 6) + 4, String(h))
  assert.deepEqual(coverSize(1600, 900, 0).map((v) => v >= 1600 || v >= 900), [true, true])
  assert.deepEqual(coverSize(800, 600, -20), coverSize(800, 600, 20))
})

// Node has no DOM: just enough of one for the overlay, every style set through setProperty.
class FakeStyle {
  props = new Map<string, string>()
  setProperty(k: string, v: string): void { this.props.set(k, v) }
  removeProperty(k: string): string { const v = this.props.get(k) ?? ''; this.props.delete(k); return v }
  getPropertyValue(k: string): string { return this.props.get(k) ?? '' }
}
class FakeEl {
  className = ''
  hidden = false
  children: FakeEl[] = []
  parent: FakeEl | null = null
  dataset: Record<string, string> = {}
  style = new FakeStyle()
  clientWidth = 0
  clientHeight = 0
  writes = 0 // style writes, all of them
  readonly ownerDocument: { createElement: (tag: string) => FakeEl }
  constructor(doc: { createElement: (tag: string) => FakeEl }) {
    this.ownerDocument = doc
    const set = this.style.setProperty.bind(this.style)
    this.style.setProperty = (k: string, v: string) => { this.writes++; set(k, v) }
  }
  append(...cs: FakeEl[]): void { for (const c of cs) { c.parent = this; this.children.push(c) } }
  replaceChildren(...cs: FakeEl[]): void { this.children = []; this.append(...cs) }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null }
}

function overlayRig(w = 1600, h = 900) {
  const doc = { createElement: (): FakeEl => new FakeEl(doc) }
  const parent = new FakeEl(doc)
  parent.clientWidth = w
  parent.clientHeight = h
  const p = new Precipitation(parent as unknown as HTMLElement, { image: (k) => `${k}.png` })
  const overlay = (): FakeEl | undefined => parent.children.find((c) => c.className === 'fh-precip')
  const tilt = (): FakeEl => overlay()!.children[0]
  const layers = (): FakeEl[] => tilt().children.map((sway) => sway.children[0])
  return { p, parent, overlay, tilt, layers }
}
const fall = (o: Partial<Fall> = {}): Fall => ({ kind: 'rain', intensity: 0.5, wind: { east: 0, north: 0 }, night: 0, ...o })
const px = (v: string): number => Number(v.replace('px', ''))

test('Precipitation: one overlay over the view, hidden until something falls; rain: layers of the rain texture, the near ones larger and faster; its opacity by intensity', () => {
  const r = overlayRig()
  const o = r.overlay()!
  assert.equal(o.hidden, true)
  r.p.set(null)
  assert.equal(o.hidden, true)
  r.p.set(fall())
  assert.equal(o.hidden, false)
  assert.equal(o.dataset.kind, 'rain')
  assert.equal(o.style.getPropertyValue('opacity'), String(overlayOpacity(fall())))
  assert.equal(r.tilt().className, 'fh-precip-tilt')
  const ls = r.layers()
  assert.equal(ls.length, OVERLAY.rain.layers.length)
  const speeds: number[] = []
  ls.forEach((l, i) => {
    const look = OVERLAY.rain.layers[i]
    assert.equal(l.className, 'fh-precip-layer')
    assert.equal(l.style.getPropertyValue('background-image'), 'url("rain.png")')
    const th = OVERLAY.rain.tile[1] * look.scale
    assert.equal(l.style.getPropertyValue('background-size'), `${OVERLAY.rain.tile[0] * look.scale}px ${th}px`)
    assert.equal(px(l.style.getPropertyValue('--fall')), th, 'falls one tile a loop: seamless')
    assert.equal(l.style.getPropertyValue('--fall-s'), `${look.fallS}s`)
    assert.equal(l.style.getPropertyValue('opacity'), String(look.alpha))
    assert.equal(l.parent!.className, 'fh-precip-sway')
    assert.equal(l.parent!.style.getPropertyValue('animation-name'), 'none', 'rain does not sway')
    speeds.push(th / look.fallS)
  })
  for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i] < speeds[i - 1] && OVERLAY.rain.layers[i].scale < OVERLAY.rain.layers[i - 1].scale, 'the farther layers smaller and slower')
  r.p.set(fall({ intensity: 1 }))
  assert.equal(r.layers()[0], ls[0], 'harder rain: the same layers')
  assert.equal(o.style.getPropertyValue('opacity'), String(overlayOpacity(fall({ intensity: 1 }))))
  r.p.set(null)
  assert.equal(o.hidden, true)
})

test('Precipitation: snow: its own texture, falling slower, each layer swaying sideways; another kind builds the layers anew', () => {
  const r = overlayRig()
  r.p.set(fall())
  const rain = r.layers()
  r.p.set(fall({ kind: 'snow' }))
  const ls = r.layers()
  assert.notEqual(ls[0], rain[0])
  assert.equal(r.overlay()!.dataset.kind, 'snow')
  assert.equal(ls.length, OVERLAY.snow.layers.length)
  ls.forEach((l, i) => {
    const look = OVERLAY.snow.layers[i]
    assert.equal(l.style.getPropertyValue('background-image'), 'url("snow.png")')
    assert.equal(l.parent!.style.getPropertyValue('--sway'), `${look.swayPx}px`)
    assert.equal(l.parent!.style.getPropertyValue('--sway-s'), `${look.swayS}s`)
    assert.ok(OVERLAY.snow.tile[1] * look.scale / look.fallS < OVERLAY.rain.tile[1] * OVERLAY.rain.layers[i].scale / OVERLAY.rain.layers[i].fallS / 5, 'far slower than rain')
  })
})

test('Precipitation: aim leans the fall with the wind across the view, in whole degrees, the turned layer sized to cover the view; nothing written for no change', () => {
  const r = overlayRig(1600, 900)
  r.p.aim(0)
  assert.equal(r.tilt().style.getPropertyValue('--tilt'), '', 'nothing falling: nothing to aim')
  r.p.set(fall({ wind: { east: 3, north: 0 } }))
  r.p.aim(0)
  const deg = Math.round(tiltDeg('rain', { east: 3, north: 0 }, 0))
  assert.equal(r.tilt().style.getPropertyValue('--tilt'), `${deg}deg`)
  const [w, h] = coverSize(1600, 900, deg)
  assert.deepEqual([r.tilt().style.getPropertyValue('width'), r.tilt().style.getPropertyValue('height')], [`${w}px`, `${h}px`])
  const writes = r.tilt().writes
  r.p.aim(0.001)
  assert.equal(r.tilt().writes, writes, 'the same whole degree, the same view: no writes')
  r.parent.clientWidth = 1000
  r.p.aim(0.001)
  assert.equal(r.tilt().style.getPropertyValue('width'), `${coverSize(1000, 900, deg)[0]}px`, 'the view resized: sized again')
  r.p.aim(Math.PI)
  assert.equal(r.tilt().style.getPropertyValue('--tilt'), `${-deg}deg`)
  r.p.set(fall({ kind: 'snow', wind: { east: 3, north: 0 } }))
  r.p.aim(Math.PI)
  assert.equal(r.tilt().style.getPropertyValue('--tilt'), `${Math.round(tiltDeg('snow', { east: 3, north: 0 }, Math.PI))}deg`, 'snow leans by its own fall: aimed again')
  r.p.destroy()
  assert.equal(r.overlay(), undefined, 'destroy takes the overlay away')
  r.p.set(fall())
  r.p.aim(0)
  assert.equal(r.overlay(), undefined, 'and stays down')
})

test('layout.css: the overlay sits under the place names (z 3), takes no pointer, moves by transforms alone, and holds still for reduced motion', () => {
  const css = readFileSync(new URL('../ui/layout.css', import.meta.url), 'utf8')
  const block = (sel: string): string => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)))
  assert.match(block('.fh-precip'), /z-index: 3;/)
  assert.match(block('.fh-precip'), /pointer-events: none;/)
  assert.match(block('.fh-precip-tilt'), /rotate\(var\(--tilt/)
  assert.match(block('.fh-precip-layer'), /animation: fh-precip-fall var\(--fall-s/)
  assert.match(block('.fh-precip-sway'), /animation: fh-precip-sway var\(--sway-s/)
  assert.match(css, /@keyframes fh-precip-fall \{[^}]*translate3d\(0, var\(--fall/)
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.fh-precip')))
  assert.match(reduced.slice(0, 400), /\.fh-precip-layer[\s\S]*animation: none/)
})
