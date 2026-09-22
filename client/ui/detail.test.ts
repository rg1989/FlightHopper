// client/ui/detail.test.ts
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { toInfo } from '../../shared/info.ts'
import type { ReadsbAircraft } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import type { DetailSection, Lookup } from './detail.ts'
import { PhotoCache } from './photo.ts'

// detail.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { UPDATE_MS, detailRows, mountDetail, shareLink, sourceLabel } = await import('./detail.ts')

// A real adsb.lol /v2/point object (LLBG cell, 2026-09-22; © adsb.lol contributors, ODbL 1.0): an Aegean A320
// descending towards Tel Aviv. It carries the Mode S EHS fields (wind, OAT, selected altitude) the panel shows.
const RAW: ReadsbAircraft = {
  hex: '4691c4', type: 'adsb_icao', flight: 'AEE4266 ', r: 'SX-DND', t: 'A320', alt_baro: 7975, alt_geom: 8500, gs: 337.1,
  ias: 280, tas: 322, mach: 0.488, wd: 231, ws: 24, oat: 14, tat: 27, track: 101.81, track_rate: 0.06, roll: 0.53,
  mag_heading: 100.2, true_heading: 105.24, baro_rate: -960, geom_rate: -928, squawk: '7421', emergency: 'none',
  category: 'A3', nav_qnh: 1012.0, nav_altitude_mcp: 4992, lat: 32.371902, lon: 34.43291, nic: 8, rc: 186, seen_pos: 0.09,
  version: 2, nic_baro: 1, nac_p: 9, nac_v: 1, sil: 3, gva: 2, sda: 2, mlat: [], tisb: [], messages: 9956, seen: 0.0, rssi: -4.0,
}
const INFO = toInfo(RAW, 'LGAV-LLBG') // the route is made up for the test
const S: RenderState = {
  hex: '4691c4', lat: 32.371902, lon: 34.43291, hM: 2620, headingDeg: 105.24, pitchDeg: -1.5, rollDeg: 0.5, gsKt: 337.1,
  trackDeg: 101.81, altBaroFt: 7975, vsFpm: -951, mode: 'interp', altSource: 'geom', onGround: false, ageS: -0.8,
  quality: 'adsb2', callsign: 'AEE4266', typeCode: 'A320',
}
const GR: Lookup = { country: { iso2: 'GR', name: 'Greece', flag: '🇬🇷' }, airline: 'Aegean Airlines' }
const NONE: Lookup = { country: null, airline: null }

const flat = (sections: DetailSection[]): Record<string, string> =>
  Object.fromEntries(sections.flatMap((sec) => sec.rows.map((r) => [r.key, r.value])))
const shape = (sections: DetailSection[]): string[] => sections.map((sec) => `${sec.id}:${sec.title}:${sec.rows.map((r) => r.key).join(',')}`)

test('detailRows: the golden aircraft, every section, with units', () => {
  assert.deepEqual(flat(detailRows(S, RAW, INFO, GR)), {
    callsign: 'AEE4266', hex: '4691C4',
    reg: 'SX-DND', country: '🇬🇷 Greece', airline: 'Aegean Airlines', dbFlags: '—', type: 'A320', squawk: '7421', route: 'LGAV – LLBG',
    gs: '337 kt', altBaro: '7,975 ft ▼', altGeom: '8,500 ft', vs: '-960 ft/min', track: '102°', pos: '32.372°, 34.433°',
    source: 'ADS-B v2', rssi: '-4.0 dBFS', messages: '9,956', posAge: '0.1 s', seen: '0.0 s',
    selAlt: '4,992 ft', selHdg: '—', qnh: '1012.0 hPa', modes: '—',
    wind: '24 kt / 231°', oat: '14 °C', tat: '27 °C',
  })
})

test('detailRows: one fixed shape, whatever is known (mountDetail builds the DOM once from it)', () => {
  const full = shape(detailRows(S, RAW, INFO, GR))
  assert.deepEqual(full, [
    'header::callsign,hex',
    'identity::reg,country,airline,dbFlags,type,squawk,route',
    'spatial:Spatial:gs,altBaro,altGeom,vs,track,pos',
    'signal:Signal:source,rssi,messages,posAge,seen',
    'fms:FMS SEL:selAlt,selHdg,qnh,modes',
    'wind:Wind:wind,oat,tat',
  ])
  assert.deepEqual(shape(detailRows(null, null, null, NONE)), full)
})

test('detailRows: nothing known → every value is —', () => {
  for (const v of Object.values(flat(detailRows(null, null, null, NONE)))) assert.equal(v, '—')
})

