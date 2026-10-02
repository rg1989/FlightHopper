// client/ui/flightCard.test.ts
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { StatusBrief } from '../../shared/api.ts'
import { toInfo } from '../../shared/info.ts'
import type { ReadsbAircraft } from '../../shared/types.ts'
import type { FleetEntry, RenderState } from '../types.ts'
import type { Lookup } from './detail.ts'
import { PhotoCache } from './photo.ts'

// flightCard.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { LOCATING_S, cardView, entryState, mountFlightCard } = await import('./flightCard.ts')
const { UPDATE_MS } = await import('./detail.ts')

// An Aegean A320 descending towards Tel Aviv (trimmed from a real adsb.lol object, © adsb.lol contributors, ODbL 1.0).
const RAW: ReadsbAircraft = {
  hex: '4691c4', type: 'adsb_icao', flight: 'AEE4266 ', r: 'SX-DND', t: 'A320', alt_baro: 7975, alt_geom: 8500, gs: 337.1,
  track: 101.81, baro_rate: -960, squawk: '7421', lat: 32.371902, lon: 34.43291, seen_pos: 0.09, version: 2, mlat: [],
  tisb: [], messages: 9956, seen: 0.0, rssi: -4.0,
}
const INFO = toInfo(RAW, null)
const SILENT: ReadsbAircraft = { ...RAW, seen: 60, seen_pos: 60 } // nothing heard from it for a minute
const S: RenderState = {
  hex: '4691c4', lat: 32.371902, lon: 34.43291, hM: 2620, headingDeg: 105.24, pitchDeg: -1.5, rollDeg: 0.5, gsKt: 337.1,
  trackDeg: 101.81, altBaroFt: 7975, vsFpm: -951, mode: 'interp', altSource: 'geom', onGround: false, ageS: -0.8,
  quality: 'adsb2', callsign: 'AEE4266', typeCode: 'A320',
}
const LIVE: StatusBrief = { source: 'adsbfi', degraded: null, cellPeriodP95S: 1, chasePeriodP95S: 1 }
const GR: Lookup = { country: { iso2: 'GR', name: 'Greece', flag: '🇬🇷' }, airline: 'Aegean Airlines' }
const NONE: Lookup = { country: null, airline: null }

const stats = (v: ReturnType<typeof cardView>): string[] => v.stats.map((s) => `${s.label} ${s.value}${s.unit === '°' ? '°' : s.unit ? ` ${s.unit}` : ''}${s.dim ? ' (dim)' : ''}`)

test('cardView: identity, four live numbers (track, not the computed heading), Live and the source', () => {
  const v = cardView('4691c4', S, RAW, INFO, LIVE, GR, 1)
  assert.equal(v.hex, '4691c4')
  assert.equal(v.callsign, 'AEE4266')
  assert.equal(v.sub, 'Aegean Airlines · SX-DND')
  assert.equal(v.flag, '🇬🇷')
  assert.equal(v.type, 'A320')
  assert.deepEqual(stats(v), ['Alt 7,975 ft', 'Speed 337 kt', 'V/S -950 fpm', 'Track 102°']) // V/S to 50 fpm (format.ts)
  assert.equal(v.state, 'live')
  assert.equal(v.status, 'Live · ADS-B v2')
})

test('cardView: status follows the track: predicting, signal lost (numbers fade), locating, then no position', () => {
  assert.equal(cardView('4691c4', { ...S, mode: 'extrap', ageS: 3 }, RAW, INFO, LIVE, GR, 5).state, 'predict')
  const lost = cardView('4691c4', { ...S, mode: 'stale', ageS: 47.4 }, SILENT, INFO, LIVE, GR, 60)
  assert.equal(lost.state, 'lost')
  assert.equal(lost.status, 'Signal lost 47 s ago')
  assert.ok(lost.stats.every((s) => s.dim))
  const locating = cardView('abcdef', null, null, null, LIVE, NONE, LOCATING_S - 1)
  assert.deepEqual([locating.state, locating.status, locating.callsign, locating.sub], ['locating', 'Locating aircraft…', 'ABCDEF', ''])
  assert.deepEqual(stats(locating), ['Alt —', 'Speed —', 'V/S —', 'Track —'].map((s) => `${s} (dim)`))
  const none = cardView('abcdef', null, null, null, LIVE, NONE, LOCATING_S)
  assert.deepEqual([none.state, none.status], ['none', 'No recent position'])
})

