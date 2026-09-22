// harness/detail.ts
// WP-B-U2 harness: /harness/detail.html shows the detail panel, with the chase HUD to check that they do not overlap, for
// a real adsb.lol aircraft object over map-like backgrounds. The golden aircraft's photo is asked from the real
// planespotters.net API (one request per page load, only for that hex); when the API refuses (it sometimes answers
// without CORS headers) the panel reads "Photo unavailable". ?photos=off answers "no photo" offline, and ?photos=demo
// shows a local placeholder drawing (not a planespotters photo) to check the photo layout without the network.
// "play" calls update() every frame, like the app, and reports its cost and how often the text is rewritten; "bench"
// times the throttled path, full renders and detailRows().
import type { StatusBrief } from '../shared/api.ts'
import { toInfo } from '../shared/info.ts'
import type { AircraftInfo } from '../shared/info.ts'
import type { ReadsbAircraft } from '../shared/types.ts'
import type { RenderState } from '../client/types.ts'
import { detailRows, mountDetail } from '../client/ui/detail.ts'
import type { Lookup } from '../client/ui/detail.ts'
import { mountHud } from '../client/ui/hud.ts'
import { PhotoCache } from '../client/ui/photo.ts'

// A real adsb.lol /v2/point object (LLBG cell, 2026-09-22; © adsb.lol contributors, ODbL 1.0), as in detail.test.ts.
const RAW: ReadsbAircraft = {
  hex: '4691c4', type: 'adsb_icao', flight: 'AEE4266 ', r: 'SX-DND', t: 'A320', alt_baro: 7975, alt_geom: 8500, gs: 337.1,
  ias: 280, tas: 322, mach: 0.488, wd: 231, ws: 24, oat: 14, tat: 27, track: 101.81, track_rate: 0.06, roll: 0.53,
  mag_heading: 100.2, true_heading: 105.24, baro_rate: -960, geom_rate: -928, squawk: '7421', emergency: 'none',
  category: 'A3', nav_qnh: 1012.0, nav_altitude_mcp: 4992, lat: 32.371902, lon: 34.43291, nic: 8, rc: 186, seen_pos: 0.09,
  version: 2, nic_baro: 1, nac_p: 9, nac_v: 1, sil: 3, gva: 2, sda: 2, mlat: [], tisb: [], messages: 9956, seen: 0.0, rssi: -4.0,
}
const INFO = toInfo(RAW, 'LGAV-LLBG') // route made up for the harness
const S: RenderState = {
  hex: '4691c4', lat: 32.371902, lon: 34.43291, hM: 2620, headingDeg: 105.24, pitchDeg: -1.5, rollDeg: 0.5, gsKt: 337.1,
  trackDeg: 101.81, altBaroFt: 7975, vsFpm: -951, mode: 'interp', altSource: 'geom', onGround: false, ageS: -0.8,
  quality: 'adsb2', callsign: 'AEE4266', typeCode: 'A320',
}
// Synthetic (made-up hex and registration) sparse MLAT target, and a non-ICAO TIS-B one.
const MLAT_RAW: ReadsbAircraft = {
  hex: '73fffe', type: 'mlat', flight: 'ELY9999 ', r: '4X-ZZZ', t: 'B789', alt_baro: 37000, gs: 481, track: 291.4,
  lat: 33.104, lon: 33.512, mlat: ['lat', 'lon', 'gs', 'track'], messages: 1204, seen: 3.2, seen_pos: 3.2, rssi: -21.5,
}
const TISB_RAW: ReadsbAircraft = { hex: '~a330e6', type: 'tisb_other', alt_baro: 2500, gs: 110, track: 15, lat: 32.1, lon: 34.9, seen: 1.1, seen_pos: 1.1 }

const live: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: 12, chasePeriodP95S: 12 }
type Scene = [RenderState | null, ReadsbAircraft | null, AircraftInfo | null]

const emergency = { ...RAW, squawk: '7700', emergency: 'general' }
const scenarios: Record<string, Scene> = {
  golden: [S, RAW, INFO],
  'raw only': [null, RAW, null],
  'squawk 7700': [S, emergency, toInfo(emergency, INFO.route)],
  'ground, v0': [{ ...S, onGround: true, altBaroFt: null, gsKt: 12, vsFpm: 0 }, { ...RAW, alt_baro: 'ground', gs: 12, baro_rate: 0, version: 0 }, INFO],
  'MLAT, sparse': [{ ...S, hex: MLAT_RAW.hex, quality: 'mlat', callsign: 'ELY9999', typeCode: 'B789', altBaroFt: 37000, gsKt: 481, vsFpm: 0, trackDeg: 291.4, lat: 33.104, lon: 33.512 }, MLAT_RAW, null],
  'non-ICAO ~': [null, TISB_RAW, null],
  'nothing selected': [null, null, null],
}