test('detailRows: RenderState alone (no raw object or info yet)', () => {
  const v = flat(detailRows(S, null, null, NONE))
  assert.equal(v.callsign, 'AEE4266')
  assert.equal(v.type, 'A320')
  assert.equal(v.gs, '337 kt')
  assert.equal(v.altBaro, '7,975 ft ▼') // trend from the filter's vsFpm
  assert.equal(v.vs, '-950 ft/min') // the filter's rate, rounded to 10
  assert.equal(v.source, 'ADS-B v2') // from RenderState.quality
  assert.equal(v.rssi, '—')
  assert.equal(v.reg, '—')
})

test('detailRows: raw object alone (callsign trimmed, ground, climbing, military, other sources)', () => {
  const v = flat(detailRows(null, { ...RAW, alt_baro: 'ground', dbFlags: 1 | 8 }, null, NONE))
  assert.equal(v.callsign, 'AEE4266')
  assert.equal(v.hex, '4691C4')
  assert.equal(v.altBaro, 'ground')
  assert.equal(v.dbFlags, 'military · LADD')
  assert.equal(v.pos, '32.372°, 34.433°')
  assert.equal(flat(detailRows(null, { ...RAW, baro_rate: 1792 }, null, NONE)).altBaro, '7,975 ft ▲')
  assert.equal(flat(detailRows(null, { ...RAW, baro_rate: 128 }, null, NONE)).altBaro, '7,975 ft') // level: no arrow
  assert.equal(flat(detailRows(null, { ...RAW, baro_rate: undefined }, null, NONE)).vs, '-928 ft/min') // geometric rate
})

test('detailRows: a raw object or info for another hex is ignored (stale data from the previous selection)', () => {
  const v = flat(detailRows(S, { ...RAW, hex: 'a1b2c3', r: 'N1' }, { ...INFO, hex: 'a1b2c3', reg: 'N1' }, NONE))
  assert.equal(v.reg, '—')
  assert.equal(v.rssi, '—')
  assert.equal(v.hex, '4691C4')
})

test('detailRows: emergency squawks and the emergency field are flagged', () => {
  const row = (raw: ReadsbAircraft) => detailRows(null, raw, null, NONE)[1].rows.find((r) => r.key === 'squawk')!
  assert.deepEqual([row(RAW).value, row(RAW).alert], ['7421', false])
  assert.deepEqual([row({ ...RAW, squawk: '7700' }).value, row({ ...RAW, squawk: '7700' }).alert], ['7700 · emergency', true])
  assert.deepEqual([row({ ...RAW, squawk: '7600' }).value, row({ ...RAW, squawk: '7600' }).alert], ['7600 · radio failure', true])
  assert.deepEqual([row({ ...RAW, squawk: '7500' }).value, row({ ...RAW, squawk: '7500' }).alert], ['7500 · hijack', true])
  const med = row({ ...RAW, squawk: '7700', emergency: 'lifeguard' })
  assert.deepEqual([med.value, med.alert], ['7700 · lifeguard', true])
  // info wins over raw for identity fields
  const i = detailRows(null, RAW, { ...INFO, squawk: '7700', emergency: 'general' }, NONE)[1].rows.find((r) => r.key === 'squawk')!
  assert.deepEqual([i.value, i.alert], ['7700 · general', true])
})

test('detailRows: WGS84 altitude is hinted as uncertain below ADS-B v2', () => {
  const geom = (raw: ReadsbAircraft) => detailRows(null, raw, null, NONE)[2].rows.find((r) => r.key === 'altGeom')!
  assert.equal(geom(RAW).hint, null)
  assert.match(geom({ ...RAW, version: 0 }).hint ?? '', /v2/)
})

test('detailRows: FMS modes, FMS altitude fallback, one-sided wind, non-ICAO hex', () => {
  const v = flat(detailRows(null, { ...RAW, nav_altitude_mcp: undefined, nav_altitude_fms: 38000, nav_heading: 42.2, nav_modes: ['autopilot', 'vnav', 'tcas'], ws: undefined }, null, NONE))
  assert.equal(v.selAlt, '38,000 ft')
  assert.equal(v.selHdg, '042°')
  assert.equal(v.modes, 'autopilot vnav tcas')
  assert.equal(v.wind, '—')
  assert.equal(flat(detailRows(null, { hex: '~A330E6' }, null, NONE)).hex, '~A330E6')
})

