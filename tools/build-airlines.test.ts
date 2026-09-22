// tools/build-airlines.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIRLINES_DAT, buildAirlines, formatAirlines, main } from './build-airlines.ts'

// Real OpenFlights airlines.dat rows (copied 2026-09-22), reordered so the Swiss duplicate comes higher id first.
// Columns: id, name, alias, IATA, ICAO, callsign, country, active; \N = null.
const DAT = String.raw`-1,"Unknown",\N,"-","N/A",\N,\N,"Y"
39,"Aban Air",\N,"K5","ABE","ABAN","Iran","n"
1044,"Aerobusinessservice",\N,"","LSM","","Russia","N"
1326,"Tyrolean Airways",\N,"VO","TYR","TYROLEAN","Austria","Y"
2150,"El Al Israel Airlines",\N,"LY","ELY","ELAL","Israel","Y"
2183,"Emirates","Emirates Airlines","EK","UAE","EMIRATES","United Arab Emirates","Y"
4560,"Swissair",\N,"SR","SWR","Swissair","Switzerland","Y"
4559,"Swiss International Air Lines","Swiss Airlines","LX","SWR","SWISS","Switzerland","Y"
5533,"Tyrolean Airways",\N,\N,"TYR","TYROLEAN",\N,"Y"
5559,"Maldivian Air Taxi",\N,"8Q",\N,\N,"Maldives","Y"
13394,"Jayrow","","\\'","\\'\\","","Australia","Y"
19548,"Yeti Airlines ","","","NYT","","Nepal","Y"
`

const EXPECTED = {
  ELY: 'El Al Israel Airlines',
  NYT: 'Yeti Airlines',
  SWR: 'Swiss International Air Lines',
  TYR: 'Tyrolean Airways',
  UAE: 'Emirates',
}

test('buildAirlines: active rows with a 3-letter ICAO code only, names trimmed', () => {
  assert.deepEqual(buildAirlines(DAT), EXPECTED)
})

test('buildAirlines: keys come back sorted', () => {
  assert.deepEqual(Object.keys(buildAirlines(DAT)), ['ELY', 'NYT', 'SWR', 'TYR', 'UAE'])
})

test('buildAirlines: a code on several active rows goes to the lowest OpenFlights id, whatever the row order', () => {
  const lines = DAT.trim().split('\n')
  assert.equal(buildAirlines(lines.reverse().join('\n')).SWR, 'Swiss International Air Lines')
  assert.equal(buildAirlines(lines.filter((l) => !l.startsWith('4559,')).join('\n')).SWR, 'Swissair')
})

test('buildAirlines: defunct (N), lower-case n, N/A, \\N and junk codes are dropped', () => {
  const names = buildAirlines(DAT)
  for (const code of ['ABE', 'LSM', 'N/A', '\\N', String.raw`\\'\\`]) assert.equal(Object.hasOwn(names, code), false, code)
})

test('buildAirlines: no data rows → empty map', () => {
  assert.deepEqual(buildAirlines(''), {})
})

test('formatAirlines: one entry per line, valid JSON, trailing newline', () => {
  const text = formatAirlines({ ELY: 'El Al Israel Airlines', SCW: 'Malmö Aviation' })
  assert.equal(text, '{\n"ELY":"El Al Israel Airlines",\n"SCW":"Malmö Aviation"\n}\n')
  assert.deepEqual(JSON.parse(text), { ELY: 'El Al Israel Airlines', SCW: 'Malmö Aviation' })
})

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fh-airlines-'))
}

test('main: downloads airlines.dat once into the cache and writes the JSON', async () => {
  const dir = tmp()
  try {
    const urls: string[] = []
    const fetchFn = (async (url: string) => {
      urls.push(url)
      return new Response(DAT)
    }) as unknown as typeof fetch
    const out = join(dir, 'out', 'airlines.json')
    const cache = join(dir, 'cache')
    const names = await main(['--out', out, '--cache', cache], fetchFn)
    assert.deepEqual(names, EXPECTED)
    assert.deepEqual(urls, [AIRLINES_DAT])
    assert.equal(readFileSync(out, 'utf8'), formatAirlines(EXPECTED))
    assert.equal(readFileSync(join(cache, 'airlines.dat'), 'utf8'), DAT)

    const offline = (async () => {
      throw new Error('network used')
    }) as unknown as typeof fetch
    assert.deepEqual(await main(['--out', out, '--cache', cache], offline), EXPECTED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('main: HTTP error or an empty result throws and writes nothing', async () => {
  const dir = tmp()
  try {
    const out = join(dir, 'airlines.json')
    const notFound = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await assert.rejects(main(['--out', out, '--cache', join(dir, 'c1')], notFound), /HTTP 404/)
    const html = (async () => new Response('<html>rate limited</html>')) as unknown as typeof fetch
    await assert.rejects(main(['--out', out, '--cache', join(dir, 'c2')], html), /no airlines/)
    assert.equal(existsSync(out), false)
    assert.equal(existsSync(join(dir, 'c2', 'airlines.dat')), false, 'a bad download is not cached')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