test('cardView: only focused, Live until 2.5 view refreshes pass without a position; no "Predicting" on the map', () => {
  const wide: StatusBrief = { ...LIVE, viewEveryS: 13 } // a zoomed-out view: its aircraft come every 13 s
  const between = { ...S, mode: 'stale' as const, ageS: 12 } // the registry calls 12 s stale; the map expects 13 s gaps
  assert.equal(cardView('4691c4', between, RAW, INFO, wide, GR, 30, false).state, 'live')
  assert.equal(cardView('4691c4', between, RAW, INFO, wide, GR, 30, true).state, 'lost', 'the chase keeps its own rule')
  assert.equal(cardView('4691c4', { ...S, mode: 'extrap', ageS: 3 }, RAW, INFO, wide, GR, 30, false).state, 'live')
  const gone = cardView('4691c4', { ...S, mode: 'stale', ageS: 33 }, SILENT, INFO, wide, GR, 60, false)
  assert.deepEqual([gone.state, gone.status], ['lost', 'Signal lost 33 s ago'])
  assert.ok(gone.stats.every((st) => st.dim))
  assert.equal(cardView('4691c4', { ...S, ageS: 11 }, SILENT, INFO, LIVE, GR, 30, false).state, 'lost', 'never under 10 s')
  // Zoomed far out (the view every 10 min) it is still asked itself every FOCUS_ASK_MS: a 40 s old position is lost.
  const globe: StatusBrief = { ...LIVE, viewEveryS: 600 }
  assert.equal(cardView('4691c4', { ...S, mode: 'stale', ageS: 40 }, SILENT, INFO, globe, GR, 60, false).state, 'lost')
  assert.equal(cardView('4691c4', { ...S, mode: 'stale', ageS: 20 }, SILENT, INFO, globe, GR, 60, false).state, 'live')
})

test('cardView: still heard but no position (GPS jammed, the upstream drops it) reads "GPS lost", not "Signal lost"', () => {
  const jammed: ReadsbAircraft = { ...RAW, lat: undefined, lon: undefined, seen_pos: undefined, nic: 0, nac_p: 3, seen: 4.4 }
  const v = cardView('4691c4', { ...S, mode: 'stale', ageS: 34.2 }, jammed, INFO, LIVE, GR, 60)
  assert.deepEqual([v.state, v.status], ['lost', 'GPS lost 34 s ago'])
  assert.ok(v.stats.every((st) => st.dim), 'its numbers are the last position\'s')
  assert.equal(cardView('4691c4', { ...S, mode: 'stale', ageS: 34.2 }, jammed, INFO, LIVE, GR, 60, false).status, 'GPS lost 34 s ago', 'focused too')
  assert.equal(cardView('4691c4', { ...S, mode: 'stale', ageS: 34.2 }, SILENT, INFO, LIVE, GR, 60).status, 'Signal lost 34 s ago')
  const other: ReadsbAircraft = { ...jammed, hex: 'a1b2c3' }
  assert.equal(cardView('4691c4', { ...S, mode: 'stale', ageS: 34.2 }, other, INFO, LIVE, GR, 60).status, 'Signal lost 34 s ago', 'another\'s object says nothing')
})

test('cardView: the source comes from the aircraft\'s own object only; another\'s (the card just switched) is ignored', () => {
  const mlat: ReadsbAircraft = { ...RAW, type: 'mlat' }
  assert.equal(cardView('4691c4', S, mlat, INFO, LIVE, GR, 1).status, 'Live · MLAT')
  const other: ReadsbAircraft = { ...mlat, hex: 'a1b2c3' }
  assert.equal(cardView('4691c4', { ...S, quality: 'adsb01' }, other, INFO, LIVE, GR, 1).status, 'Live · ADS-B v0/1', 'its own quality, not "MLAT"')
})

test('cardView: on the ground reads GND with no unit', () => {
  assert.deepEqual(cardView('4691c4', { ...S, onGround: true }, RAW, INFO, LIVE, GR, 1).stats[0], { key: 'alt', label: 'Alt', value: 'GND', unit: '', dim: false })
})

