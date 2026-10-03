// client/scene/wxField.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PUFF_FILL, sequence, tower, type CloudSpec } from './cloudField.ts'
import { BANDS, BAND_TOP_M, FIELD_KM, FIELD_N, HEIGHT_MAX_M, TOWER_BAND, buildField, coverAt, fieldAtlas, profile, sampleField } from './wxField.ts'

const KM_PER_DEG = 111.195
const TEXEL_KM = FIELD_KM / FIELD_N
const LAT = 32
const LON = 34.9
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
/** The place eastKm and northKm of (lat, lon), on the plane round it. */
const at = (eastKm: number, northKm: number, lat = LAT, lon = LON): { lat: number; lon: number } =>
  ({ lat: lat + northKm / KM_PER_DEG, lon: lon + eastKm / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180)) })

/** A puff whose base and top are given (the spec's height and billboard follow from them); wide: its billboard's width, m. */
function puff(baseM: number, topM: number, o: Partial<CloudSpec> & { eastKm?: number; northKm?: number; wide?: number } = {}): CloudSpec {
  const { eastKm = 0, northKm = 0, wide = 3000, ...rest } = o
  return {
    ...at(eastKm, northKm), heightM: (baseM + topM) / 2, groundM: 0, scale: [wide, (topM - baseM) / PUFF_FILL], maxSize: [20, 12, 12], slice: 0.3,
    brightness: 1, tint: 0, farKm: 100, ...rest,
  }
}
const k = (i: number, j: number): number => j * FIELD_N + i
/** Where the middle of texel (i, j) is, km east and north of the field's middle. */
const middleOf = (i: number, j: number): { eastKm: number; northKm: number } => ({ eastKm: (i - (FIELD_N - 1) / 2) * TEXEL_KM, northKm: (j - (FIELD_N - 1) / 2) * TEXEL_KM })
/** What a shader\'s texture() gives at lat, lon from one of the field\'s maps: the four texels round it mixed plainly, the outer texels held out to the edge. */
function bilinear(a: Float32Array, lat: number, lon: number): number {
  const u = (((lon - LON) * KM_PER_DEG * Math.cos((LAT * Math.PI) / 180)) / TEXEL_KM) + (FIELD_N - 1) / 2
  const v = (((lat - LAT) * KM_PER_DEG) / TEXEL_KM) + (FIELD_N - 1) / 2
  const [x, y] = [Math.min(FIELD_N - 1, Math.max(0, u)), Math.min(FIELD_N - 1, Math.max(0, v))]
  const [i, j] = [Math.min(FIELD_N - 2, Math.floor(x)), Math.min(FIELD_N - 2, Math.floor(y))]
  const [fx, fy] = [x - i, y - j]
  return a[j * FIELD_N + i] * (1 - fx) * (1 - fy) + a[j * FIELD_N + i + 1] * fx * (1 - fy) + a[(j + 1) * FIELD_N + i] * (1 - fx) * fy + a[(j + 1) * FIELD_N + i + 1] * fx * fy
}
const C = FIELD_N / 2 // the four texels round the field's middle are C − 1 and C, in each direction
/** The texel (i, j) of the field round a spec at the field's middle that is in the middle of those four. */
const MIDDLE = [k(C - 1, C - 1), k(C, C - 1), k(C - 1, C), k(C, C)]

test('the field\'s constants: 512 texels over 320 km, four layer bands by a cloud\'s base and one for towers, heights packed over 16,000 m', () => {
  assert.equal(FIELD_N, 512)
  assert.equal(FIELD_KM, 320)
  assert.equal(BANDS, 5)
  assert.equal(TOWER_BAND, 4)
  assert.deepEqual([...BAND_TOP_M], [2000, 4500, 8000])
  assert.equal(HEIGHT_MAX_M, 16000)
})

