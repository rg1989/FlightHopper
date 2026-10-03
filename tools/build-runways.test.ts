// tools/build-runways.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRunways } from './build-runways.ts'

const AIRPORTS = `ident,type,name,elevation_ft
CYSJ,medium_airport,Saint John Airport,357
KSFO,large_airport,San Francisco International Airport,13
XHEL,heliport,A Hospital,100
XCLD,closed,An Old Field,50
XSEA,seaplane_base,A Lake,
`
const RUNWAYS = `airport_ident,closed,le_ident,le_latitude_deg,le_longitude_deg,le_elevation_ft,le_displaced_threshold_ft,he_ident,he_latitude_deg,he_longitude_deg,he_elevation_ft,he_displaced_threshold_ft
CYSJ,0,05,45.309101,-65.899597,352,,23,45.320801,-65.878098,,
CYSJ,0,14,45.322498,-65.901802,356,,32,45.309898,-65.877602,341,250
CYSJ,1,09,45.31,-65.9,,,27,45.31,-65.88,,
KSFO,0,10L,37.628700256347656,-122.39299774169922,5,,28R,37.613498687744141,-122.35700225830078,13,300
KSFO,0,01X,37.6,-122.38,,,19X,,,,
XHEL,0,H1,45.1,-65.1,,,H1,45.1,-65.1,,
XCLD,0,01,45.2,-65.2,,,19,45.21,-65.2,,
XSEA,0,N,45.4,-65.4,,,S,45.39,-65.4,,
XSEA,0,E,45.4,-65.4,,,W,45.4001,-65.4001,,
NOPE,0,01,1,1,,,19,1.01,1,,
`

test('buildRunways: every open runway of an airport or seaplane base with both ends placed 300 m apart; an end with no elevation takes its airport\'s', () => {
  const t = buildRunways(AIRPORTS, RUNWAYS)
  assert.deepEqual(t.airports, [['CYSJ', 'Saint John Airport'], ['KSFO', 'San Francisco International Airport'], ['XSEA', 'A Lake']])
  assert.deepEqual(t.runways, [
    [0, '05', 45.3091, -65.8996, 352, 0, '23', 45.3208, -65.8781, 357, 0],
    [0, '14', 45.3225, -65.9018, 356, 0, '32', 45.3099, -65.8776, 341, 250],
    [1, '10L', 37.6287, -122.393, 5, 0, '28R', 37.6135, -122.357, 13, 300],
    [2, 'N', 45.4, -65.4, 0, 0, 'S', 45.39, -65.4, 0, 0],
  ])
})
