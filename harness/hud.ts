// harness/hud.ts
// WP-V6 harness: /harness/hud.html shows the HUD, banner and attribution for fixed scenarios over imagery-like
// backgrounds. "play" runs the per-frame path: age −2 → 16 s, interp → extrap (0 s) → stale (8 s), every animation frame.
import type { StatusBrief } from '../shared/api.ts'
import type { RenderState } from '../client/types.ts'
import { mountAttribution, mountBanner } from '../client/ui/banner.ts'
import { mountHud } from '../client/ui/hud.ts'

const base: RenderState = {
  hex: 'a1b2c3', lat: 37.6, lon: -122.3, hM: 640, headingDeg: 284.4, pitchDeg: -2, rollDeg: 0, gsKt: 146.2, trackDeg: 281.7,
  altBaroFt: 2175, vsFpm: -742, mode: 'interp', altSource: 'geom', onGround: false, ageS: -1.3, quality: 'adsb2',
  callsign: 'UAL123', typeCode: 'B738',
}
const live: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: 2.1, chasePeriodP95S: 1.1 }

const scenarios: Record<string, [RenderState | null, StatusBrief]> = {
  interp: [base, live],
  'baro height': [{ ...base, altSource: 'baro-qnh' }, live],
  extrap: [{ ...base, mode: 'extrap', ageS: 3.4 }, live],
  stale: [{ ...base, mode: 'stale', ageS: 14.2 }, live],
  'on ground': [{ ...base, onGround: true, altBaroFt: null, gsKt: 12, vsFpm: 0 }, live],
  'MLAT + nulls': [{ ...base, quality: 'mlat', gsKt: null, trackDeg: null, vsFpm: null, callsign: null }, live],
  replay: [base, { ...live, source: 'replay' }],
  blocked: [base, { ...live, degraded: 'blocked' }],
  'rate-limited': [base, { ...live, degraded: 'rate-limited' }],
  'upstream-down': [base, { ...live, degraded: 'upstream-down' }],
  'no selection': [null, live],
}

const hud = mountHud(document.body)
const banner = mountBanner(document.body)
mountAttribution(document.body, ['Aircraft data © adsb.lol contributors (ODbL)', 'Airports: OurAirports (public domain)'])

let raf = 0
function show([s, status]: [RenderState | null, StatusBrief]): void {
  hud.update(s, status)
  banner.update(status, s)
}
function play(t0: number): void {
  const frame = (now: number): void => {
    const ageS = (((now - t0) / 1000) % 18) - 2
    show([{ ...base, ageS, mode: ageS <= 0 ? 'interp' : ageS <= 8 ? 'extrap' : 'stale' }, live])
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
}

const controls = document.getElementById('controls')!
function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  b.onclick = () => {
    for (const x of controls.querySelectorAll('button')) if (x.dataset.group === b.dataset.group) x.setAttribute('aria-pressed', 'false')
    b.setAttribute('aria-pressed', 'true')
    onClick()
  }
  controls.append(b)
  return b
}
for (const [name, sc] of Object.entries(scenarios)) button(name, () => (cancelAnimationFrame(raf), show(sc))).dataset.group = 'scenario'
button('play', () => (cancelAnimationFrame(raf), play(performance.now()))).dataset.group = 'scenario'
for (const bg of ['snow', 'sea', 'terrain', 'stripes']) button(`bg: ${bg}`, () => (document.body.dataset.bg = bg)).dataset.group = 'bg'
show(scenarios.interp)
;(window as unknown as { harness: object }).harness = { hud, banner, scenarios, show }
