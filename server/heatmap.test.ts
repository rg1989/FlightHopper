// server/heatmap.test.ts
// readSlot and encodeHeatmap on files built in memory, and on records copied from a real adsb.lol file. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HEAT_MAGIC, encodeHeatmap, readSlot, type HeatIdentIn, type HeatRecordIn, type HeatSliceIn } from './heatmap.ts'
import { destination, distanceNm } from '../shared/geo.ts'
import { geoidN } from '../shared/geoid.ts'

const SLOT = Date.UTC(2026, 8, 30, 4, 0) // 04:00Z, the start of half hour 08
const TLV = { lat: 32.0114, lon: 34.8867 } // Ben Gurion airport
const Q = { ...TLV, nm: 30, stepS: 10 }

const pos = (hex: string, lat: number, lon: number, alt: HeatRecordIn['alt'], gs: number | null): HeatRecordIn => ({ hex, lat, lon, alt, gs })
const ident = (hex: string, callsign: string | null, squawk: string | null): HeatIdentIn => ({ hex, callsign, squawk })
/** The slice `sec` seconds into the half hour. */
const at = (sec: number, ...records: (HeatRecordIn | HeatIdentIn)[]): HeatSliceIn => ({ tMs: SLOT + sec * 1000, records })
/** The geoid undulation the way the reply carries it: metres, 0.1. */
const geoid = (lat: number, lon: number): number => Math.round(geoidN(lat, lon) * 10) / 10

test('readSlot: the aircraft in the circle, one entry per slice, sorted by hex; ident, ground, unknown altitude and speed, non-ICAO address', () => {
  const file = encodeHeatmap([
    at(0, pos('~abc123', 32.2, 34.9, null, null), ident('738a10', 'ELY397  ', '7500'), pos('738a10', 32.0114, 34.8867, 'g', 12.3), pos('a1b2c3', 40.6413, -73.7781, 5000, 160)),
    at(10, pos('~abc123', 32.2012, 34.9006, null, null), pos('738a10', 32.0121, 34.8869, 1500, 150.4), pos('a1b2c3', 40.65, -73.77, 5025, 161.5)),
  ])
  assert.deepEqual(readSlot(file, Q), {
    slotMs: SLOT,
    stepS: 10,
    aircraft: [
      { hex: '738a10', callsign: 'ELY397', squawk: '7500', nM: geoid(32.0114, 34.8867), t: [0, 10], lat: [32.0114, 32.0121], lon: [34.8867, 34.8869], alt: ['g', 1500], gs: [12.3, 150.4] },
      { hex: '~abc123', callsign: null, squawk: null, nM: geoid(32.2, 34.9), t: [0, 10], lat: [32.2, 32.2012], lon: [34.9, 34.9006], alt: [null, null], gs: [null, null] },
    ],
  })
})

test('readSlot: stepS 20 keeps the slices at +0 s and +20 s and drops +10 s', () => {
  const file = encodeHeatmap([
    at(0, pos('738a10', 32.0, 34.8, 1000, 100)),
    at(10, pos('738a10', 32.1, 34.8, 1000, 100)),
    at(20, pos('738a10', 32.2, 34.8, 1000, 100)),
  ])
  const got = readSlot(file, { ...Q, nm: 100, stepS: 20 })
  assert.equal(got?.stepS, 20)
  assert.deepEqual(got?.aircraft[0].t, [0, 20])
  assert.deepEqual(got?.aircraft[0].lat, [32, 32.2])
  assert.deepEqual(readSlot(file, { ...Q, nm: 100, stepS: 10 })?.aircraft[0].t, [0, 10, 20])
})

test('readSlot: the index records before the first slice header are not positions', () => {
  // As readsb writes them, [offset, 0, 0, 0] per slice come first. Read as a position the first would be aircraft
  // 000003 at 0°, 0°, which the whole-world circle below would show.
  const file = encodeHeatmap([at(0, pos('738a10', 32, 34.8, 1000, 100)), at(10, pos('738a10', 32.1, 34.8, 1000, 100)), at(20, pos('738a10', 32.2, 34.8, 1000, 100))])
  assert.equal(new DataView(file.buffer, file.byteOffset).getUint32(0, true), 3, 'the first record is index 0: the first header is at record 3')
  assert.deepEqual(readSlot(file, { lat: 0, lon: 0, nm: 5400, stepS: 10 })?.aircraft.map((a) => a.hex), ['738a10'])
})