test('profile: a flat base and a rounded top, 0 … 1, zero outside the cloud', () => {
  const [base, top] = [1000, 3000]
  const up = (h: number): number => profile(base + h * (top - base), base, top) // h: the share of the way from the base to the top
  assert.equal(up(0), 0)
  assert.ok(near(up(0.14), 1, 1e-12) && near(up(0.3), 1, 1e-12) && near(up(0.55), 1, 1e-12), 'full from 14 % to 55 % of the way up')
  assert.ok(up(0.07) > 0.3 && up(0.07) < 0.7, 'the base rises quickly (over the lowest 14 %)')
  assert.ok(near(up(1), 0, 1e-12), 'nothing at the top')
  for (let h = 0.55; h < 0.99; h += 0.05) assert.ok(up(h + 0.05) <= up(h) + 1e-12, `falling from 55 % up: ${h}`)
  assert.ok(up(0.8) > 0.2 && up(0.8) < 0.7, 'a rounded top, not a cut')
  assert.equal(up(-0.2), 0)
  assert.equal(up(1.2), 0)
  assert.equal(profile(500, 1000, 1000), 0, 'a cloud with no thickness has no profile')
  // a tall body keeps the ends a thin cloud has in metres, not in shares: its base rises over 300 m and its top is rounded over 900 m
  assert.equal(profile(1000, 1000, 10000), 0)
  assert.ok(near(profile(1150, 1000, 10000), 0.5, 1e-12), 'half way up the 300 m')
  assert.equal(profile(1300, 1000, 10000), 1)
  assert.equal(profile(9100, 1000, 10000), 1, 'full until 900 m under the top')
  assert.ok(near(profile(9550, 1000, 10000), 0.5, 1e-12), 'half way down the 900 m')
  assert.equal(profile(10000, 1000, 10000), 0)
  assert.equal(profile(1000, 1000, 500), 0)
})

test('buildField: a spec at the middle fills the four texels round it in the band its base falls in, with its own base and top', () => {
  const f = buildField([puff(1200, 1800, { sev: 2 })], LAT, LON)
  assert.equal(f.lat, LAT)
  assert.equal(f.lon, LON)
  assert.equal(f.empty, false)
  assert.equal(f.cov.length, BANDS)
  for (const a of [...f.cov, ...f.base, ...f.top, ...f.sev]) assert.equal(a.length, FIELD_N * FIELD_N)
  for (const i of MIDDLE) {
    assert.ok(f.cov[0][i] > 0.9, `cover ${f.cov[0][i]}`)
    assert.ok(near(f.base[0][i], 1200, 1e-3) && near(f.top[0][i], 1800, 1e-3), `${f.base[0][i]} to ${f.top[0][i]}`)
    assert.ok(near(f.sev[0][i], 2, 1e-6))
  }
  for (const b of [1, 2, 3, 4]) assert.ok(f.cov[b].every((v) => v === 0), `band ${b} is empty`)
  assert.deepEqual([f.lo[0], f.hi[0]], [1200, 1800])
  for (const b of [1, 2, 3, 4]) assert.ok(f.lo[b] > f.hi[b], `band ${b}: lo > hi means empty`)
  for (const a of [f.lo, f.hi]) assert.equal(a.length, BANDS)
})

test('buildField: nothing 20 km away, and the disc is soft: whole inside 55 % of its radius, nothing at its rim', () => {
  const f = buildField([puff(1200, 1800, { wide: 8000 })], LAT, LON) // a radius of 0.36 × 8 km = 2.88 km
  const i20 = Math.round(C - 0.5 + 20 / TEXEL_KM)
  for (let j = C - 40; j <= C + 40; j++) assert.equal(f.cov[0][k(i20, j)], 0)
  const row = (km: number): number => f.cov[0][k(Math.round(C - 0.5 + km / TEXEL_KM), C)]
  assert.equal(row(1.0), 1, '1 km: inside 55 % of 2.88 km')
  assert.ok(row(2.2) > 0 && row(2.2) < 1, 'the fall')
  assert.ok(row(2.2) < row(1.8), 'falling outward')
  assert.equal(row(3.5), 0, 'beyond the rim')
})

test('buildField: a spec lands in the band its base falls in: under 2,000 m, to 4,500, to 8,000, above (a base on an edge is in the band above)', () => {
  for (const [base, band] of [[0, 0], [1999, 0], [2000, 1], [3000, 1], [4499, 1], [4500, 2], [7999, 2], [8000, 3], [12000, 3]] as const) {
    const f = buildField([puff(base, base + 800, { wide: 4000 })], LAT, LON)
    for (let b = 0; b < BANDS; b++) {
      const has = MIDDLE.every((i) => f.cov[b][i] > 0.9)
      const none = f.cov[b].every((v) => v === 0)
      assert.ok(b === band ? has : none, `base ${base}: band ${b}`)
    }
  }
})

test('buildField: a spec\'s base and top are its height ∓ PUFF_FILL × half its billboard\'s height', () => {
  const s = puff(0, 0, { heightM: 6000, scale: [4000, 2000] })
  const f = buildField([s], LAT, LON)
  assert.ok(near(f.base[2][MIDDLE[0]], 6000 - (PUFF_FILL * 2000) / 2, 1e-2))
  assert.ok(near(f.top[2][MIDDLE[0]], 6000 + (PUFF_FILL * 2000) / 2, 1e-2))
})

