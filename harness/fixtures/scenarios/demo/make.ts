// harness/fixtures/scenarios/demo/make.ts
// Writes track.csv of the synthetic demo scenario (a test package, not a real flight): three minutes at 1 Hz from the
// old runway 15L at Tokyo Haneda. A take-off roll on the ground (gnd=1), rotation and lift-off, a climb, then a right
// turn at 25° of bank with a decaying roll-and-yaw wiggle of an 11 s period (a Dutch roll's look), and a roll-out.
// The numbers are made up; only their shape matters to the app and its tests. Run: node harness/fixtures/scenarios/demo/make.ts
import { writeFileSync } from 'node:fs'

const START = { lat: 35.56189, lon: 139.76002 } // the 1985 runway 15L threshold (tools/scenarios/jal123/anchors.csv)
const RWY_DEG = 145.4 // its true course
const ELEV_FT = 21
const N = 180 // rows 0…180 s: 10:00:00 → 10:03:00
const G = 9.80665
const KT = 1852 / 3600
const SUB = 20 // integration sub-steps per second

const clock = (s: number): string => {
  const h = 10 + Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const smooth = (a: number, b: number, t: number): number => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)))
  return u * u * (3 - 2 * u)
}

/** The flight at t (s): speed, vertical speed, bank, pitch and the wiggle. */
function at(t: number): { iasKt: number; vsFpm: number; bankDeg: number; wiggleRollDeg: number; wiggleYawDeg: number; pitchDeg: number; gnd: boolean; epr: number } {
  const gnd = t < 44
  const iasKt = t < 4 ? 0 : t < 44 ? 4 * (t - 4) : Math.min(210, 160 + 0.8 * (t - 44))
  const vsFpm = gnd ? 0 : 2500 * smooth(44, 50, t) - 1000 * smooth(100, 106, t)
  const bankDeg = 25 * (smooth(100, 105, t) - smooth(155, 160, t))
  const k = t >= 110 && t < 160 ? Math.exp(-(t - 110) / 40) * smooth(110, 113, t) * (1 - smooth(155, 160, t)) : 0
  const w = (2 * Math.PI * (t - 110)) / 11
  const pitchDeg = gnd ? 8 * smooth(40, 44, t) : 8 + 4 * smooth(44, 52, t) - 4 * smooth(100, 106, t)
  const epr = t < 4 ? 1.02 : t < 10 ? 1.02 + 0.43 * smooth(4, 10, t) : t < 100 ? 1.45 - 0.1 * smooth(60, 70, t) : 1.3
  return { iasKt, vsFpm, bankDeg, wiggleRollDeg: 7 * k * Math.sin(w), wiggleYawDeg: 2.5 * k * Math.sin(w - Math.PI / 2), pitchDeg, gnd, epr }
}

const rows: string[] = ['time,lat,lon,alt_ft,hdg,pitch,roll,gnd,ias_kt,vs_fpm,g,wind_dir,wind_kt,epr1,epr2,epr3,epr4,q,src']
let lat = START.lat
let lon = START.lon
let altFt = ELEV_FT
let track = RWY_DEG // course over the ground (the wind is left out of the path)
for (let s = 0; s <= N; s++) {
  const f = at(s)
  const hdg = (((track + f.wiggleYawDeg) % 360) + 360) % 360
  const roll = f.bankDeg + f.wiggleRollDeg
  const g = f.gnd ? 1 : 1 / Math.cos((f.bankDeg * Math.PI) / 180)
  const eprs = [f.epr, f.epr + 0.01, f.epr - 0.02, f.epr].map((e) => e.toFixed(2))
  rows.push([
    clock(s), lat.toFixed(6), lon.toFixed(6), altFt.toFixed(0), hdg.toFixed(1), f.pitchDeg.toFixed(1), roll.toFixed(1), f.gnd ? '1' : '0',
    f.iasKt.toFixed(0), f.vsFpm.toFixed(0), g.toFixed(2), '220', '15', ...eprs, 'R', 'S',
  ].join(','))
  // To the next row: move along the course, turn at the bank's rate (g·tan φ / v), climb at the vertical speed.
  for (let i = 0; i < SUB; i++) {
    const tt = s + i / SUB
    const a = at(tt)
    const v = a.iasKt * KT
    const dt = 1 / SUB
    if (v > 1) track += ((G * Math.tan((a.bankDeg * Math.PI) / 180)) / v) * (180 / Math.PI) * dt
    const d = v * dt
    lat += (d * Math.cos((track * Math.PI) / 180)) / 111_320
    lon += (d * Math.sin((track * Math.PI) / 180)) / (111_320 * Math.cos((lat * Math.PI) / 180))
    altFt += (a.vsFpm / 60) * dt
  }
}
writeFileSync(new URL('./track.csv', import.meta.url), rows.join('\n') + '\n')
console.log(`track.csv: ${rows.length - 1} rows, last ${rows.at(-1)}`)