test('readSlot: nm 5400 keeps everything, less is a circle', () => {
  const at5000 = destination(TLV.lat, TLV.lon, 90, 5000)
  const at6000 = destination(TLV.lat, TLV.lon, 90, 6000)
  const at10000 = destination(TLV.lat, TLV.lon, 90, 10_000)
  const file = encodeHeatmap([at(0, pos('738a10', at5000.lat, at5000.lon, 1000, 100), pos('4b1801', at6000.lat, at6000.lon, 1000, 100), pos('e80123', at10000.lat, at10000.lon, 1000, 100))])
  const hexes = (nm: number): string[] | undefined => readSlot(file, { ...TLV, nm, stepS: 300 })?.aircraft.map((a) => a.hex)
  assert.deepEqual(hexes(5400), ['4b1801', '738a10', 'e80123'])
  assert.deepEqual(hexes(5399), ['738a10'])
  assert.deepEqual(hexes(4900), [])
})

test('readSlot: no slice header is null; a header and nobody in the circle is an empty slot', () => {
  assert.equal(readSlot(new Uint8Array(0), Q), null)
  assert.equal(readSlot(new Uint8Array(16 * 5), Q), null, 'zeros: index records only')
  assert.equal(readSlot(encodeHeatmap([]), Q), null)
  assert.equal(readSlot(new TextEncoder().encode('<html>502 Bad Gateway</html>'), Q), null)
  assert.deepEqual(readSlot(encodeHeatmap([at(0)]), Q), { slotMs: SLOT, stepS: 10, aircraft: [] })
  assert.deepEqual(readSlot(encodeHeatmap([at(0, pos('a1b2c3', 40.6413, -73.7781, 5000, 160))]), Q), { slotMs: SLOT, stepS: 10, aircraft: [] })
})

test('readSlot: callsign and squawk are the newest ident record of the hex in the file, also one in a slice that is not kept', () => {
  const file = encodeHeatmap([
    at(0, ident('738a10', 'OLD1    ', '1200'), pos('738a10', 32, 34.8, 1000, 100)),
    at(10, ident('738a10', 'NEW2    ', '7700')), // the newest ident, in a slice stepS 20 drops
    at(20, pos('738a10', 32.1, 34.8, 1000, 100)),
    at(30, ident('4b1801', 'FAR3    ', '2000'), pos('4b1801', 41, -74, 1000, 100)), // an ident, but nowhere near the circle
  ])
  const got = readSlot(file, { ...Q, nm: 100, stepS: 20 })
  assert.deepEqual(got?.aircraft.map((a) => [a.hex, a.callsign, a.squawk, a.t]), [['738a10', 'NEW2', '7700', [0, 20]]])
})

test('readSlot: a callsign loses its trailing spaces and NULs, none or blanks is null, a squawk has four digits, no ident is no callsign and no squawk', () => {
  const file = encodeHeatmap([
    at(
      0,
      ident('000001', 'N123AB', '0030'),
      pos('000001', 32, 34.8, 1000, 100),
      ident('000002', null, '1200'),
      pos('000002', 32, 34.8, 1000, 100),
      ident('000003', '        ', '0000'),
      pos('000003', 32, 34.8, 1000, 100),
      ident('000004', 'AB\0\0\0\0\0\0', '7777'),
      pos('000004', 32, 34.8, 1000, 100),
      pos('000005', 32, 34.8, 1000, 100),
      ident('000006', 'A\x07\xffB', '1000'),
      pos('000006', 32, 34.8, 1000, 100),
    ),
  ])
  const got = readSlot(file, Q)
  assert.deepEqual(
    got?.aircraft.map((a) => [a.hex, a.callsign, a.squawk]),
    [
      ['000001', 'N123AB', '0030'],
      ['000002', null, '1200'],
      ['000003', null, null], // squawk 0000 is none, see the next test
      ['000004', 'AB', '7777'],
      ['000005', null, null],
      ['000006', 'A??B', '1000'], // it is shown as text: a byte that is not printable ASCII becomes ?
    ],
  )
})