// The same Aegean A320 as chase traffic: its fleet entry, smoothed by its own track.
const ENTRY: FleetEntry = {
  hex: '4691c4', lat: 32.371902, lon: 34.43291, hM: 2620, altFt: 7975, onGround: false, trackDeg: 101.81, gsKt: 337.1,
  vsFpm: -951, ageS: 0.4, staleS: 60, gapS: 1, quality: 'adsb2', info: INFO, att: { headingDeg: 105.24, pitchDeg: -1.5, rollDeg: 0.5 },
}

test('cardView of a traffic aircraft (entryState): the chased card\'s texts from its fleet entry, and its range', () => {
  const s = entryState(ENTRY)
  assert.deepEqual([s.headingDeg, s.pitchDeg, s.rollDeg, s.altBaroFt, s.callsign, s.typeCode], [105.24, -1.5, 0.5, 7975, 'AEE4266', 'A320'])
  const v = cardView('4691c4', s, null, INFO, LIVE, GR, 1, false, { distM: 7370.6, from: 'UAL2478' })
  assert.deepEqual(stats(v), ['Alt 7,975 ft', 'Speed 337 kt', 'V/S -950 fpm', 'Track 102°'])
  assert.deepEqual([v.callsign, v.sub, v.status], ['AEE4266', 'Aegean Airlines · SX-DND', 'Live · ADS-B v2'])
  assert.deepEqual(v.range, { dist: '7,371 m', from: 'from UAL2478' })
  assert.equal(cardView('4691c4', s, null, INFO, LIVE, GR, 1, false).range, null, 'none given (the chased card): none shown')
  const bare = entryState({ ...ENTRY, att: null, info: null, trackDeg: null })
  assert.deepEqual([bare.headingDeg, bare.pitchDeg, bare.callsign, bare.typeCode], [0, 0, null, null])
  assert.equal(cardView('4691c4', entryState({ ...ENTRY, ageS: 14 }), null, INFO, LIVE, GR, 30, false).status, 'Signal lost 14 s ago')
})

// ---------- mountFlightCard on a minimal fake DOM (only what flightCard.ts and icons.ts use) ----------

class FakeEl {
  tag: string
  children: FakeEl[] = []
  parent: FakeEl | null = null
  className = ''
  textContent = ''
  hidden = false
  title = ''
  src?: string
  href?: string
  dataset: Record<string, string> = {}
  props: Record<string, string> = {}
  #classes = new Set<string>()
  classList = {
    add: (c: string): void => void this.#classes.add(c),
    remove: (c: string): void => void this.#classes.delete(c),
    toggle: (c: string, on: boolean): void => void (on ? this.#classes.add(c) : this.#classes.delete(c)),
    contains: (c: string): boolean => this.#classes.has(c),
  }
  listeners = new Map<string, (() => void)[]>()
  constructor(tag: string) {
    this.tag = tag
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) {
      c.parent = this
      this.children.push(c)
    }
  }
  replaceChildren(...cs: FakeEl[]): void {
    this.children = []
    this.append(...cs)
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this)
    this.parent = null
  }
  setAttribute(k: string, v: string): void {
    this.props[k] = v
  }
  removeAttribute(k: string): void {
    delete this.props[k]
    if (k === 'src') delete this.src
  }
  addEventListener(type: string, f: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f])
  }
  fire(type: string): void {
    for (const f of this.listeners.get(type) ?? []) f()
  }
  has(cls: string): boolean {
    return this.className.split(' ').includes(cls) || this.classList.contains(cls)
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } {
    return { left: 0, top: 0, right: 0, bottom: 0 }
  }
}

const all = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(all)]
const byClass = (root: FakeEl, cls: string): FakeEl => {
  const hit = all(root).find((e) => e.has(cls))
  assert.ok(hit, `no .${cls}`)
  return hit
}
const button = (root: FakeEl, label: RegExp): FakeEl => {
  const hit = all(root).find((e) => e.tag === 'button' && label.test(e.props['aria-label'] ?? e.textContent + all(e).map((c) => c.textContent).join('')))
  assert.ok(hit, `no button ${label}`)
  return hit
}
/** The value text of stat i (0 alt, 1 speed, 2 V/S, 3 track). */
const statValue = (root: FakeEl, i: number): string => byClass(root, 'fh-card-stats').children[i].children[0].children[0].textContent
const pillText = (root: FakeEl): string => byClass(root, 'fh-pill').children[1].textContent

