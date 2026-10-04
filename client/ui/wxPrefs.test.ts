// client/ui/wxPrefs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_WX_PREFS, WX_PREFS_KEY, WX_URL_KEYS, dropWxAids, readWxPrefs, savedAfter, writeWxPrefs, type WxPrefs } from './wxPrefs.ts'

const DEFAULTS: WxPrefs = { look: 'severity', hazard: 'curtain', track: true, slice: false, strip: true }

test('nothing stored, nothing in the URL: severity colours, curtains, the track line and the strip on, the slice off; the key is fh.wx3d.v1', () => {
  assert.equal(WX_PREFS_KEY, 'fh.wx3d.v1')
  assert.deepEqual(DEFAULT_WX_PREFS, DEFAULTS)
  assert.deepEqual(readWxPrefs('', null), DEFAULTS)
  assert.deepEqual(readWxPrefs('?hex=4691c4&chase=1&wx=1', null), DEFAULTS) // other parameters are not ours
  const a = readWxPrefs('', null)
  a.look = 'blocks' // the caller owns what it gets back
  assert.deepEqual(readWxPrefs('', null), DEFAULTS)
  assert.throws(() => (DEFAULT_WX_PREFS.track = false), TypeError) // shared: frozen
})

test('the stored JSON wins over the defaults, field by field', () => {
  assert.deepEqual(readWxPrefs('', '{"look":"blocks","hazard":"fence","track":false,"slice":true,"strip":false}'), {
    look: 'blocks', hazard: 'fence', track: false, slice: true, strip: false,
  })
  assert.deepEqual(readWxPrefs('', '{"look":"natural"}'), { ...DEFAULTS, look: 'natural' })
  assert.deepEqual(readWxPrefs('', '{"hazard":"box","slice":true}'), { ...DEFAULTS, hazard: 'box', slice: true })
})

test('the URL aids (?wxlook, ?wxhaz, ?wxtrack, ?wxslice, ?wxstrip) win over the stored JSON, with or without the leading ?', () => {
  const stored = '{"look":"blocks","hazard":"fence","track":false,"slice":false,"strip":false}'
  assert.deepEqual(readWxPrefs('?wxlook=natural', stored), { look: 'natural', hazard: 'fence', track: false, slice: false, strip: false })
  assert.deepEqual(readWxPrefs('?wxhaz=box', stored), { look: 'blocks', hazard: 'box', track: false, slice: false, strip: false })
  assert.deepEqual(readWxPrefs('?wxtrack=1', stored), { look: 'blocks', hazard: 'fence', track: true, slice: false, strip: false })
  assert.deepEqual(readWxPrefs('?wxslice=1', stored), { look: 'blocks', hazard: 'fence', track: false, slice: true, strip: false })
  assert.deepEqual(readWxPrefs('?wxstrip=1', stored), { look: 'blocks', hazard: 'fence', track: false, slice: false, strip: true })
  assert.deepEqual(readWxPrefs('wxlook=severity&wxhaz=curtain&wxtrack=1&wxslice=1&wxstrip=1', stored), { look: 'severity', hazard: 'curtain', track: true, slice: true, strip: true })
  assert.deepEqual(readWxPrefs('?wxtrack=0&wxstrip=0', null), { ...DEFAULTS, track: false, strip: false }) // and over the defaults
  assert.deepEqual(readWxPrefs('?hex=a831b2&wxlook=natural&wx=1', null), { ...DEFAULTS, look: 'natural' })
  assert.deepEqual(readWxPrefs('?wxlook=natural&wxlook=blocks', null), { ...DEFAULTS, look: 'natural' }) // the first one counts, as URLSearchParams.get
})

test('a URL value that is not one of the choices is ignored: the stored value or the default stands', () => {
  const stored = '{"look":"blocks","hazard":"fence","track":false,"slice":true}'
  for (const v of ['', 'fog', 'NATURAL', ' natural', 'natural ', 'true', '0', '1']) {
    assert.equal(readWxPrefs(`?wxlook=${v}`, stored).look, 'blocks', `?wxlook=${v}`)
    assert.equal(readWxPrefs(`?wxlook=${v}`, null).look, 'severity', `?wxlook=${v}`)
  }
  for (const v of ['', 'wall', 'BOX', 'curtains', '1']) {
    assert.equal(readWxPrefs(`?wxhaz=${v}`, stored).hazard, 'fence', `?wxhaz=${v}`)
    assert.equal(readWxPrefs(`?wxhaz=${v}`, null).hazard, 'curtain', `?wxhaz=${v}`)
  }
  for (const v of ['', 'true', 'false', 'on', 'off', '2', ' 1', '01']) {
    const q = `?wxtrack=${v}&wxslice=${v}&wxstrip=${v}`
    assert.deepEqual(readWxPrefs(q, stored), { look: 'blocks', hazard: 'fence', track: false, slice: true, strip: true }, q)
    assert.deepEqual(readWxPrefs(q, null), DEFAULTS, q)
  }
  assert.deepEqual(readWxPrefs('?WXLOOK=natural&WxHaz=box', null), DEFAULTS) // names are case-sensitive
})

