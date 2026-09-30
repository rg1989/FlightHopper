/**
 * The search's places, built by tools/build-places.ts into public/search/places.json: airports from OurAirports (public
 * domain), cities and regions from GeoNames (CC BY 4.0). Compact rows, not objects: the file is ~1 MB with ~30 000 rows.
 */
export interface Places {
  /** [ISO 3166-1 alpha-2, name, other names ('' or comma-separated), south, north, west, east] (degrees). */
  countries: [iso2: string, name: string, aka: string, south: number, north: number, west: number, east: number][]
  /** [ICAO or local ident, IATA ('' when none), name, city ('' when none), iso2, lat, lon, size: 3 large, 2 medium, 1 small]. */
  airports: [ident: string, iata: string, name: string, city: string, iso2: string, lat: number, lon: number, size: 1 | 2 | 3][]
  /** Region (state, province) names; cities point into it. */
  regions: string[]
  /** [name, iso2, region index (-1: none), lat, lon, population]. */
  cities: [name: string, iso2: string, region: number, lat: number, lon: number, pop: number][]
}