test('buildField: two overlapping deck puffs give more cover than either alone; two on one spot average their base, top and severity by their weights', () => {
  // 4 texels (2.5 km) each side of texel (C − 1, C − 1), on the fall of a disc of radius 3 km
  const mid = k(C - 1, C - 1)
  const a = puff(7000, 8700, { wide: 8300, ...middleOf(C - 5, C - 1) })
  const b = puff(7000, 8700, { wide: 8300, ...middleOf(C + 3, C - 1) })
  const [fa, fb, fab] = [[a], [b], [a, b]].map((s) => buildField(s, LAT, LON))
  assert.ok(fa.cov[2][mid] > 0 && fa.cov[2][mid] < 1 && fb.cov[2][mid] > 0 && fb.cov[2][mid] < 1, 'each alone is on its fall at the middle')
  assert.ok(fab.cov[2][mid] > Math.max(fa.cov[2][mid], fb.cov[2][mid]) + 0.05, `${fab.cov[2][mid]} against ${fa.cov[2][mid]}, ${fb.cov[2][mid]}`)
  assert.ok(near(fab.cov[2][mid], 1 - (1 - fa.cov[2][mid]) * (1 - fb.cov[2][mid]), 1e-5), 'joined as 1 − Π(1 − w)')
  assert.ok(fab.cov[2][mid] <= 1)

  const x = puff(1200, 1800, { wide: 3000, sev: 1 })
  const y = puff(1400, 2000, { wide: 3000, sev: 3 })
  const f = buildField([x, y], LAT, LON)
  for (const i of [MIDDLE[0], MIDDLE[3], k(C + 1, C)]) { // the radius is 1.08 km: the third is on the fall
    assert.ok(f.cov[0][i] > 0)
    assert.ok(near(f.base[0][i], 1300, 1e-2) && near(f.top[0][i], 1900, 1e-2) && near(f.sev[0][i], 2, 1e-5), `${f.base[0][i]} ${f.top[0][i]} ${f.sev[0][i]}`)
  }
  assert.deepEqual([f.lo[0], f.hi[0]], [1200, 2000], 'the band\'s lowest base and highest top')
})

test('buildField: a spec\'s sev counts for none when absent, and a texel\'s severity is the weights\' average between a storm\'s edge and its neighbour', () => {
  const f = buildField([puff(1200, 1800)], LAT, LON)
  assert.ok(f.cov[0][MIDDLE[0]] > 0 && f.sev[0][MIDDLE[0]] === 0)
  const g = buildField([puff(1200, 1800, { sev: 3, eastKm: -1.5, wide: 6000 }), puff(1200, 1800, { sev: 1, eastKm: 1.5, wide: 6000 })], LAT, LON)
  const row = (km: number): number => g.sev[0][k(Math.round(C - 0.5 + km / TEXEL_KM), C)]
  assert.ok(row(-2.5) > row(0) && row(0) > row(2.5), `${row(-2.5)} > ${row(0)} > ${row(2.5)}: from 3 toward 1`)
  assert.ok(row(0) > 1 && row(0) < 3)
})

test('buildField: the radius is at least a texel: a tiny puff still marks the map', () => {
  const f = buildField([puff(1200, 1800, { wide: 100 })], LAT, LON)
  assert.ok(MIDDLE.some((i) => f.cov[0][i] > 0.5), `${MIDDLE.map((i) => f.cov[0][i])}`)
})

test('buildField: east–west is the longitude difference times cos(lat) (at 60°N, 40 km east is twice the degrees); a flat map of the field\'s own middle', () => {
  const s = puff(1200, 1800, { ...at(40, 0, 60, 10), wide: 6000 })
  const f = buildField([s], 60, 10)
  const i40 = Math.round(C - 0.5 + 40 / TEXEL_KM)
  assert.ok(f.cov[0][k(i40, C)] > 0.9, 'at 40 km east')
  assert.equal(f.cov[0][k(Math.round(C - 0.5 + 20 / TEXEL_KM), C)], 0, 'not at 20 km')
  assert.equal(f.cov[0][k(C, C)], 0)
})

test('buildField: north is up the rows, east along the columns, from the south-west corner', () => {
  const f = buildField([puff(1200, 1800, { eastKm: 30, northKm: -20, wide: 6000 })], LAT, LON)
  const i = Math.round(C - 0.5 + 30 / TEXEL_KM)
  const j = Math.round(C - 0.5 - 20 / TEXEL_KM)
  assert.ok(f.cov[0][k(i, j)] > 0.9, 'column 30 km east, row 20 km south')
  assert.equal(f.cov[0][k(j, i)], 0, 'not the other way round')
})