test('sourceLabel: readsb message types and RenderState quality', () => {
  assert.equal(sourceLabel({ hex: 'x', type: 'adsb_icao', version: 2 }, null), 'ADS-B v2')
  assert.equal(sourceLabel({ hex: 'x', type: 'adsb_icao_nt', version: 0 }, null), 'ADS-B v0')
  assert.equal(sourceLabel({ hex: 'x', type: 'adsb_other' }, null), 'ADS-B')
  assert.equal(sourceLabel({ hex: 'x', type: 'adsr_icao', version: 2 }, null), 'ADS-R')
  assert.equal(sourceLabel({ hex: 'x', type: 'mlat' }, null), 'MLAT')
  assert.equal(sourceLabel({ hex: 'x', type: 'tisb_trackfile' }, null), 'TIS-B')
  assert.equal(sourceLabel({ hex: 'x', type: 'mode_s' }, null), 'Mode S')
  assert.equal(sourceLabel({ hex: 'x', type: 'adsc' }, null), 'ADS-C')
  assert.equal(sourceLabel({ hex: 'x', type: 'other' }, null), 'other')
  assert.equal(sourceLabel(null, 'adsb01'), 'ADS-B v0/1')
  assert.equal(sourceLabel(null, 'mlat'), 'MLAT')
  assert.equal(sourceLabel(null, null), null)
})

test('shareLink: the app URL that opens this aircraft (client/app.ts readParams reads ?hex=)', () => {
  assert.equal(shareLink('http://localhost:5173', '4691c4'), 'http://localhost:5173/?hex=4691c4')
  assert.equal(shareLink('https://fh.example', '~a330e6'), 'https://fh.example/?hex=~a330e6')
})

// ---------- mountDetail on a minimal fake DOM (only what detail.ts uses) ----------

class FakeEl {
  tag: string
  children: FakeEl[] = []
  parent: FakeEl | null = null
  className = ''
  textContent = ''
  hidden = false
  title = ''
  open = false
  classes = new Set<string>()
  classList = {
    toggle: (c: string, on: boolean): void => void (on ? this.classes.add(c) : this.classes.delete(c)),
  }
  listeners = new Map<string, (() => void)[]>()
  props: Record<string, string> = {}
  constructor(tag: string) {
    this.tag = tag
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) {
      c.parent = this
      this.children.push(c)
    }
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
  }
  addEventListener(type: string, f: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f])
  }
  fire(type: string): void {
    for (const f of this.listeners.get(type) ?? []) f()
  }
  // href, src, alt, target, rel, type go through setAttribute in detail.ts
}

const all = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(all)]
const byClass = (root: FakeEl, cls: string): FakeEl => {
  const hit = all(root).find((e) => e.className.split(' ').includes(cls))
  assert.ok(hit, `no .${cls}`)
  return hit
}
const valueOf = (root: FakeEl, key: string): string => {
  const row = all(root).find((e) => e.props['data-key'] === key)
  assert.ok(row, `no row ${key}`)
  return byClass(row, 'fh-detail-value').textContent
}

const PHOTO_BODY = {
  photos: [{
    thumbnail_large: { src: 'https://t.plnspttrs.net/1/4691c4_280.jpg' },
    link: 'https://www.planespotters.net/photo/1/sx-dnd',
    photographer: 'A. Spotter',
  }],
}

function setup(photoGate?: Promise<void>, photoStatus = 200) {
  ;(globalThis as { document?: unknown }).document = { createElement: (tag: string) => new FakeEl(tag) }
  const root = new FakeEl('div')
  const fetches: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    fetches.push(String(input))
    if (photoGate) await photoGate
    return new Response(JSON.stringify(String(input).endsWith('4691C4') ? PHOTO_BODY : { photos: [] }), { status: photoStatus })
  }) as typeof fetch
  const lookups: string[] = []
  let closed = 0
  const d = mountDetail(root as unknown as HTMLElement, {
    onClose: () => closed++,
    photos: new PhotoCache(fetchFn),
    lookup: (hex, callsign) => {
      lookups.push(`${hex}/${callsign}`)
      return hex === '4691c4' ? GR : NONE
    },
  })
  const panel = byClass(root, 'fh-detail')
  return { root, panel, d, fetches, lookups, closed: () => closed }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

test('mountDetail: hidden until an aircraft is given, filled at once on selection, hidden again on null', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    const { panel, d } = setup()
    assert.equal(panel.hidden, true)
    d.update(S, RAW, INFO)
    assert.equal(panel.hidden, false)
    assert.equal(byClass(panel, 'fh-detail-callsign').textContent, 'AEE4266')
    assert.equal(byClass(panel, 'fh-detail-hex').textContent, '4691C4')
    assert.equal(valueOf(panel, 'country'), '🇬🇷 Greece')
    assert.equal(valueOf(panel, 'wind'), '24 kt / 231°')
    d.update(null, null, null)
    assert.equal(panel.hidden, true)
    d.destroy()
  } finally {
    mock.timers.reset()
  }
})