const params = new URLSearchParams(location.search)
const photoMode = params.get('photos') ?? 'real' // real | off | demo
let realRequests = 0
// Only the golden hex may reach planespotters.net; every other hex (and ?photos=off|demo) gets "no photo" locally.
const photos = new PhotoCache((input, init) => {
  if (photoMode === 'real' && String(input).endsWith('/4691C4')) {
    realRequests++
    return fetch(input, init)
  }
  return Promise.resolve(new Response('{"photos":[]}', { status: 200 }))
})
// A 3:2 placeholder drawn here (sky, runway, a generic airliner side view), for ?photos=demo only. It goes around
// toPhoto's https check on purpose: this is a layout check, not a planespotters answer.
const DEMO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 280"><defs><linearGradient id="k" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#5b8fc7"/><stop offset="1" stop-color="#cfe3f3"/></linearGradient></defs>
<rect width="420" height="280" fill="url(#k)"/><rect y="226" width="420" height="54" fill="#6f7a63"/><rect y="240" width="420" height="14" fill="#44474a"/>
<g fill="#f4f6f8" stroke="#8c96a0" stroke-width="1.5"><path d="M60 150 Q48 150 44 160 Q48 172 64 172 L330 172 Q364 170 372 160 Q364 150 330 148 Z"/>
<path d="M74 150 L50 92 L78 92 L118 150 Z"/><path d="M180 166 L250 166 L200 204 L172 204 Z"/><ellipse cx="226" cy="186" rx="26" ry="10"/></g>
<g fill="#33495e">${Array.from({ length: 22 }, (_, i) => `<rect x="${112 + i * 10}" y="155" width="5" height="6" rx="2"/>`).join('')}</g>
<text x="210" y="40" text-anchor="middle" font-family="system-ui" font-size="18" fill="#fff">DEMO PLACEHOLDER</text></svg>`
if (photoMode === 'demo') {
  photos.get = (hex) =>
    Promise.resolve(hex === '4691c4' ? {
      thumbUrl: `data:image/svg+xml,${encodeURIComponent(DEMO_SVG)}`,
      link: 'https://www.planespotters.net/photos/reg/SX-DND',
      photographer: 'demo placeholder, not a planespotters photo',
    } : null)
}

// B-A wires countryOf/flagEmoji (B-C1) and airlineOf (B-C2) here. This package depends only on B0, so the harness
// answers for its own scenario hexes: 468000–46FFFF is Greece and 738000–73FFFF Israel (ICAO Annex 10 allocation).
const LOOKUPS: Record<string, Lookup> = {
  '4691c4': { country: { iso2: 'GR', name: 'Greece', flag: '🇬🇷' }, airline: 'Aegean Airlines' },
  '73fffe': { country: { iso2: 'IL', name: 'Israel', flag: '🇮🇱' }, airline: 'El Al Israel Airlines' },
}
function lookup(hex: string, callsign: string | null): Lookup {
  const hit = LOOKUPS[hex]
  // The airline follows the callsign, as airlineOf does: a changed or missing callsign loses it.
  return hit ? { country: hit.country, airline: callsign === null ? null : hit.airline } : { country: null, airline: null }
}

const stage = document.getElementById('stage')!
const stats = document.getElementById('stats')!
const controls = document.getElementById('controls')!
let current: Scene = scenarios.golden
let note = ''
const detail = mountDetail(stage, {
  onClose: () => {
    stop()
    current = scenarios['nothing selected']
    note = 'closed with ×'
    show()
  },
  photos,
  lookup,
})
const hud = mountHud(stage)
;(window as unknown as { fhDetail: unknown }).fhDetail = { detail, scenarios, photos } // for poking from the console

function show(): void {
  detail.update(...current)
  hud.update(current[0], live)
  report()
}

let photoOutcome = 'pending'
function report(extra = ''): void {
  const head = `photos=${photoMode}: ${realRequests} planespotters request(s) this page, golden photo ${photoOutcome}`
  stats.textContent = [head, note, extra].filter((l) => l).join('\n')
}

// ---------- play: update() every frame, as the app calls it ----------
let raf = 0
let observer: MutationObserver | null = null
function stop(): void {
  cancelAnimationFrame(raf)
  raf = 0
  observer?.disconnect()
  observer = null
}
function play(): void {
  stop()
  current = scenarios.golden
  show()
  const gsValue = stage.querySelector('[data-key="gs"] .fh-detail-value')!
  let rewrites = 0
  observer = new MutationObserver((records) => (rewrites += records.length))
  observer.observe(gsValue, { childList: true, characterData: true, subtree: true })
  const t0 = performance.now()
  let last = t0
  let frames = 0
  let updateMs = 0
  const frameMs: number[] = []
  const frame = (now: number): void => {
    const t = (now - t0) / 1000
    frameMs.push(now - last)
    last = now
    // A new state every frame. Groundspeed moves 40 kt/s, so every render (≤ 4/s) changes its text and the rewrite
    // count below is the render count.
    const s: RenderState = { ...S, gsKt: 300 + ((t * 40) % 200), altBaroFt: 7975 - t * 16, lat: S.lat + t * 1e-4, lon: S.lon + t * 5e-4 }
    const a = performance.now()
    detail.update(s, RAW, INFO)
    updateMs += performance.now() - a
    hud.update(s, live)
    frames++
    if (frames % 60 === 0) {
      const sorted = [...frameMs].sort((x, y) => x - y)
      const fps = (1000 * frames) / (now - t0)
      report(
        `play: ${frames} frames in ${t.toFixed(1)} s, ${fps.toFixed(0)} fps, frame p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} ms\n` +
          `detail.update(): mean ${((updateMs / frames) * 1000).toFixed(1)} µs/frame\n` +
          `groundspeed text rewritten ${rewrites} times = ${(rewrites / t).toFixed(2)}/s (limit 4/s)`,
      )
    }
    if (raf !== 0) raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
}

// ---------- bench: the throttled path, full renders, detailRows ----------
function bench(): void {
  stop()
  const box = document.createElement('div')
  box.style.cssText = 'position:absolute;left:-10000px;top:0;width:400px;height:900px'
  document.body.append(box)
  const d = mountDetail(box, { onClose() {}, lookup })
  const lines: string[] = []
  // 1. Same aircraft, called far more often than 4/s: all but the first call only check the clock.
  d.update(S, RAW, INFO)
  const n1 = 200_000
  let a = performance.now()
  for (let i = 0; i < n1; i++) d.update(S, RAW, INFO)
  let ms = performance.now() - a
  lines.push(`update() throttled: ${((ms / n1) * 1e6).toFixed(0)} ns/call (${n1} calls, ${ms.toFixed(1)} ms)`)
  // 2. Alternate two aircraft: every call is a new selection, so every call renders every row.
  const other: Scene = scenarios['MLAT, sparse']
  const n2 = 5_000
  a = performance.now()
  for (let i = 0; i < n2; i++) {
    if (i % 2) d.update(...other)
    else d.update(S, RAW, INFO)
  }
  ms = performance.now() - a
  lines.push(`full render: ${((ms / n2) * 1000).toFixed(1)} µs (${n2} renders, ${ms.toFixed(1)} ms)`)
  // 3. The pure text alone.
  const gr = lookup('4691c4', 'AEE4266')
  const n3 = 50_000
  a = performance.now()
  let rows = 0
  for (let i = 0; i < n3; i++) rows += detailRows(S, RAW, INFO, gr).length
  ms = performance.now() - a
  lines.push(`detailRows(): ${((ms / n3) * 1000).toFixed(2)} µs (${n3} calls, ${rows / n3} sections)`)
  d.destroy()
  box.remove()
  report(`bench:\n${lines.join('\n')}`)
  console.log('[detail bench]', lines.join(' | '))
}

function button(label: string, pressedGroup: string | null, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  if (pressedGroup) b.dataset.group = pressedGroup
  b.addEventListener('click', () => {
    if (pressedGroup) {
      for (const o of controls.querySelectorAll<HTMLButtonElement>(`button[data-group="${pressedGroup}"]`)) o.setAttribute('aria-pressed', String(o === b))
    }
    onClick()
  })
  controls.append(b)
  return b
}

for (const [name, scene] of Object.entries(scenarios)) {
  const b = button(name, 'scene', () => {
    stop()
    current = scene
    note = ''
    show()
  })
  if (name === 'golden') b.setAttribute('aria-pressed', 'true')
}
button('play', 'scene', play)
button('bench', null, bench)
for (const bg of ['map', 'satellite', 'snow']) button(`bg: ${bg}`, 'bg', () => (document.body.dataset.bg = bg))

show()
// The photo request resolves after the first render: report its outcome once it has settled.
photos.get(RAW.hex).then((p) => {
  photoOutcome = p ? 'shown' : photos.failed(RAW.hex) ? 'failed (see the console)' : 'none on planespotters'
  report()
})