test('buildField: specs outside the square are skipped; one across the antimeridian is where it is', () => {
  const far = buildField([puff(1200, 1800, { eastKm: 200 }), puff(1200, 1800, { northKm: -250 }), puff(1200, 1800, { eastKm: -180, wide: 8000 })], LAT, LON)
  assert.equal(far.empty, true)
  assert.ok(far.lo.every((v, b) => v > far.hi[b]), 'every band empty')
  assert.ok(far.cov.every((a) => a.every((v) => v === 0)))
  const e = buildField([], LAT, LON)
  assert.equal(e.empty, true)
  const edge = buildField([puff(1200, 1800, { eastKm: 159, wide: 8000 })], LAT, LON)
  assert.equal(edge.empty, false, 'a spec just inside the square')
  assert.ok(edge.cov[0][k(FIELD_N - 1, C)] > 0)
  // 179.9°E and a puff at −179.9°E: 21 km east of it
  const x = buildField([puff(1200, 1800, { lat: 10, lon: -179.9, wide: 6000 })], 10, 179.9)
  const i = Math.round(C - 0.5 + (0.2 * KM_PER_DEG * Math.cos((10 * Math.PI) / 180)) / TEXEL_KM)
  assert.ok(x.cov[0][k(i, C)] > 0.9, 'across the antimeridian')
})

test('buildField: heights are kept inside what can be packed, 0 … 16,000 m', () => {
  const f = buildField([puff(-300, 500), puff(15000, 19000, { eastKm: 20 })], LAT, LON)
  assert.equal(f.lo[0], 0)
  assert.ok(f.hi.every((h, b) => h <= HEIGHT_MAX_M || f.lo[b] > h))
  assert.ok(near(f.top[3][k(Math.round(C - 0.5 + 20 / TEXEL_KM), C)], HEIGHT_MAX_M, 1e-2))
})

test('sampleField: more than 0.5 mid-cloud, 0 above the top and below the base, 0 outside the square, 0 for no field', () => {
  const f = buildField([puff(900, 2100, { wide: 5000 })], LAT, LON)
  const here = at(0, 0)
  assert.ok(sampleField(f, here.lat, here.lon, 1300).cover > 0.9, 'mid-cloud')
  assert.equal(sampleField(f, here.lat, here.lon, 2200).cover, 0, 'above the top')
  assert.equal(sampleField(f, here.lat, here.lon, 800).cover, 0, 'below the base')
  assert.equal(sampleField(f, here.lat, here.lon, 20000).cover, 0)
  assert.equal(sampleField(f, here.lat + 1.5, here.lon, 1300).cover, 0, 'north of the square')
  assert.equal(sampleField(f, here.lat, here.lon + 3, 1300).cover, 0, 'east of it')
  assert.deepEqual(sampleField(null, here.lat, here.lon, 1300), { cover: 0, sev: 0 })
  assert.deepEqual(sampleField(buildField([], LAT, LON), here.lat, here.lon, 1300), { cover: 0, sev: 0 })
  assert.ok(near(sampleField(f, here.lat, here.lon, 1300).cover, profile(1300, 900, 2100), 1e-5), 'the cover is the texels\' cover times the profile at that height')
  assert.ok(sampleField(f, here.lat, here.lon, 2000).cover < sampleField(f, here.lat, here.lon, 1500).cover, 'a rounded top')
})

test('sampleField: plain bilinear between texel centres: cover, base, top and severity are each mixed as a shader\'s texture() would, and the cover times the profile is the answer', () => {
  const f = buildField([puff(900, 2100, { wide: 5000, sev: 3 })], LAT, LON)
  const row = (km: number): { cover: number; sev: number } => { const p = at(km, 0); return sampleField(f, p.lat, p.lon, 1300) }
  const cov = Array.from({ length: 24 }, (_, i) => row(i * 0.1).cover)
  for (let i = 1; i < cov.length; i++) assert.ok(cov[i] <= cov[i - 1] + 1e-9, `no jump outward: ${cov[i - 1]} then ${cov[i]}`)
  assert.ok(cov[0] > 0.99 && cov[23] < cov[0])
  const rim = row(1.7)
  assert.ok(rim.cover > 0 && rim.cover < 0.9, `on the rim: ${rim.cover}`)
  assert.ok(near(rim.sev, 3, 1e-5), 'its severity is the cloud\'s, not diluted by the empty texels beside it')
  const m = at(TEXEL_KM / 2, TEXEL_KM / 2) // on a texel's centre, 0.3 km off the field's middle
  assert.ok(sampleField(f, m.lat, m.lon, 1300).cover > 0.9)
  // anywhere: what the four texels give, mixed plainly
  for (const [e, n] of [[0.13, 0.4], [1.37, -0.8], [-2.2, 0.9], [2.0, 2.0], [0.0, -1.9]]) {
    const p = at(e, n)
    for (const alt of [950, 1300, 1900, 2050]) {
      const want = bilinear(f.cov[0], p.lat, p.lon) * profile(alt, bilinear(f.base[0], p.lat, p.lon), bilinear(f.top[0], p.lat, p.lon))
      assert.ok(near(sampleField(f, p.lat, p.lon, alt).cover, want, 1e-6), `${e}, ${n} at ${alt} m`)
    }
  }
})