test('mountDetail: text updates at most every 250 ms, and the newest state always lands', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    const { panel, d } = setup()
    assert.equal(UPDATE_MS, 250)
    d.update(S, RAW, INFO) // selection: rendered now
    mock.timers.tick(100)
    d.update({ ...S, gsKt: 340 }, RAW, INFO)
    assert.equal(valueOf(panel, 'gs'), '337 kt') // too soon
    mock.timers.tick(100)
    d.update({ ...S, gsKt: 341 }, RAW, INFO)
    assert.equal(valueOf(panel, 'gs'), '337 kt')
    mock.timers.tick(50) // 250 ms after the first render: the trailing render shows the newest state
    assert.equal(valueOf(panel, 'gs'), '341 kt')
    mock.timers.tick(250)
    d.update({ ...S, gsKt: 342 }, RAW, INFO) // quiet for a full period: rendered now
    assert.equal(valueOf(panel, 'gs'), '342 kt')
    d.destroy()
  } finally {
    mock.timers.reset()
  }
})

test('mountDetail: emergency squawk row gets the alert class', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    const { panel, d } = setup()
    d.update(S, { ...RAW, squawk: '7700' }, null)
    const row = all(panel).find((e) => e.props['data-key'] === 'squawk')!
    assert.equal(row.classes.has('fh-alert'), true)
    mock.timers.tick(300)
    d.update(S, RAW, null)
    assert.equal(row.classes.has('fh-alert'), false)
    d.destroy()
  } finally {
    mock.timers.reset()
  }
})

test('mountDetail: one photo request per selection, credit links to the photo page', async () => {
  const { panel, d, fetches } = setup()
  d.update(S, RAW, INFO)
  for (let i = 0; i < 20; i++) d.update(S, RAW, INFO) // per-frame calls for the same aircraft
  await flush()
  assert.deepEqual(fetches, ['https://api.planespotters.net/pub/photos/hex/4691C4'])
  const img = all(panel).find((e) => e.tag === 'img')!
  assert.equal(img.props.src, 'https://t.plnspttrs.net/1/4691c4_280.jpg')
  assert.equal(img.hidden, false)
  const credit = byClass(panel, 'fh-detail-credit')
  assert.equal(credit.textContent, 'Image © A. Spotter')
  assert.equal(credit.props.href, 'https://www.planespotters.net/photo/1/sx-dnd')
  assert.equal(credit.hidden, false)
  img.fire('error') // the CDN image fails: no orphan credit
  assert.equal(img.hidden, true)
  assert.equal(credit.hidden, true)
  assert.equal(byClass(panel, 'fh-detail-note').textContent, 'Photo unavailable')
  d.destroy()
})

test('mountDetail: a photo that arrives after the selection moved on is dropped', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { panel, d, fetches } = setup(gate)
  d.update(S, RAW, INFO)
  d.update({ ...S, hex: 'abcdef', callsign: 'XYZ1' }, null, null)
  release()
  await flush()
  assert.equal(fetches.length, 2)
  const img = all(panel).find((e) => e.tag === 'img')!
  assert.equal(img.props.src, undefined)
  assert.equal(img.hidden, true)
  assert.equal(byClass(panel, 'fh-detail-note').textContent, 'No photo')
  assert.equal(byClass(panel, 'fh-detail-credit').hidden, true)
  d.destroy()
})

test('mountDetail: a failed photo lookup says so, rather than "No photo"', async () => {
  const { panel, d } = setup(undefined, 503)
  d.update(S, RAW, INFO)
  await flush()
  assert.equal(byClass(panel, 'fh-detail-note').textContent, 'Photo unavailable')
  assert.equal(byClass(panel, 'fh-detail-credit').hidden, true)
  d.destroy()
})

test('mountDetail: lookup once per hex and callsign, close button, destroy removes the panel', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    const { root, panel, d, lookups, closed } = setup()
    for (let i = 0; i < 5; i++) {
      d.update(S, RAW, INFO)
      mock.timers.tick(300)
    }
    d.update({ ...S, callsign: 'AEE9' }, RAW, { ...INFO, callsign: 'AEE9' })
    assert.deepEqual(lookups, ['4691c4/AEE4266', '4691c4/AEE9'])
    byClass(panel, 'fh-detail-close').fire('click')
    assert.equal(closed(), 1)
    d.update({ ...S, gsKt: 1 }, RAW, INFO) // leaves a trailing render pending
    d.destroy()
    assert.equal(root.children.length, 0)
    mock.timers.tick(1000) // the pending render must not run after destroy
    assert.equal(valueOf(panel, 'gs'), '337 kt')
  } finally {
    mock.timers.reset()
  }
})
