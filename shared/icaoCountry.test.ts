// shared/icaoCountry.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCKS, countryOf, flagEmoji } from './icaoCountry.ts'

const hex = (n: number): string => n.toString(16).padStart(6, '0')
const iso = (h: string): string | null => countryOf(h)?.iso2 ?? null

test('flagEmoji: two regional-indicator symbols, case-insensitive', () => {
  assert.equal(flagEmoji('IL'), '\u{1F1EE}\u{1F1F1}')
  assert.equal(flagEmoji('lt'), '\u{1F1F1}\u{1F1F9}')
  assert.equal(flagEmoji('US'), '🇺🇸')
})

test('flagEmoji: anything but two ASCII letters → empty string', () => {
  for (const s of ['', 'I', 'ISR', '1A', 'I-', ' IL', 'É1']) assert.equal(flagEmoji(s), '', JSON.stringify(s))
})

test('countryOf: 503FC4 → Lithuania, either case', () => {
  assert.deepEqual(countryOf('503FC4'), { iso2: 'LT', name: 'Lithuania' })
  assert.deepEqual(countryOf('503fc4'), { iso2: 'LT', name: 'Lithuania' })
})

test('countryOf: whole blocks from end to end, names', () => {
  const cases: [number, number, string, string][] = [
    [0x738000, 0x73ffff, 'IL', 'Israel'],
    [0xa00000, 0xafffff, 'US', 'United States'],
    [0x400000, 0x43ffff, 'GB', 'United Kingdom'],
    [0x3c0000, 0x3fffff, 'DE', 'Germany'],
    [0x440000, 0x447fff, 'AT', 'Austria'],
  ]
  for (const [lo, hi, code, name] of cases) {
    for (const a of [lo, lo + 1, (lo + hi) >> 1, hi - 1, hi]) assert.deepEqual(countryOf(hex(a)), { iso2: code, name }, hex(a))
  }
})

test('countryOf: the addresses just outside those blocks belong to the neighbours (or nobody)', () => {
  assert.equal(iso('737fff'), 'IR')
  assert.equal(iso('740000'), 'JO')
  assert.equal(iso('3bffff'), 'FR')
  assert.equal(iso('448000'), 'BE')
  assert.equal(iso('9fffff'), null)
  assert.equal(iso('b00000'), null)
})

test('countryOf: Amendment 92 blocks (2 048-address blocks, Colombia 8 192, Qatar 4 096, new States)', () => {
  assert.equal(iso('501800'), 'HR')   // Croatia: 501800–501FFF (was 501C00 before the blocks were doubled)
  assert.equal(iso('5017ff'), 'AL')   // Albania: 501000–5017FF
  assert.equal(iso('0adfff'), 'CO')
  assert.equal(iso('06afff'), 'QA')
  assert.equal(iso('4c0000'), 'RS')
  assert.equal(iso('516000'), 'ME')
  assert.equal(iso('c94000'), 'SS')
  assert.equal(iso('c977ff'), 'TV')
})

test('countryOf: 899xxx (ICAO special-use block) → Taiwan, de facto', () => {
  assert.deepEqual(countryOf('8990a5'), { iso2: 'TW', name: 'Taiwan' })
})

test('countryOf: unallocated, ICAO-administered, non-ICAO and malformed addresses → null', () => {
  for (const s of ['000001', '000000', '003fff', 'ffffff', 'f00001', 'f09000', '~a330e6', '~503fc4', '', '503fc', '503fc4a', 'zzzzzz', ' 503fc4', '0x503f']) {
    assert.equal(countryOf(s), null, JSON.stringify(s))
  }
})

test('countryOf: returns one shared object per block (no allocation per call)', () => {
  assert.equal(countryOf('503fc4'), countryOf('503800'))
  assert.ok(Object.isFrozen(countryOf('503fc4')))
})

test('BLOCKS: sorted by start and never overlapping', () => {
  for (let i = 1; i < BLOCKS.length; i++) {
    assert.ok(BLOCKS[i - 1][1] < BLOCKS[i][0], `${hex(BLOCKS[i - 1][0])} overlaps ${hex(BLOCKS[i][0])}`)
  }
})

test('BLOCKS: every block has an Annex 10 size and is aligned to it', () => {
  const sizes = new Set([2048, 4096, 8192, 32768, 262144, 1048576])
  for (const [start, end] of BLOCKS) {
    const n = end - start + 1
    assert.ok(sizes.has(n), `${hex(start)}: ${n} addresses`)
    assert.equal(start % n, 0, `${hex(start)} not aligned to ${n}`)
  }
})

test('BLOCKS: 193 States + Taiwan, one block each, ISO 3166-1 codes that Intl knows', () => {
  const regions = new Intl.DisplayNames(['en'], { type: 'region' })
  const seen = new Set<string>()
  for (const [, , iso2, name] of BLOCKS) {
    assert.match(iso2, /^[A-Z]{2}$/)
    assert.ok(!seen.has(iso2), `duplicate ${iso2}`)
    seen.add(iso2)
    const known = regions.of(iso2)
    assert.ok(known !== iso2 && known !== 'Unknown Region', `${iso2} is not an ISO 3166-1 region`)
    assert.ok(name.length > 1)
  }
  assert.equal(BLOCKS.length, 194)
})