test('sampleField: half a texel outside a puff\'s rim, and anywhere the cover is above 0, the base and top are still the puff\'s (to within 100 m); the cover is small', () => {
  const [base, top] = [1200, 1800]
  const wide = 6250 // a radius of 2.25 km = 3.6 texels
  const f = buildField([puff(base, top, { wide, eastKm: 0.2, northKm: -0.1, sev: 2 })], LAT, LON)
  const rimKm = (0.36 * wide) / 1000
  let small = 0
  for (let deg = 0; deg < 360; deg += 10) {
    for (let t = -1; t <= 2.001; t += 0.25) { // texels from the rim
      const r = rimKm + t * TEXEL_KM
      const p = at(0.2 + r * Math.cos((deg * Math.PI) / 180), -0.1 + r * Math.sin((deg * Math.PI) / 180))
      const cover = bilinear(f.cov[0], p.lat, p.lon)
      if (cover <= 1e-6) continue
      const [b, tp, sv] = [bilinear(f.base[0], p.lat, p.lon), bilinear(f.top[0], p.lat, p.lon), bilinear(f.sev[0], p.lat, p.lon)]
      assert.ok(near(b, base, 100) && near(tp, top, 100) && near(sv, 2, 0.01), `${deg}°, ${t} texels from the rim: ${b} to ${tp}, sev ${sv}, cover ${cover}`)
      if (t > 0) assert.ok(cover < 0.3, `outside the rim the cover is small: ${cover}`)
      if (t > 0 && t <= 0.5) small++
    }
  }
  assert.ok(small > 20, `${small} samples within half a texel outside the rim have some cover`)
})

test('sampleField: the band the cover comes from gives the severity; a low cloud under a high deck are told apart by their heights', () => {
  const f = buildField([puff(1200, 1800, { wide: 6000, sev: 0 }), puff(7000, 8700, { wide: 9000, sev: 2 })], LAT, LON)
  const p = at(0, 0)
  const low = sampleField(f, p.lat, p.lon, 1400)
  const high = sampleField(f, p.lat, p.lon, 7800)
  assert.ok(low.cover > 0.9 && low.sev === 0)
  assert.ok(high.cover > 0.9 && near(high.sev, 2, 1e-6))
  assert.equal(sampleField(f, p.lat, p.lon, 4000).cover, 0, 'clear between them')
  assert.equal(sampleField(f, p.lat, p.lon, 1900).cover, 0)
})

test('sampleField: the highest cover of the bands wins where clouds of two bands share a height', () => {
  const f = buildField([puff(1500, 3500, { wide: 6000, sev: 1 }), puff(2800, 5000, { wide: 6000, sev: 3 })], LAT, LON) // bands 0 and 1; they share 2,800 … 3,500
  const p = at(0, 0)
  const a = profile(3100, 1500, 3500)
  const b = profile(3100, 2800, 5000)
  const s = sampleField(f, p.lat, p.lon, 3100)
  assert.ok(near(s.cover, Math.max(a, b), 1e-5), `${s.cover} against ${a}, ${b}`)
  assert.ok(near(s.sev, b > a ? 3 : 1, 1e-6))
})

test('buildField: the heights a disc writes past its rim hardly move those of a cloud already there (a layer band weighs the write at 1/10,000)', () => {
  const a = puff(1200, 1800, { wide: 12000 }) // a radius of 4.3 km, whole to 2.4 km
  const b = puff(1900, 1990, { wide: 1000, eastKm: 3.4 }) // a one-texel disc, its rim 3.0 … 3.8 km, its write out to 1.5 km past it
  const f = buildField([a, b], LAT, LON)
  const i = Math.round(C - 0.5 + 2.2 / TEXEL_KM) // 2.2 km east: whole for a, in b\'s write
  const alone = buildField([a], LAT, LON)
  assert.equal(f.cov[0][k(i, C)], 1)
  assert.ok(near(f.base[0][k(i, C)], 1200, 0.5) && near(f.top[0][k(i, C)], 1800, 0.5), `${f.base[0][k(i, C)]} to ${f.top[0][k(i, C)]}`)
  assert.ok(f.base[0][k(i, C)] !== alone.base[0][k(i, C)] || f.top[0][k(i, C)] !== alone.top[0][k(i, C)], 'and b did write there')
})