test('readSlot: squawk 0 is none, so null, however it was written; every other squawk is four digits', () => {
  // readsb writes 0 when it has no squawk (5 % of the aircraft in a real file); tar1090 shows 0000 as n/a.
  const file = encodeHeatmap([
    at(
      0,
      ident('000001', 'AAA1', '0000'),
      pos('000001', 32, 34.8, 1000, 100),
      ident('000002', 'AAA2', null),
      pos('000002', 32, 34.8, 1000, 100),
      ident('000003', 'AAA3', '0001'),
      pos('000003', 32, 34.8, 1000, 100),
      ident('000004', 'AAA4', '7700'),
      pos('000004', 32, 34.8, 1000, 100),
    ),
  ])
  assert.deepEqual(
    readSlot(file, Q)?.aircraft.map((a) => [a.hex, a.callsign, a.squawk]),
    [
      ['000001', 'AAA1', null],
      ['000002', 'AAA2', null],
      ['000003', 'AAA3', '0001'],
      ['000004', 'AAA4', '7700'],
    ],
  )
})

test('readSlot: positions to 5 decimals, speeds to 0.1, altitudes in 25 ft steps, south and west are negative, a speed of 0 is not unknown', () => {
  const file = encodeHeatmap([at(0, pos('e80123', -33.8688197, -70.9876543, -1400, 123.4), pos('738a10', 32.1234567, 34.8765432, 36000, 0), pos('4b1801', 0, 0, 0, 0.1))])
  const got = readSlot(file, { lat: 0, lon: 0, nm: 5400, stepS: 10 })
  assert.deepEqual(
    got?.aircraft.map((a) => [a.hex, a.lat, a.lon, a.alt, a.gs]),
    [
      ['4b1801', [0], [0], [0], [0.1]],
      ['738a10', [32.12346], [34.87654], [36000], [0]],
      ['e80123', [-33.86882], [-70.98765], [-1400], [123.4]],
    ],
  )
  assert.equal(got?.aircraft[2].nM, geoid(-33.86882, -70.98765))
})

test('readSlot: a record that is not a place on earth is skipped, not an error', () => {
  const file = encodeHeatmap([at(0, pos('000001', 94, 10, 1000, 100), pos('000002', 10, 190, 1000, 100), pos('000003', 89.9, 10, 1000, 100), pos('000004', -90, -180, 1000, 100))])
  assert.deepEqual(readSlot(file, { lat: 0, lon: 0, nm: 5400, stepS: 10 })?.aircraft.map((a) => a.hex), ['000003', '000004'])
  // 94° of latitude is inside this circle's latitude band, and closer than 400 nm by the formula
  assert.deepEqual(readSlot(file, { lat: 89, lon: 10, nm: 400, stepS: 10 })?.aircraft.map((a) => a.hex), ['000003'])
})

// A deterministic spread of points: the same answer on every run.
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('readSlot: the circle is distanceNm exactly, also near the poles and across the antimeridian', () => {
  const rand = mulberry32(7)
  const circles = [
    { lat: 32.0114, lon: 34.8867, nm: 100 },
    { lat: 88, lon: 170, nm: 400 },
    { lat: 0, lon: 179.9, nm: 600 },
    { lat: -60, lon: -179, nm: 2000 },
    { lat: 89.9, lon: 0, nm: 150 },
  ]
  const points: HeatRecordIn[] = []
  const add = (lat: number, lon: number): void => void points.push(pos((points.length + 1).toString(16).padStart(6, '0'), lat, lon, 1000, 100))
  for (let i = 0; i < 1500; i++) add((Math.asin(2 * rand() - 1) * 180) / Math.PI, rand() * 360 - 180) // all over the globe
  for (const c of circles) {
    for (let i = 0; i < 500; i++) {
      const p = destination(c.lat, c.lon, rand() * 360, rand() * c.nm * 1.5) // around the edge of each circle
      add(p.lat, p.lon)
    }
  }
  const file = encodeHeatmap([at(0, ...points)])
  for (const c of circles) {
    // The file holds micro-degrees: measure the same numbers.
    const want = points
      .filter((p) => distanceNm(c.lat, c.lon, Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6) <= c.nm)
      .map((p) => p.hex)
      .sort()
    assert.ok(want.length > 100 && want.length < points.length, `a real test: ${want.length} of ${points.length}`)
    assert.deepEqual(readSlot(file, { ...c, stepS: 10 })?.aircraft.map((a) => a.hex), want)
  }
})

