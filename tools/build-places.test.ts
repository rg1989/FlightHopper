// tools/build-places.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPlaces, weightedQuantile } from './build-places.ts'

const AIRPORTS = `"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"
1,"KLAX","large_airport","Los Angeles International Airport",33.942501,-118.407997,125,"NA","US","US-CA","Los Angeles","yes","KLAX","LAX",,,,,
2,"00A","heliport","Total RF Heliport",40.07,-74.93,11,"NA","US","US-PA","Bensalem","no",,,,,,,
3,"KSMO","medium_airport","Santa Monica",34.01,-118.45,177,"NA","US","US-CA","Santa Monica","no","KSMO","SMO",,,,,
4,"PHNL","large_airport","Daniel K Inouye International Airport",21.318,-157.922,13,"OC","US","US-HI","Honolulu","yes","PHNL","HNL",,,,,
5,"NZCH","large_airport","Christchurch International Airport",-43.489,172.532,123,"OC","AQ","NZ-CAN","Christchurch","yes","","CHC",,,,,`
const COUNTRIES = `"id","code","name","continent","wikipedia_link","keywords"
1,"US","United States","NA","","American airports"
2,"AE","United Arab Emirates","AS","","UAE,مطارات"
3,"AQ","Antarctica","AN","",""
4,"ZZ","Nowhere","AN","",""
5,"ES","Spain","EU","","Aeropuertos de España,Espana"`
const city = (id: number, name: string, lat: number, lon: number, cc: string, a1: string, pop: number): string =>
  [id, name, name, '', lat, lon, 'P', 'PPL', cc, '', a1, '', '', '', pop, '', '', '', ''].join('\t')
const CITIES = [
  city(1, 'Los Angeles', 34.05223, -118.24368, 'US', 'CA', 3_898_747),
  city(2, 'New York City', 40.71427, -74.00597, 'US', 'NY', 8_804_190),
  city(3, 'Honolulu', 21.30694, -157.85833, 'US', 'HI', 350_964),
  city(4, 'Dubai', 25.07725, 55.30927, 'AE', '03', 3_478_300),
  city(5, 'Madrid', 40.4165, -3.70256, 'ES', '29', 3_255_944),
  city(6, 'Las Palmas', 28.09973, -15.41343, 'ES', '53', 378_517),
  city(7, 'Faraway', 10, 10, 'ES', '', 15_000),
  'short\tline',
].join('\n')
const ADMIN1 = 'US.CA\tCalifornia\tCalifornia\t1\nUS.NY\tNew York\tNew York\t2\nUS.HI\tHawaii\tHawaii\t3\n'

test('buildPlaces: scheduled airports only, ICAO first, biggest first', () => {
  const p = buildPlaces(AIRPORTS, COUNTRIES, CITIES, ADMIN1)
  assert.deepEqual(p.airports.map((a) => a[0]), ['KLAX', 'PHNL', 'NZCH'])
  assert.deepEqual(p.airports[0], ['KLAX', 'LAX', 'Los Angeles International Airport', 'Los Angeles', 'US', 33.943, -118.408, 3])
})

test('buildPlaces: cities biggest first, with their region; bad rows skipped', () => {
  const p = buildPlaces(AIRPORTS, COUNTRIES, CITIES, ADMIN1)
  assert.deepEqual(p.cities.map((c) => c[0]), ['New York City', 'Los Angeles', 'Dubai', 'Madrid', 'Las Palmas', 'Honolulu', 'Faraway'])
  const la = p.cities[1]!
  assert.equal(p.regions[la[2]], 'California')
  assert.equal(p.cities[2]![2], -1) // AE.03 is not in the admin1 list
})

test('buildPlaces: a country boxes most of its people, its typed names kept, its other keywords dropped', () => {
  const p = buildPlaces(AIRPORTS, COUNTRIES, CITIES, ADMIN1)
  // Las Palmas holds 10 % of these people: in the box; Faraway 0.4 %: out.
  const es = p.countries.find((c) => c[0] === 'ES')!
  assert.deepEqual(es, ['ES', 'Spain', 'Espana', 28.1, 40.417, -15.413, -3.703])
  // The US: its own box (the lower 48), its typed names.
  assert.deepEqual(p.countries.find((c) => c[0] === 'US'), ['US', 'United States', 'USA,America', 24.5, 49.4, -124.8, -66.9])
  assert.equal(p.countries.find((c) => c[0] === 'AE')![2], 'UAE')
  // No city: the airports' box. Neither: left out.
  assert.deepEqual(p.countries.find((c) => c[0] === 'AQ')!.slice(3), [-43.489, -43.489, 172.532, 172.532])
  assert.equal(p.countries.find((c) => c[0] === 'ZZ'), undefined)
})

test('weightedQuantile: the weight decides, not the count', () => {
  assert.equal(weightedQuantile([0, 10, 20], [1, 1, 98], 0.01), 0)
  assert.equal(weightedQuantile([0, 10, 20], [1, 1, 98], 0.03), 20)
  assert.equal(weightedQuantile([5], [1], 0.99), 5)
})