const PHOTO_BODY = {
  photos: [{
    thumbnail_large: { src: 'https://t.plnspttrs.net/1/4691c4_280.jpg' },
    link: 'https://www.planespotters.net/photo/1/sx-dnd',
    photographer: 'A. Spotter',
  }],
}

function setup(photoGate?: Promise<void>, photoStatus = 200, traffic = false) {
  ;(globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  }
  const root = new FakeEl('div')
  const fetches: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    fetches.push(String(input))
    if (photoGate) await photoGate
    return new Response(JSON.stringify(String(input).endsWith('4691C4') ? PHOTO_BODY : { photos: [] }), { status: photoStatus })
  }) as typeof fetch
  const lookups: string[] = []
  const chases: boolean[] = []
  let closed = 0
  const c = mountFlightCard(root as unknown as HTMLElement, {
    traffic,
    onClose: () => closed++,
    onChase: (on) => chases.push(on),
    photos: new PhotoCache(fetchFn),
    lookup: (hex, callsign) => {
      lookups.push(`${hex}/${callsign}`)
      return hex === '4691c4' ? GR : NONE
    },
  })
  const card = byClass(root, 'fh-card')
  return { root, card, c, fetches, lookups, chases, closed: () => closed }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const withClock = (f: () => void): void => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    f()
  } finally {
    mock.timers.reset()
  }
}

test('mountFlightCard: hidden until an aircraft (and a status) is given, filled at once, hidden again on null', () => withClock(() => {
  const { card, c } = setup()
  assert.equal(card.hidden, true)
  c.update('4691c4', S, RAW, INFO, LIVE, false)
  assert.equal(card.hidden, false)
  assert.equal(byClass(card, 'fh-card-callsign').textContent, 'AEE4266')
  assert.equal(byClass(card, 'fh-card-sub-t').textContent, 'Aegean Airlines · SX-DND')
  assert.equal(statValue(card, 1), '337')
  assert.equal(byClass(card, 'fh-card-status-t').textContent, 'Live · ADS-B v2')
  c.update(null, null, null, null, LIVE, false)
  assert.equal(card.hidden, true)
  c.destroy()
}))

test('mountFlightCard: text updates at most every 250 ms, and the newest state always lands', () => withClock(() => {
  const { card, c } = setup()
  assert.equal(UPDATE_MS, 250)
  c.update('4691c4', S, RAW, INFO, LIVE, false) // selection: rendered now
  mock.timers.tick(100)
  c.update('4691c4', { ...S, gsKt: 340 }, RAW, INFO, LIVE, false)
  assert.equal(statValue(card, 1), '337') // too soon
  mock.timers.tick(100)
  c.update('4691c4', { ...S, gsKt: 341 }, RAW, INFO, LIVE, false)
  assert.equal(statValue(card, 1), '337')
  mock.timers.tick(50) // 250 ms after the first render: the trailing render shows the newest state
  assert.equal(statValue(card, 1), '341')
  mock.timers.tick(250)
  c.update('4691c4', { ...S, gsKt: 342 }, RAW, INFO, LIVE, false) // quiet for a full period: rendered now
  assert.equal(statValue(card, 1), '342')
  c.destroy()
}))

test('mountFlightCard: the pill says Chase on the map and Map in the chase, at once, and asks for the other', () => withClock(() => {
  const { card, c, chases } = setup()
  c.update('4691c4', S, RAW, INFO, LIVE, false)
  assert.equal(pillText(card), 'Chase in 3-D')
  byClass(card, 'fh-pill').fire('click')
  assert.deepEqual(chases, [true])
  c.update('4691c4', S, RAW, INFO, LIVE, true) // no throttle wait for a mode change
  assert.equal(pillText(card), 'Map')
  assert.equal(byClass(card, 'fh-pill').classList.contains('fh-pill-secondary'), true)
  byClass(card, 'fh-pill').fire('click')
  assert.deepEqual(chases, [true, false])
  c.destroy()
}))