test('fieldAtlas: 3 × 2 tiles of FIELD_N², band b at column b % 3 and row ⌊b / 3⌋: R cover, G base, B top (over 16,000 m), A severity over 3', () => {
  const a = fieldAtlas(buildField([], LAT, LON))
  assert.equal(a.width, 3 * FIELD_N)
  assert.equal(a.height, 2 * FIELD_N)
  assert.ok(a.data instanceof Uint8ClampedArray && a.data.length === a.width * a.height * 4)
  assert.ok(a.data.every((v) => v === 0), 'an empty field is all zero')
  for (let band = 0; band < BANDS; band++) {
    const base = [800, 3000, 5200, 9000, 1000][band]
    const f = buildField([puff(base, base + 900, { wide: 6000, sev: 2, ...(band === TOWER_BAND ? { tower: 0 } : {}) })], LAT, LON)
    const atlas = fieldAtlas(f)
    const [tx, ty] = [(band % 3) * FIELD_N, Math.floor(band / 3) * FIELD_N]
    for (const [i, j] of [[C - 1, C - 1], [C, C - 1], [C - 1, C], [C, C]]) {
      const o = ((ty + j) * atlas.width + tx + i) * 4
      assert.equal(atlas.data[o], Math.round(f.cov[band][k(i, j)] * 255), `band ${band}: R`)
      assert.equal(atlas.data[o], 255)
      assert.equal(atlas.data[o + 1], Math.round((base / HEIGHT_MAX_M) * 255), `band ${band}: G`)
      assert.equal(atlas.data[o + 2], Math.round(((base + 900) / HEIGHT_MAX_M) * 255), `band ${band}: B`)
      assert.equal(atlas.data[o + 3], Math.round((2 / 3) * 255), `band ${band}: A`)
    }
    let marked = 0
    for (let p = 0; p < atlas.data.length; p += 4) if (atlas.data[p] > 0) marked++
    assert.equal(marked, f.cov[band].filter((v) => v >= 0.5 / 255).length, `band ${band}: nothing in the other tiles`)
    for (let y = FIELD_N; y < 2 * FIELD_N; y++) for (let x = 2 * FIELD_N; x < 3 * FIELD_N; x++) assert.equal(atlas.data[(y * atlas.width + x) * 4 + 3], 0, 'the sixth tile is empty')
  }
})

test('fieldAtlas: a texel just outside a cloud has no cover and still holds its heights and severity, so a shader\'s plain filtering finds them', () => {
  const f = buildField([puff(1200, 1800, { wide: 6250, sev: 3 })], LAT, LON)
  const atlas = fieldAtlas(f)
  // the rim is 2.25 km = 3.6 texels from the field's middle; the texel 4.5 texels east of it is outside the rim, within a texel of one that is not
  const j = C
  const px = [...atlas.data.slice((j * atlas.width + C + 4) * 4, (j * atlas.width + C + 4) * 4 + 4)]
  assert.equal(px[0], 0, 'no cover')
  assert.equal(px[1], Math.round((1200 / HEIGHT_MAX_M) * 255))
  assert.equal(px[2], Math.round((1800 / HEIGHT_MAX_M) * 255))
  assert.equal(px[3], 255)
  const far = (j * atlas.width + C + 7) * 4
  assert.deepEqual([...atlas.data.slice(far, far + 4)], [0, 0, 0, 0], 'farther out: nothing')
})

test('fieldAtlas: a texel with no cloud is all zero, and one with some keeps its severity and heights unpremultiplied', () => {
  const f = buildField([puff(1200, 1800, { wide: 4000, sev: 3 })], LAT, LON)
  const atlas = fieldAtlas(f)
  assert.deepEqual([...atlas.data.slice(0, 4)], [0, 0, 0, 0], 'the corner of band 0')
  const o = (C * atlas.width + C) * 4
  assert.equal(atlas.data[o + 3], 255, 'severity 3 is a full 255, whatever the cover')
})

// ---- the towers' band --------------------------------------------------------------------------------------------------------