test('readSlot: a view at an odd byteOffset and a Node Buffer read like the file itself; half a record at the end is ignored', () => {
  const file = encodeHeatmap([at(0, ident('738a10', 'ELY397  ', '7500'), pos('738a10', 32, 34.8, 1000, 100), pos('4b1801', 32.1, 34.9, 2000, 200))])
  const padded = new Uint8Array(file.length + 9)
  padded.set(file, 3)
  const want = readSlot(file, Q)
  assert.equal(want?.aircraft[1].callsign, 'ELY397')
  assert.deepEqual(readSlot(padded.subarray(3, 3 + file.length), Q), want)
  assert.deepEqual(readSlot(Buffer.from(file), Q), want)
  assert.deepEqual(readSlot(file.subarray(0, file.length - 5), Q)?.aircraft.map((a) => a.hex), ['738a10'])
})

test('encodeHeatmap: 16-byte little-endian records, the index first, then per slice its header and records', () => {
  const file = encodeHeatmap([
    at(0, ident('738a10', 'ELY397  ', '7500'), pos('~abc123', -32.5, -70.25, 'g', null), pos('738a10', 32.0114, 34.8867, 1500, 150.4)),
    at(10, pos('738a10', 32.0121, 34.8869, null, 0)),
  ])
  assert.equal(file.length, 16 * (2 + 4 + 2), '2 index records, 1 + 3 records, 1 + 1 records')
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const u32 = (rec: number, word: number): number => dv.getUint32(rec * 16 + word * 4, true)
  const i32 = (rec: number, word: number): number => dv.getInt32(rec * 16 + word * 4, true)
  // index: the record number of each slice's header, the rest zero
  assert.deepEqual([u32(0, 0), u32(0, 1), u32(0, 2), u32(0, 3), u32(1, 0), u32(1, 1)], [2, 0, 0, 0, 6, 0])
  // header: magic, the time in ms as high and low 32 bits, the interval in the low 16 bits of the last word
  assert.equal(HEAT_MAGIC, 0x0e7f7c9d)
  assert.equal(u32(2, 0), HEAT_MAGIC)
  assert.equal(u32(2, 1) * 2 ** 32 + u32(2, 2), SLOT)
  assert.equal(dv.getUint16(2 * 16 + 12, true), 10_000)
  assert.equal(u32(6, 0), HEAT_MAGIC)
  assert.equal(u32(6, 1) * 2 ** 32 + u32(6, 2), SLOT + 10_000)
  // ident: the address, 1 << 30 | the squawk's digits as a decimal number, the callsign's 8 bytes
  assert.equal(u32(3, 0), 0x738a10)
  assert.equal(i32(3, 1), (1 << 30) | 7500)
  assert.equal(new TextDecoder().decode(file.subarray(3 * 16 + 8, 3 * 16 + 16)), 'ELY397  ')
  // position: address with bit 24 for a non-ICAO one, degrees × 1e6, altitude / 25 ft (-123 ground, -124 unknown), speed × 10 (-1 unknown)
  assert.equal(u32(4, 0), 0x1abc123)
  assert.equal(i32(4, 1), -32_500_000)
  assert.equal(i32(4, 2), -70_250_000)
  assert.deepEqual([dv.getInt16(4 * 16 + 12, true), dv.getInt16(4 * 16 + 14, true)], [-123, -1])
  assert.equal(i32(5, 1), 32_011_400)
  assert.deepEqual([dv.getInt16(5 * 16 + 12, true), dv.getInt16(5 * 16 + 14, true)], [60, 1504])
  assert.deepEqual([dv.getInt16(7 * 16 + 12, true), dv.getInt16(7 * 16 + 14, true)], [-124, 0])
  // a longer interval
  assert.equal(new DataView(encodeHeatmap([at(0)], 30_000).buffer).getUint16(16 + 12, true), 30_000)
})