test('mountFlightCard, traffic: labelled so, its pill always Chase (asks to chase it), its range above the status', () => withClock(() => {
  const { card, c, chases } = setup(undefined, 200, true)
  assert.equal(card.props['aria-label'], 'Traffic aircraft')
  assert.equal(card.has('fh-tcard'), true)
  const range = byClass(card, 'fh-card-range')
  assert.equal(card.children.indexOf(range) + 1, card.children.indexOf(byClass(card, 'fh-card-foot')), 'right above the status line')
  c.update('4691c4', entryState(ENTRY), null, INFO, LIVE, false, { distM: 7370.6, from: 'UAL2478' })
  assert.equal(pillText(card), 'Chase')
  assert.deepEqual([range.hidden, byClass(card, 'fh-card-range-d').textContent, byClass(card, 'fh-card-range-f').textContent], [false, '7,371 m', 'from UAL2478'])
  byClass(card, 'fh-pill').fire('click')
  assert.deepEqual(chases, [true])
  mock.timers.tick(300)
  c.update('4691c4', entryState(ENTRY), null, INFO, LIVE, false, null) // its distance not known yet
  assert.equal(range.hidden, true)
  c.destroy()
}))

test('mountFlightCard: keepClear moves a shown card to the other end of its column only where that clears the point', () => withClock(() => {
  const { card, c } = setup(undefined, 200, true)
  const flipped = (): boolean => card.classList.contains('fh-card-flip')
  // flightCard.css on a 1440 × 900 screen: top right, or flipped to the bottom right; on a 390 × 844 phone, with a photo,
  // above the tab bar or flipped to the top
  let phone = false
  card.getBoundingClientRect = () => phone
    ? (flipped() ? { left: 8, top: 8, right: 382, bottom: 449 } : { left: 8, top: 334, right: 382, bottom: 775 })
    : (flipped() ? { left: 1056, top: 502, right: 1376, bottom: 888 } : { left: 1056, top: 12, right: 1376, bottom: 398 })
  c.keepClear(1100, 300, 48) // hidden: nothing to move
  assert.equal(flipped(), false)
  c.update('4691c4', entryState(ENTRY), null, INFO, LIVE, false, null)
  c.keepClear(1100, 300, 48) // the clicked aircraft is under it
  assert.equal(flipped(), true)
  c.keepClear(1030, 440, 48) // within the padding
  assert.equal(flipped(), true)
  c.keepClear(700, 450, 48) // clear of it: back where it belongs
  assert.equal(flipped(), false)
  phone = true
  c.keepClear(200, 409, 48) // covered at both ends (a phone's tall card): it stays
  assert.equal(flipped(), false)
  c.keepClear(200, 700, 48) // low on the screen: the top clears it
  assert.equal(flipped(), true)
  c.destroy()
}))

test("mountFlightCard: keepClear keeps off the flight-data frame: its own place, the other end, the chased card's", () => withClock(() => {
  const { card, c } = setup(undefined, 200, true)
  const place = (): string => (card.classList.contains('fh-card-flip') ? 'flip' : card.classList.contains('fh-card-home') ? 'home' : 'own')
  // flightCard.css on a 1024 × 768 screen, with a photo: top right, flipped to the bottom right, or the chased card's
  card.getBoundingClientRect = () => ({
    own: { left: 634, top: 12, right: 954, bottom: 398 },
    flip: { left: 634, top: 370, right: 954, bottom: 756 },
    home: { left: 12, top: 12, right: 332, bottom: 398 },
  })[place()]!
  const gs = { x: 556, y: 246, w: 84, h: 187 } // the speed tape, under the right edge of both right-hand places
  const alt = { x: 340, y: 269, w: 127, h: 160 } // the altitude tape, just clear of the chased card's place
  c.update('4691c4', entryState(ENTRY), null, INFO, LIVE, false, null)
  c.keepClear(100, 700, 48, [])
  assert.equal(place(), 'own', 'nothing in the way')
  c.keepClear(100, 700, 48, [gs, alt])
  assert.equal(place(), 'home')
  c.keepClear(800, 200, 48, [{ x: 700, y: 300, w: 50, h: 50 }])
  assert.equal(place(), 'flip', 'a card under its own place only: the other end')
  c.keepClear(100, 100, 48, [gs, alt])
  assert.equal(place(), 'flip', "none clears both: the least covering of those clear of the aircraft (in the chased card's place)")
  c.keepClear(800, 200, 48, [gs, alt, { x: 20, y: 300, w: 50, h: 50 }])
  assert.equal(place(), 'flip', 'none clears both, the aircraft under its own place: the other end covers less')
  c.keepClear(800, 200, 48, [{ x: 20, y: 300, w: 50, h: 50 }, { x: 700, y: 500, w: 200, h: 200 }])
  assert.equal(place(), 'home', 'the chased card\'s place covers less')
  c.keepClear(800, 200, 48, [{ x: 0, y: 0, w: 1024, h: 768 }])
  assert.equal(place(), 'flip', 'all covered alike: the first clear of the aircraft')
  c.destroy()
}))

