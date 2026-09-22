/**
 * Airport data built by tools/build-airports.ts from OurAirports (public domain) + EGM96.
 * Heights named *HaeM are WGS84 ellipsoidal metres; *Ft are MSL feet as published.
 */
export interface RunwayEnd {
  ident: string
  lat: number            // physical runway end (OurAirports le_/he_ lat/lon)
  lon: number
  thrLat: number         // landing threshold: end moved along hdgTrueDeg by displacedFt
  thrLon: number
  displacedFt: number
  elevFt: number         // end elevation MSL ft; airport elevation when OurAirports leaves it blank
  hdgTrueDeg: number     // landing direction, true
  thrHaeM: number        // elevFt * 0.3048 + geoidN(thrLat, thrLon)
}

export interface Runway {
  lengthFt: number
  widthFt: number
  surface: string
  ends: [RunwayEnd, RunwayEnd]
}

export interface Airport {
  ident: string
  name: string
  lat: number
  lon: number
  elevFt: number
  nM: number
  runways: Runway[]
}