test('corrupt, partial or mistyped stored JSON falls back per field and never throws', () => {
  for (const bad of ['', 'not json', '{"look":', 'null', '42', '"look"', 'true', '[1,2]', '{}']) {
    assert.deepEqual(readWxPrefs('', bad), DEFAULTS, bad)
  }
  // Only a real choice or a real boolean counts.
  assert.deepEqual(readWxPrefs('', '{"look":3,"hazard":null,"track":"yes","slice":1,"strip":0}'), DEFAULTS)
  assert.deepEqual(readWxPrefs('', '{"look":"fog","hazard":"wall","track":false}'), { ...DEFAULTS, track: false })
  assert.deepEqual(readWxPrefs('', '{"look":"blocks","extra":true}'), { ...DEFAULTS, look: 'blocks' })
  assert.deepEqual(readWxPrefs('?wxlook=natural', 'not json'), { ...DEFAULTS, look: 'natural' }) // the URL still applies over a corrupt value
  assert.doesNotThrow(() => readWxPrefs('?%E0%A4%A', '{"look":'))
})

test('writeWxPrefs stores the five fields as JSON under fh.wx3d.v1, and readWxPrefs reads them back', () => {
  const store = new Map<string, string>()
  const storage = { setItem: (k: string, v: string): void => void store.set(k, v) }
  const p: WxPrefs = { look: 'blocks', hazard: 'fence', track: false, slice: true, strip: false }
  writeWxPrefs({ ...p, extra: 1 } as WxPrefs, storage)
  assert.deepEqual([...store.keys()], [WX_PREFS_KEY])
  assert.deepEqual(JSON.parse(store.get(WX_PREFS_KEY) ?? ''), p)
  for (const look of ['natural', 'severity', 'blocks'] as const) {
    for (const hazard of ['curtain', 'fence', 'box'] as const) {
      for (const track of [false, true]) {
        const q: WxPrefs = { look, hazard, track, slice: !track, strip: track }
        writeWxPrefs(q, storage)
        assert.deepEqual(readWxPrefs('', store.get(WX_PREFS_KEY) ?? null), q)
      }
    }
  }
})

test('writeWxPrefs never throws: no storage, private mode, a full quota', () => {
  assert.doesNotThrow(() => writeWxPrefs(DEFAULTS, null))
  let calls = 0
  const failing = (name: string) => ({
    setItem: (): void => {
      calls++
      throw new DOMException('refused', name)
    },
  })
  assert.doesNotThrow(() => writeWxPrefs(DEFAULTS, failing('QuotaExceededError')))
  assert.doesNotThrow(() => writeWxPrefs(DEFAULTS, failing('SecurityError')))
  assert.equal(calls, 2) // it did try
})

test('dropWxAids: the aids of the choices that changed leave the address, the rest of it stays as it was', () => {
  assert.deepEqual(WX_URL_KEYS, { look: 'wxlook', hazard: 'wxhaz', track: 'wxtrack', slice: 'wxslice', strip: 'wxstrip' })
  assert.equal(dropWxAids('?hex=a831b2&chase=1&wxlook=natural&wxhaz=box', ['look']), '?hex=a831b2&chase=1&wxhaz=box')
  assert.equal(dropWxAids('?wxlook=natural&wxhaz=box&wxtrack=0&wxslice=1&wxstrip=0', ['hazard', 'strip']), '?wxlook=natural&wxtrack=0&wxslice=1')
  assert.equal(dropWxAids('?wxlook=natural', ['look']), '', 'nothing left: no ?')
  assert.equal(dropWxAids('wxlook=natural&at=32.0,34.8,12', ['look']), '?at=32.0,34.8,12', 'the commas stay as they are (urlState.ts writes them so)')
  // Nothing of ours to take out: the very same string, so the app does not touch the address.
  assert.equal(dropWxAids('?hex=a831b2&at=32.0%2C34.8%2C12', ['look', 'track']), '?hex=a831b2&at=32.0%2C34.8%2C12')
  assert.equal(dropWxAids('?wxlook=natural', []), '?wxlook=natural')
  assert.equal(dropWxAids('', ['look']), '')
})

test('savedAfter: a choice made in the menu is written onto what was saved; a URL aid in force for this load is not, unless it is the field that changed', () => {
  // Blocks was saved; the link asks for Natural and for the level slice, for this load.
  const stored = '{"look":"blocks","hazard":"fence","track":true,"slice":false,"strip":true}'
  const saved = readWxPrefs('', stored)
  const inForce = readWxPrefs('?wxlook=natural&wxslice=1', stored)
  assert.deepEqual(inForce, { look: 'natural', hazard: 'fence', track: true, slice: true, strip: true })
  // The person turns the ahead strip off, and nothing else.
  const next = { ...inForce, strip: false }
  assert.deepEqual(savedAfter(saved, inForce, next), { look: 'blocks', hazard: 'fence', track: true, slice: false, strip: false }, 'Blocks stays saved, and the slice stays off')
  assert.deepEqual(saved, { look: 'blocks', hazard: 'fence', track: true, slice: false, strip: true }, 'what was saved is not changed in place')
  // The person then picks Severity colours over the link's Natural: that is their choice, and is saved.
  const after = savedAfter(savedAfter(saved, inForce, next), next, { ...next, look: 'severity' })
  assert.deepEqual(after, { look: 'severity', hazard: 'fence', track: true, slice: false, strip: false })
  // A choice back to what the link had asked for is a choice too.
  assert.equal(savedAfter(saved, { ...inForce, slice: false }, inForce).slice, true)
  assert.deepEqual(savedAfter(saved, inForce, inForce), saved, 'nothing changed: nothing written')
  // What is stored is what a load without the link reads back.
  const store = new Map<string, string>()
  writeWxPrefs(savedAfter(saved, inForce, next), { setItem: (k, v) => void store.set(k, v) })
  assert.deepEqual(readWxPrefs('', store.get(WX_PREFS_KEY)!), { look: 'blocks', hazard: 'fence', track: true, slice: false, strip: false })
})