test('mountFlightCard: placed while its photo loads, a traffic card is placed again when none comes (shorter)', async () => {
  const { card, c } = setup(undefined, 200, true)
  const photo = byClass(card, 'fh-card-photo')
  const place = (): string => (card.classList.contains('fh-card-flip') ? 'flip' : card.classList.contains('fh-card-home') ? 'home' : 'own')
  // 1024 × 768: with the photo box it reaches down past the speed tape's top; without, it clears it
  card.getBoundingClientRect = () => {
    const h = photo.hidden ? 179 : 386
    return place() === 'flip' ? { left: 634, top: 756 - h, right: 954, bottom: 756 } : { left: 634, top: 12, right: 954, bottom: 12 + h }
  }
  const frame = [{ x: 683, y: 246, w: 84, h: 187 }, { x: 377, y: 647, w: 271, h: 72 }] // speed tape, heading card
  c.update('abc123', entryState({ ...ENTRY, hex: 'abc123' }), null, INFO, LIVE, false, null) // no photo of it
  c.keepClear(520, 80, 48, frame)
  assert.equal(place(), 'flip', 'the photo box would reach the speed tape: the bottom, the least covering')
  await flush()
  assert.equal(photo.hidden, true, 'none came')
  assert.equal(place(), 'own', 'shorter: its own place clears the frame')
  c.destroy()
})

test('mountFlightCard: the chased card has no range line and keeps its own labels', () => withClock(() => {
  const { card, c } = setup()
  c.update('4691c4', S, RAW, INFO, LIVE, true)
  assert.deepEqual([card.props['aria-label'], card.has('fh-tcard'), byClass(card, 'fh-card-range').hidden], ['Selected aircraft', false, true])
  c.destroy()
}))

test('mountFlightCard: the photo sits above the stats, collapsed or not, asked for once per selection; credit links to its page', async () => {
  const { card, c, fetches } = setup()
  const photo = byClass(card, 'fh-card-photo')
  assert.equal(card.children.indexOf(photo) + 1, card.children.indexOf(byClass(card, 'fh-card-stats')), 'right above the stats, not in the details')
  for (let i = 0; i < 20; i++) c.update('4691c4', S, RAW, INFO, LIVE, false) // per-frame calls, collapsed
  assert.equal(photo.classList.contains('fh-skel'), true, 'skeleton (and spinner) while it loads')
  await flush()
  assert.deepEqual(fetches, ['https://api.planespotters.net/pub/photos/hex/4691C4'])
  const expand = button(card, /Show details/)
  assert.equal(expand.parent, byClass(card, 'fh-card-foot'), 'the toggle sits by the status line, not in the header')
  expand.fire('click') // expanding does not ask again
  assert.equal(byClass(card, 'fh-card-more').hidden, false)
  await flush()
  assert.equal(fetches.length, 1)
  const img = all(card).find((e) => e.tag === 'img')!
  assert.equal(img.src, 'https://t.plnspttrs.net/1/4691c4_280.jpg')
  const credit = byClass(card, 'fh-card-credit')
  assert.equal(credit.textContent, '© A. Spotter')
  assert.equal(credit.href, 'https://www.planespotters.net/photo/1/sx-dnd')
  assert.equal(img.hidden, true, 'shown once it loads')
  // The same credit, linked, as a line under the callsign: where the photo is a thumbnail (a phone in the chase: CSS).
  const line = byClass(card, 'fh-card-credit-line')
  assert.equal(line.parent, byClass(card, 'fh-card-ident'))
  assert.deepEqual([line.textContent, line.href, line.hidden], ['© A. Spotter', 'https://www.planespotters.net/photo/1/sx-dnd', true])
  img.fire('load')
  assert.deepEqual([img.hidden, credit.hidden, byClass(card, 'fh-card-photo').classList.contains('fh-skel')], [false, false, false])
  assert.equal(line.hidden, false)
  assert.equal(byClass(card, 'fh-card-nophoto').hidden, true)
  img.fire('error') // the CDN image fails: no orphan credit, no empty box; the camera mark says so
  assert.deepEqual([img.hidden, credit.hidden, line.hidden, photo.hidden], [true, true, true, true])
  assert.equal(byClass(card, 'fh-card-nophoto').title, 'Photo unavailable (could not load it)')
  c.destroy()
})

