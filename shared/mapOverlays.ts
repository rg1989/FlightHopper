/**
 * The chase map's overlays, built by tools/build-map-overlays.ts into public/map/ from Natural Earth (public domain):
 * the land borders client/scene/borders.ts draws, and the country and sea names client/scene/placeLabels.ts shows.
 */

/** Integer units per degree in borders.json: 1e-4° (~11 m; the source is drawn for 1:10 M, ~1 km). */
export const BORDER_UNIT = 1e4

/** borders.json: every land border line as [lon0, lat0, dlon1, dlat1, …] in BORDER_UNITs, each point after the first a step from the one before. */
export interface BordersJson {
  lines: number[][]
}

/** countries.json: each country's name at Natural Earth's label point, with its label rank (2 the largest … 10). */
export interface CountriesJson {
  countries: [name: string, lon: number, lat: number, rank: number][]
}

/** seas.json: one label point per named ocean, sea, gulf and bay, well inside it, with Natural Earth's scalerank (0 the oceans … 9). */
export interface SeasJson {
  seas: [name: string, lon: number, lat: number, scalerank: number][]
}