// Records copied from adsb.lol's globe_history/2026/09/30/heatmap/08.bin.ttf (04:00-04:30Z, 10 s slices): the file as
// readsb wrote it, not as encodeHeatmap would. Trimmed to two slices, so the two index records are rewritten to point at them.
const REAL = {
  index0: '02000000000000000000000000000000',
  index1: '07000000000000000000000000000000',
  head0: '9d7c7f0ea0010000002278f010270000', // slice 0: 2026-09-30T04:00:00Z, interval 10000 ms
  wzz: '6e1d47008966e801f125140285ff7000', // 471d6e on the ground at Ben Gurion, 11.2 kt
  mfx0: 'aa7c50004ad2eb01791411021c01e409', // 507caa at 7100 ft, 253.2 kt
  tisb: '0c962b513d74e2026760b4f874009107', // a TIS-B track (address type 10, bit 24 set: non-ICAO) near Seattle
  bra: '3f97a300803180fe3cf311fd6806b112', // a3973f in Brazil: south and west
  head1: '9d7c7f0ea0010000104978f010270000', // slice 1: +10 s
  identWzz: '6e1d470083140040575a5a3237574820', // 471d6e: squawk 5251, "WZZ27WH "
  identMfx: 'aa7c5000f21400404d46583337332020', // 507caa: squawk 5362, "MFX373  "
  mfx1: 'aa7c5000ffb2eb01503b11021101fa09', // 507caa at 6825 ft, 255.4 kt
}
const realFile = (): Uint8Array => new Uint8Array(Buffer.from(Object.values(REAL).join(''), 'hex'))

test('real records: readSlot decodes what readsb wrote', () => {
  assert.deepEqual(readSlot(realFile(), Q), {
    slotMs: SLOT,
    stepS: 10,
    aircraft: [
      { hex: '471d6e', callsign: 'WZZ27WH', squawk: '5251', nM: 19.6, t: [0], lat: [32.00782], lon: [34.87487], alt: ['g'], gs: [11.2] },
      { hex: '507caa', callsign: 'MFX373', squawk: '5362', nM: 18.3, t: [0, 10], lat: [32.23201, 32.224], lon: [34.67379, 34.68373], alt: [7100, 6825], gs: [253.2, 255.4] },
    ],
  })
  assert.deepEqual(
    readSlot(realFile(), { ...TLV, nm: 5400, stepS: 10 })?.aircraft.map((a) => a.hex),
    ['471d6e', '507caa', 'a3973f', '~2b960c'],
  )
  const seattle = readSlot(realFile(), { lat: 47.6, lon: -122.3, nm: 100, stepS: 10 })?.aircraft
  assert.deepEqual(seattle, [{ hex: '~2b960c', callsign: null, squawk: null, nM: -21.3, t: [0], lat: [48.39533], lon: [-122.39657], alt: [2900], gs: [193.7] }])
  const brazil = readSlot(realFile(), { lat: -25, lon: -49, nm: 100, stepS: 10 })?.aircraft
  assert.deepEqual(brazil, [{ hex: 'a3973f', callsign: null, squawk: null, nM: 2.7, t: [0], lat: [-25.15315], lon: [-49.15527], alt: [41000], gs: [478.5] }])
})

test('real records: encodeHeatmap writes the same bytes readsb wrote', () => {
  const file = encodeHeatmap([
    at(0, pos('471d6e', 32.007817, 34.874865, 'g', 11.2), pos('507caa', 32.23201, 34.673785, 7100, 253.2), pos('a3973f', -25.153152, -49.155268, 41000, 478.5)),
    at(10, ident('471d6e', 'WZZ27WH ', '5251'), ident('507caa', 'MFX373  ', '5362'), pos('507caa', 32.223999, 34.683728, 6825, 255.4)),
  ])
  // Without the TIS-B record, which the encoder cannot write (it has no address type): slice 1's header is at record 6, not 7.
  const real = Buffer.from([REAL.index0, REAL.index1, REAL.head0, REAL.wzz, REAL.mfx0, REAL.bra, REAL.head1, REAL.identWzz, REAL.identMfx, REAL.mfx1].join(''), 'hex')
  real.writeUInt32LE(6, 16)
  assert.equal(Buffer.from(file).toString('hex'), real.toString('hex'))
})
