// harness/table.ts
// WP-B-U1 harness: /harness/table.html mounts the aircraft table over a map-like background and drives it every
// animation frame with N synthetic aircraft (default 5,000; ?n=12000) whose altitude, speed and squawk change like live
// data, reusing the same objects the way Fleet does. It measures update() on every frame (p50/p95/max, plus the
// per-second maximum, which is the frame that re-sorts), frame intervals, long tasks, and a scripted scroll test.
// Everything is also on window.harness for console checks.
import type { AircraftInfo } from '../shared/info.ts'
import type { FleetEntry } from '../client/types.ts'
import { mountTable } from '../client/ui/table.ts'

// Seeded PRNG (mulberry32), so every run shows the same fleet.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(20260922)
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]

// Harness stand-in for the app's flagOf (B-A injects B-C1's countryOf + flagEmoji). A few ICAO address blocks
// (ICAO Annex 10 Vol. III, Table 9-1) so the synthetic hexes get plausible flags; illustrative only.
const BLOCKS: [string, string][] = [['a', 'US'], ['3c', 'DE'], ['40', 'GB'], ['738', 'IL'], ['4b0', 'CH'], ['06a', 'QA'], ['4a8', 'RO']]
const flagEmoji = (iso2: string): string => String.fromCodePoint(...[...iso2].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
const flagCache = new Map<string, string>()
function flagOf(hex: string): string {
  let f = flagCache.get(hex)
  if (f === undefined) {
    const b = BLOCKS.find(([p]) => hex.startsWith(p))
    flagCache.set(hex, (f = b === undefined ? '' : flagEmoji(b[1])))
  }
  return f
}

const AIRLINES = ['ELY', 'UAL', 'DLH', 'BAW', 'QTR', 'ROT', 'SWR', 'RYR', 'WZZ', 'AAL', 'ISR', 'EZY']
const AIRPORTS = ['LLBG', 'LROP', 'OTHH', 'EGLL', 'EDDF', 'KJFK', 'LSZH', 'LOWW', 'EHAM', 'LFPG', 'LTFM', 'KSFO']
const TYPES = ['B738', 'A320', 'A21N', 'B789', 'A359', 'E190', 'B77W', 'A333', 'C172', 'AT76', 'B38M', 'A20N']
const EMERGENCY = ['7500', '7600', '7700']

const usedHexes = new Set<string>() // hexes are unique, as in Fleet
function newHex(): string {
  for (;;) {
    const [prefix] = pick(BLOCKS.concat([['', '']]))
    let h = prefix
    while (h.length < 6) h += Math.floor(rand() * 16).toString(16)
    if (usedHexes.has(h)) continue
    usedHexes.add(h)
    return h
  }
}

function newInfo(hex: string): AircraftInfo {
  const noCallsign = rand() < 0.03
  const squawk = rand() < 0.002 ? pick(EMERGENCY) : Math.floor(rand() * 4096).toString(8).padStart(4, '0')
  const from = pick(AIRPORTS)
  let to = pick(AIRPORTS)
  if (to === from) to = 'LOWI'
  return {
    hex,
    callsign: noCallsign ? null : `${pick(AIRLINES)}${Math.floor(rand() * 9000) + 1}`,
    reg: `${pick(['N', '4X-', 'D-', 'G-', 'YR-', 'A7-', 'HB-'])}${Math.floor(rand() * 46656).toString(36).toUpperCase().padStart(3, 'A')}`,
    typeCode: rand() < 0.05 ? null : pick(TYPES),
    category: 'A3',
    squawk,
    emergency: null,
    military: false,
    route: rand() < 0.2 ? null : `${from}-${to}`,
  }
}

function newEntry(): FleetEntry {
  const hex = newHex()
  const onGround = rand() < 0.05
  return {
    hex, lat: 20 + rand() * 45, lon: -30 + rand() * 90, hM: 0,
    altFt: onGround ? null : Math.round(rand() * 45000), onGround,
    trackDeg: rand() * 360, gsKt: onGround ? rand() * 25 : 120 + rand() * 400,
    vsFpm: onGround ? 0 : pick([0, 0, 0, 1500, -1200, 2400, -800]), ageS: 0, staleS: 60, quality: 'adsb2', info: newInfo(hex),
  }
}

const all: FleetEntry[] = []
const onScreenBuf: FleetEntry[] = [] // reused every frame, like the app's on-screen filter would
let mode: 'all' | 'pan' | 'none' = 'all'
let selected: string | null = null
let hovered: string | null = null

function setN(n: number): void {
  while (all.length < n) all.push(newEntry())
  all.length = n
}

/** Live-data stand-in: move altitudes by their vertical rate, jitter speeds, and replace a few info objects. */
function step(dtS: number, tS: number): void {
  for (const e of all) {
    if (e.onGround) continue
    e.altFt = Math.max(0, (e.altFt ?? 0) + ((e.vsFpm ?? 0) * dtS) / 60)
    if (e.altFt > 45000 || e.altFt < 1000) e.vsFpm = -(e.vsFpm ?? 0)
    e.gsKt = (e.gsKt ?? 0) + (rand() - 0.5) * 0.5
    e.lon += ((e.gsKt ?? 0) * dtS) / 3600 / 60 // about right at mid latitudes; only the pan window cares
  }
  for (let k = 0; k < 3 && all.length > 0; k++) {
    const e = all[Math.floor(rand() * all.length)]
    e.info = { ...(e.info ?? newInfo(e.hex)), squawk: rand() < 0.01 ? '7700' : Math.floor(rand() * 4096).toString(8).padStart(4, '0') }
  }
  onScreenBuf.length = 0
  if (mode === 'all') for (const e of all) onScreenBuf.push(e)
  else if (mode === 'pan') {
    const west = -30 + ((tS * 4) % 90) // a 45° window sliding east over the 90° wide fleet
    for (const e of all) if (e.lon >= west && e.lon < west + 45) onScreenBuf.push(e)
  }
}

// --- measurement ---------------------------------------------------------------------------------------------------
const N_KEEP = 1200
const updMs = new Float64Array(N_KEEP)
const frameMs = new Float64Array(N_KEEP)
let nUpd = 0
let nFrame = 0
const perSecondMax: number[] = []
let secMax = 0
let secStart = 0
let longTasks = 0
new PerformanceObserver((list) => (longTasks += list.getEntries().length)).observe({ type: 'longtask', buffered: true })

function pct(xs: ArrayLike<number>, n: number, p: number): number {
  const a = Array.from({ length: Math.min(n, xs.length) }, (_, i) => xs[i]).sort((x, y) => x - y)
  return a.length === 0 ? Number.NaN : a[Math.min(a.length - 1, Math.floor(p * a.length))]
}

function stats(): Record<string, number | string | null> {
  const nu = Math.min(nUpd, N_KEEP)
  const nf = Math.min(nFrame, N_KEEP)
  return {
    aircraft: all.length,
    onScreen: onScreenBuf.length,
    mode,
    updates: nUpd,
    updateP50Ms: pct(updMs, nu, 0.5),
    updateP95Ms: pct(updMs, nu, 0.95),
    updateP99Ms: pct(updMs, nu, 0.99),
    updateMaxMs: pct(updMs, nu, 1),
    resortP50Ms: pct(perSecondMax, perSecondMax.length, 0.5), // per-second max ≈ the frame that copies + sorts
    resortMaxMs: pct(perSecondMax, perSecondMax.length, 1),
    frameP50Ms: pct(frameMs, nf, 0.5),
    frameP95Ms: pct(frameMs, nf, 0.95),
    longTasks,
    domRows: document.querySelectorAll('.fh-row:not([hidden])').length,
    selected,
    hovered,
  }
}

function resetStats(): void {
  nUpd = nFrame = 0
  perSecondMax.length = 0
  secMax = 0
  longTasks = 0
}

const tableHead = document.createElement('div')
document.body.append(tableHead)
const table = mountTable(document.body, tableHead, {
  onSelect: (hex) => (selected = hex),
  onHover: (hex) => (hovered = hex),
  flagOf,
})

// Scroll handler cost: a capture listener on document runs before the table's own scroll listener on the element,
// and a listener added to the element after mountTable runs after it.
const scrollEl = document.querySelector<HTMLElement>('.fh-table-scroll')!
let scrollT0 = 0
const scrollMs: number[] = []
document.addEventListener('scroll', () => (scrollT0 = performance.now()), { capture: true, passive: true })
scrollEl.addEventListener('scroll', () => scrollMs.push(performance.now() - scrollT0), { passive: true })

/** Scrolls the table by pxPerFrame every frame for ms (wrapping at the end) and reports frame and handler times. */
function scrollTest(ms = 5000, pxPerFrame = 45): Promise<Record<string, number>> {
  scrollMs.length = 0
  const frames: number[] = []
  const lt0 = longTasks
  return new Promise((resolve) => {
    const t0 = performance.now()
    let last = t0
    const tick = (now: number): void => {
      frames.push(now - last)
      last = now
      const max = scrollEl.scrollHeight - scrollEl.clientHeight
      scrollEl.scrollTop = scrollEl.scrollTop + pxPerFrame > max ? 0 : scrollEl.scrollTop + pxPerFrame
      if (now - t0 < ms) requestAnimationFrame(tick)
      else {
        frames.shift()
        resolve({
          frames: frames.length,
          frameP50Ms: pct(frames, frames.length, 0.5),
          frameP95Ms: pct(frames, frames.length, 0.95),
          frameMaxMs: pct(frames, frames.length, 1),
          framesOver25Ms: frames.filter((f) => f > 25).length,
          scrollEvents: scrollMs.length,
          handlerP95Ms: pct(scrollMs, scrollMs.length, 0.95),
          handlerMaxMs: pct(scrollMs, scrollMs.length, 1),
          longTasks: longTasks - lt0,
          domRows: document.querySelectorAll('.fh-row:not([hidden])').length,
        })
      }
    }
    requestAnimationFrame(tick)
  })
}

// --- frame loop ----------------------------------------------------------------------------------------------------
// ?clock=worker drives the loop from a worker timer at ~60 Hz instead of requestAnimationFrame, for measuring update()
// in a hidden tab (no animation frames there; the page does not paint either, so the scroll test needs a visible tab).
const workerClock = new URLSearchParams(location.search).get('clock') === 'worker'
const statsEl = document.getElementById('stats')!
let lastFrame = performance.now()
let lastStats = 0
function frame(now: number): void {
  const dtS = Math.min(0.1, (now - lastFrame) / 1000)
  frameMs[nFrame++ % N_KEEP] = now - lastFrame
  lastFrame = now
  step(dtS, now / 1000)
  const t0 = performance.now()
  table.update(all, onScreenBuf, selected, true)
  const dt = performance.now() - t0
  updMs[nUpd++ % N_KEEP] = dt
  if (now - secStart >= 1000) {
    if (secStart !== 0) perSecondMax.push(secMax)
    secStart = now
    secMax = 0
  }
  secMax = Math.max(secMax, dt)
  if (now - lastStats > 500) {
    lastStats = now
    const s = stats()
    statsEl.textContent = Object.entries(s)
      .map(([k, v]) => `${k.padEnd(13)} ${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v)}`)
      .join('\n')
  }
  if (!workerClock) requestAnimationFrame(frame)
}

// --- controls ------------------------------------------------------------------------------------------------------
const controls = document.getElementById('controls')!
function button(label: string, group: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  b.dataset.group = group
  b.onclick = () => {
    for (const x of controls.querySelectorAll<HTMLButtonElement>('button')) if (x.dataset.group === group && group !== '') x.setAttribute('aria-pressed', 'false')
    if (group !== '') b.setAttribute('aria-pressed', 'true')
    onClick()
  }
  controls.append(b)
  return b
}
const n0 = Number(new URLSearchParams(location.search).get('n') ?? 5000)
for (const n of [1000, 5000, 12000]) button(`${n / 1000}k`, 'n', () => (setN(n), resetStats())).setAttribute('aria-pressed', String(n === n0))
for (const m of ['all', 'pan', 'none'] as const) button(`on screen: ${m}`, 'mode', () => (mode = m, resetStats())).setAttribute('aria-pressed', String(m === 'all'))
button('scroll test', '', () => void scrollTest().then((r) => console.log('scrollTest', r)))
button('jump test', '', () => void scrollTest(3000, 2000).then((r) => console.log('jumpTest', r)))
button('select random', '', () => (selected = pick(onScreenBuf)?.hex ?? null))
button('reset stats', '', resetStats)
addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') selected = null
})

setN(n0)
if (workerClock) {
  const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000 / 60)'], { type: 'text/javascript' })))
  ticker.onmessage = () => frame(performance.now())
} else requestAnimationFrame(frame)
;(window as unknown as { harness: object }).harness = {
  table, stats, resetStats, scrollTest, setN, all,
  setMode: (m: typeof mode) => (mode = m),
  select: (hex: string | null) => (selected = hex),
}