test('mountFlightCard: a photo that arrives after the selection moved on is dropped', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { card, c, fetches } = setup(gate)
  c.update('4691c4', S, RAW, INFO, LIVE, false)
  c.update('abcdef', null, null, null, LIVE, false)
  release()
  await flush()
  assert.equal(fetches.length, 2)
  const img = all(card).find((e) => e.tag === 'img')!
  assert.equal(img.src, undefined)
  assert.equal(byClass(card, 'fh-card-photo').hidden, true, 'no photo: no box')
  assert.equal(byClass(card, 'fh-card-nophoto').hidden, false)
  assert.equal(byClass(card, 'fh-card-nophoto').title, 'No photo available')
  assert.equal(byClass(card, 'fh-card-credit').hidden, true)
  c.destroy()
})

test('mountFlightCard: a failed photo lookup says so, rather than "No photo"', async () => {
  const { card, c } = setup(undefined, 503)
  c.update('4691c4', S, RAW, INFO, LIVE, false)
  await flush()
  assert.equal(byClass(card, 'fh-card-nophoto').title, 'Photo unavailable (could not load it)')
  assert.equal(byClass(card, 'fh-card-photo').hidden, true)
  assert.equal(byClass(card, 'fh-card-credit').hidden, true)
  c.destroy()
})

test('mountFlightCard: lookup once per hex and callsign, close button, destroy removes the card', () => withClock(() => {
  const { root, card, c, lookups, closed } = setup()
  for (let i = 0; i < 5; i++) {
    c.update('4691c4', S, RAW, INFO, LIVE, false)
    mock.timers.tick(300)
  }
  c.update('4691c4', { ...S, callsign: 'AEE9' }, RAW, { ...INFO, callsign: 'AEE9' }, LIVE, false)
  assert.deepEqual(lookups, ['4691c4/AEE4266', '4691c4/AEE9'])
  button(card, /^Close/).fire('click')
  assert.equal(closed(), 1)
  c.update('4691c4', { ...S, gsKt: 1 }, RAW, INFO, LIVE, false) // leaves a trailing render pending
  c.destroy()
  assert.equal(root.children.length, 0)
  mock.timers.tick(1000) // the pending render must not run after destroy
  assert.equal(statValue(card, 1), '337')
}))

test('cardView in a replay: the status is the replay clock (amber), "not heard" once its position is over a minute old', () => {
  const v = cardView('4691c4', { ...S, ageS: 4 }, null, INFO, LIVE, GR, 30, false, null, 'Replay · 17:43')
  assert.deepEqual([v.state, v.status], ['replay', 'Replay · 17:43'])
  assert.ok(v.stats.every((st) => !st.dim || st.value === '—'))
  const quiet = cardView('4691c4', { ...S, mode: 'stale', ageS: 75 }, null, INFO, LIVE, GR, 30, true, null, 'Replay · 17:43')
  assert.deepEqual([quiet.state, quiet.status], ['lost', 'Replay · 17:43 · not heard'])
  assert.equal(cardView('4691c4', null, null, INFO, LIVE, GR, 2, false, null, 'Replay · 17:43').state, 'locating', 'no position yet: as live')
  const coarse = cardView('4691c4', { ...S, mode: 'stale', ageS: 300 }, null, INFO, LIVE, GR, 30, false, null, 'Replay · 17:43', 750)
  assert.equal(coarse.state, 'replay', 'a world view\'s 300 s slices: 5 min old is still heard')
})