/** A storm over the field's middle: a tower 9 km tall from 1,000 m, 6 km wide, crowned by an anvil 18 km wide, severity 3. */
function storm(): { specs: CloudSpec[]; baseM: number; topM: number } {
  const specs: CloudSpec[] = []
  tower(specs, { ...at(0, 0), baseM: 1000, groundM: 0, heightM: 9000, widthM: 6000, anvilM: 18000, baseTint: 0.65, sev: 3, id: 0 }, sequence(7))
  return { specs, baseM: 1000, topM: 10000 }
}
const kmFrom = (p: { lat: number; lon: number }, q: { lat: number; lon: number }): number =>
  Math.hypot((p.lon - q.lon) * KM_PER_DEG * Math.cos((LAT * Math.PI) / 180), (p.lat - q.lat) * KM_PER_DEG)

test('buildField: a spec with a tower goes in the towers\' band whatever its base; one without never does', () => {
  for (const base of [300, 1999, 3000, 6000, 9000, 12000]) {
    const f = buildField([puff(base, base + 900, { wide: 4000, tower: 0 })], LAT, LON)
    assert.ok(MIDDLE.every((i) => f.cov[TOWER_BAND][i] > 0.9), `base ${base}: in the towers' band`)
    for (let b = 0; b < TOWER_BAND; b++) assert.ok(f.cov[b].every((v) => v === 0), `base ${base}: band ${b} empty`)
    assert.deepEqual([f.lo[TOWER_BAND], f.hi[TOWER_BAND]], [base, base + 900])
    const plain = buildField([puff(base, base + 900, { wide: 4000 })], LAT, LON)
    assert.ok(plain.cov[TOWER_BAND].every((v) => v === 0) && plain.lo[TOWER_BAND] > plain.hi[TOWER_BAND], `base ${base}: a plain puff leaves the towers' band empty`)
  }
})

test('buildField: in the towers\' band the puffs of a tower are one body: the lowest base, the highest top, cover joined, severity the weights\' average', () => {
  const [a, b, c] = [puff(1000, 4500, { tower: 3, sev: 2, wide: 6000 }), puff(4250, 7750, { tower: 3, sev: 3, wide: 6000 }), puff(7500, 11000, { tower: 3, sev: 3, wide: 6000 })]
  const f = buildField([a, b, c], LAT, LON)
  for (const i of MIDDLE) {
    assert.ok(f.cov[TOWER_BAND][i] > 0.99)
    assert.ok(near(f.base[TOWER_BAND][i], 1000, 1e-2) && near(f.top[TOWER_BAND][i], 11000, 1e-2), `${f.base[TOWER_BAND][i]} to ${f.top[TOWER_BAND][i]}`)
    assert.ok(near(f.sev[TOWER_BAND][i], (2 + 3 + 3) / 3, 1e-5))
  }
  assert.deepEqual([f.lo[TOWER_BAND], f.hi[TOWER_BAND]], [1000, 11000])
  // where only the tallest reaches (beside the others), the body is its own
  const wide = buildField([a, puff(7500, 11000, { tower: 3, sev: 3, wide: 12000 })], LAT, LON)
  const i = k(C - 1 + 6, C - 1) // 3.4 km east: past the narrow one\'s rim and its edge (2.2 and 3.0 km), inside the wide one\'s rim (4.3 km)
  assert.ok(wide.cov[TOWER_BAND][i] > 0.3 && near(wide.base[TOWER_BAND][i], 7500, 1e-2) && near(wide.top[TOWER_BAND][i], 11000, 1e-2), `${wide.cov[TOWER_BAND][i]}: ${wide.base[TOWER_BAND][i]} to ${wide.top[TOWER_BAND][i]}`)
  // the layer bands still average
  const [x, y] = [puff(1200, 1800), puff(1400, 2000)]
  const g = buildField([x, y, puff(0, 20000, { tower: 1, wide: 1000 })], LAT, LON)
  assert.ok(near(g.base[0][MIDDLE[0]], 1300, 1e-2) && near(g.top[0][MIDDLE[0]], 1900, 1e-2), 'a tower does not enter the layer bands\' averages')
})

test('sampleField: a storm tower with an anvil is one body: up its axis, from over its base to under its top, there is always cover, at its core severity', () => {
  const { specs, baseM, topM } = storm()
  const f = buildField(specs, LAT, LON)
  const axis = at(0, 0)
  const seen: string[] = []
  // the base rises over 300 m and the top is rounded over its last 900 m (profile): these are the body between
  for (let alt = baseM + 300; alt <= topM - 500; alt += 250) {
    const s = sampleField(f, axis.lat, axis.lon, alt)
    seen.push(`${alt}:${s.cover.toFixed(2)}`)
    assert.ok(s.cover >= 0.5, `the axis at ${alt} m: ${s.cover}`)
    assert.ok(near(s.sev, 3, 1e-5), `severity ${s.sev}`)
  }
  assert.ok(seen.length >= 30, `${seen.length} heights`)
  assert.equal(sampleField(f, axis.lat, axis.lon, baseM - 100).cover, 0, 'under it')
  assert.equal(sampleField(f, axis.lat, axis.lon, topM + 100).cover, 0, 'over it')
  // a column off the axis, at the column\'s edge, is the same body
  const side = at(1.5, 1.0)
  assert.ok(sampleField(f, side.lat, side.lon, 5000).cover > 0.5, 'round the axis')
})

