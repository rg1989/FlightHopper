// client/scene/wxDemo.ts
// The demo sky (?wxdemo=1): a made-up sky for checking the weather volumes without asking for any weather, as cloud specs and one
// SIGMET, the same as the real sources give. Pure (no Cesium, no DOM), so Node tests cover it. It is the approved mock's scene
// (.planning/mocks/chase-weather-mocks.html) in real units, laid along the track from the place it is built for (along: km ahead of it,
// right: km to the right of the track): scattered small cumulus (base about 1,500 m) from 0 to 40 km ahead and to the sides, a
// few of them close to the track; a layer of light rain from 7,000 to 8,700 m, 50 to 76 km ahead, a deck of overlapping flat puffs;
// a thunderstorm 100 km ahead on the track, 1,000 to 11,000 m, its core (3) in towers of heavy rain (2) and crowned by an anvil; a
// smaller storm 25 km to the left at 88 km; and a SIGMET of embedded thunderstorms, to FL340, in a ring that starts 80 km ahead and
// holds both storms. The storms are cloudField.ts's own towers (tower). Every draw comes from one seeded sequence, in a fixed
// order: the same call gives the same sky, and a call from another place or track gives the same sky moved and turned.
import type { Sigmet } from '../../shared/wx.ts'
import { LOOKS, PUFF_FILL, RADAR_LOOK, SEV, between, farKmOf, sequence, tower, type CloudSpec } from './cloudField.ts'
import { softSlice } from './cloudQuad.ts'
import { wrapLon } from './wxGeo.ts'

const KM_PER_DEG = 111.195 // of latitude, on a sphere of 6,371 km
const RAD = Math.PI / 180
const SEED = 20261003
const CUMULUS_BASE_M = 1500
const STORM_BASE_M = 1000
const SIGMET_TOP_FT = 34000
/** The SIGMET's ring, [along, right] km: starts 80 km ahead, and holds both storms with their anvils. */
const RING: readonly (readonly [number, number])[] = [[80, -38], [112, -46], [138, -14], [130, 26], [80, 22]]

type Range = readonly [number, number]
interface Look {
  shape: readonly [Range, Range, Range]
  slice: Range
  brightness: Range
  tint: Range
}

/** The place `along` km ahead of lat, lon on trackDeg and `right` km to the right of that track, on the plane round lat, lon. */
function place(lat: number, lon: number, trackDeg: number, along: number, right: number): { lat: number; lon: number } {
  const t = trackDeg * RAD
  const east = along * Math.sin(t) + right * Math.cos(t)
  const north = along * Math.cos(t) - right * Math.sin(t)
  return { lat: lat + north / KM_PER_DEG, lon: wrapLon(lon + east / (KM_PER_DEG * Math.max(0.01, Math.cos(lat * RAD)))) }
}

/** A puff standing from baseM to topM, wide metres across, drawn from its look. */
function puff(r: () => number, at: { lat: number; lon: number }, baseM: number, topM: number, wide: number, look: Look, sev: number): CloudSpec {
  const h = (topM - baseM) / PUFF_FILL
  const maxSize: [number, number, number] = [between(r, look.shape[0]), between(r, look.shape[1]), between(r, look.shape[2])]
  return {
    ...at, heightM: (baseM + topM) / 2, groundM: 0, scale: [wide, h], maxSize, slice: softSlice(maxSize, between(r, look.slice)),
    brightness: between(r, look.brightness), tint: between(r, look.tint), farKm: farKmOf(Math.max(wide, h)), sev,
  }
}

/**
 * The demo sky for an aircraft at lat, lon on trackDeg (degrees true), and its one SIGMET. See the header for what is in it.
 */
export function demoSky(lat: number, lon: number, trackDeg: number): { specs: CloudSpec[]; sigmets: Sigmet[] } {
  const r = sequence(SEED)
  const at = (along: number, right: number): { lat: number; lon: number } => place(lat, lon, trackDeg, along, right)
  const specs: CloudSpec[] = []

  const cumulus: Look = { shape: LOOKS.FEW.shape, slice: LOOKS.FEW.slice, brightness: LOOKS.FEW.brightness, tint: LOOKS.FEW.tint }
  const small = (along: number, right: number): void => {
    const base = CUMULUS_BASE_M + (r() - 0.5) * 200
    const wide = between(r, [1500, 4000])
    specs.push(puff(r, at(along, right), base, base + PUFF_FILL * between(r, [600, 1600]), wide, cumulus, SEV.cloud))
  }
  for (const [along, right] of [[6, 0.5], [9.5, -2.5], [11, 3]]) small(along, right) // close to the track: flown through early
  for (let i = 0; i < 70; i++) small(r() * 40, (r() - 0.5) * 90)

  const deck: Look = { shape: RADAR_LOOK.deck.shape, slice: RADAR_LOOK.deck.slice, brightness: RADAR_LOOK.deck.brightness, tint: RADAR_LOOK.deck.tint }
  for (let c = 0; c < 7; c++) {
    for (let row = 0; row < 13; row++) {
      const base = 7000 + (r() - 0.5) * 200
      const topM = 8700 + (r() - 0.5) * 200
      specs.push(puff(r, at(50 + 4.33 * c + (r() - 0.5) * 2, -25 + 4 * row + (r() - 0.5) * 2), base, topM, between(r, [9000, 12000]), deck, SEV.light))
    }
  }

  let id = 0
  /** A storm: a core tower (3) with an anvil, and `shell` towers of heavy rain (2) round it. */
  const storm = (along: number, right: number, core: { w: number; h: number; anvil: number }, shell: { n: number; w: number; h: number; km: number }): void => {
    const centre = at(along, right)
    tower(specs, { ...centre, baseM: STORM_BASE_M, groundM: 0, heightM: core.h, widthM: core.w, anvilM: core.w * core.anvil, baseTint: 0.65, sev: SEV.storm, id: id++ }, r)
    const turn = 2 * Math.PI * r()
    for (let n = 0; n < shell.n; n++) {
      const a = turn + (2 * Math.PI * n) / shell.n + (r() - 0.5) * 0.5
      const d = shell.km * (0.85 + 0.3 * r())
      const h = shell.h * (0.85 + 0.3 * r())
      tower(specs, { ...at(along + d * Math.cos(a), right + d * Math.sin(a)), baseM: STORM_BASE_M, groundM: 0, heightM: h, widthM: shell.w, anvilM: 0, baseTint: 0.5, sev: SEV.heavy, id: id++ }, r)
    }
  }
  storm(100, 0, { w: 9000, h: 10000, anvil: 3 }, { n: 6, w: 7000, h: 7000, km: 7.5 })
  storm(88, -25, { w: 6000, h: 8000, anvil: 2.5 }, { n: 4, w: 5000, h: 5500, km: 5 })

  const sigmets: Sigmet[] = [{
    hazard: 'TS', qualifier: 'EMBD', base: null, top: SIGMET_TOP_FT, until: '', raw: `WXDEMO: embedded thunderstorms, top FL${SIGMET_TOP_FT / 100} (made up)`,
    rings: [RING.map(([along, right]): [number, number] => { const p = at(along, right); return [p.lon, p.lat] })],
  }]
  return { specs, sigmets }
}