test('sampleField: under the anvil, outside the column, there is cover only at the anvil\'s heights', () => {
  const { specs, baseM } = storm()
  const f = buildField(specs, LAT, LON)
  const anvil = specs.filter((c) => c.scale[1] < c.scale[0] / 3)
  assert.equal(anvil.length, 3)
  const out = anvil.reduce((a, c) => (kmFrom(c, at(0, 0)) > kmFrom(a, at(0, 0)) ? c : a))
  assert.ok(kmFrom(out, at(0, 0)) > 5.5, `${kmFrom(out, at(0, 0))} km from the axis: beyond the column\'s reach`)
  const [lo, hi] = [out.heightM - (PUFF_FILL * out.scale[1]) / 2, out.heightM + (PUFF_FILL * out.scale[1]) / 2]
  const mid = sampleField(f, out.lat, out.lon, (lo + hi) / 2)
  assert.ok(mid.cover > 0.5 && near(mid.sev, 3, 1e-5), `at the anvil\'s own height: ${mid.cover}`)
  for (const alt of [baseM + 500, 3000, 5000, 7000, lo - 600]) assert.equal(sampleField(f, out.lat, out.lon, alt).cover, 0, `under the anvil at ${alt} m`)
  assert.equal(sampleField(f, out.lat, out.lon, hi + 300).cover, 0, 'over it')
})

test('sampleField: the highest cover of five bands: a storm over low cumulus gives each its own severity at its own height', () => {
  const { specs } = storm()
  const f = buildField([...specs, puff(1200, 1800, { wide: 5000, eastKm: 8, northKm: 0, sev: 0 })], LAT, LON)
  const cu = at(8, 0)
  const low = sampleField(f, cu.lat, cu.lon, 1450)
  assert.ok(low.cover > 0.9 && low.sev === 0, 'the cumulus, severity 0')
  const core = sampleField(f, at(0, 0).lat, at(0, 0).lon, 5000)
  assert.ok(core.cover > 0.5 && near(core.sev, 3, 1e-5))
})

test('coverAt: the answer sampleField gives, written into the caller\'s object (which is returned) at every place and height of a mixed sky, and every stale value cleared where there is no cover', () => {
  const { specs } = storm()
  const f = buildField([...specs, puff(1200, 1800, { wide: 5000, eastKm: 8 }), puff(5000, 7000, { wide: 9000, eastKm: -20, northKm: 15, sev: 1 })], LAT, LON)
  const out = { cover: 0.5, sev: 2 }
  let hits = 0
  for (const [e, n] of [[0, 0], [8, 0], [-20, 15], [2.7, -1.9], [-9.3, 6.1], [60, 60], [-159.9, 0], [0, 159.9], [170, 0], [0, -170]]) {
    for (const alt of [0, 700, 1450, 3000, 5000, 6500, 9000, 10500, 20000]) {
      const p = at(e, n)
      const want = sampleField(f, p.lat, p.lon, alt)
      out.cover = 0.7 // stale
      out.sev = 3
      assert.equal(coverAt(f, p.lat, p.lon, alt, out), out, 'the caller\'s own object')
      assert.deepEqual(out, want, `${e}, ${n} at ${alt} m`)
      if (want.cover > 0) hits++
    }
  }
  assert.ok(hits > 10, `the sweep reaches cloud: ${hits} hits`)
  const stale = (): { cover: number; sev: number } => ({ cover: 0.7, sev: 3 })
  assert.deepEqual(coverAt(null, LAT, LON, 1000, stale()), { cover: 0, sev: 0 }, 'no field')
  assert.deepEqual(coverAt(buildField([], LAT, LON), LAT, LON, 1000, stale()), { cover: 0, sev: 0 }, 'an empty one')
  assert.deepEqual(coverAt(f, LAT + 3, LON, 1450, stale()), { cover: 0, sev: 0 }, 'outside the square')
  assert.deepEqual(coverAt(f, LAT, LON, 20000, stale()), { cover: 0, sev: 0 }, 'a height no band reaches')
  assert.notEqual(sampleField(f, LAT, LON, 5000), sampleField(f, LAT, LON, 5000), 'sampleField still gives an object of its own each time')
})
