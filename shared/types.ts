export type SourceKind = 'adsblol' | 'readsb' | 'replay'
export type Quality = 'adsb2' | 'adsb01' | 'mlat' | 'other'

/** Subset of one readsb / adsb.lol v2 aircraft object that we read. Field names are readsb's. */
export interface ReadsbAircraft {
  hex: string
  type?: string
  flight?: string
  r?: string
  t?: string
  dbFlags?: number
  alt_baro?: number | 'ground'
  alt_geom?: number
  gs?: number
  track?: number
  true_heading?: number
  roll?: number
  baro_rate?: number
  geom_rate?: number
  nav_qnh?: number
  lat?: number
  lon?: number
  nic?: number
  nac_p?: number
  version?: number
  seen_pos?: number
  seen?: number
  mlat?: string[]
  tisb?: string[]
  // Detail-panel fields (read only for the selected aircraft and the table; all optional, as upstream omits unknowns)
  squawk?: string
  category?: string
  emergency?: string
  ias?: number
  tas?: number
  mach?: number
  track_rate?: number
  mag_heading?: number
  nav_altitude_mcp?: number
  nav_altitude_fms?: number
  nav_heading?: number
  nav_modes?: string[]
  wd?: number
  ws?: number
  oat?: number
  tat?: number
  rssi?: number
  messages?: number
  nac_v?: number
  nic_baro?: number
  sil?: number
  sda?: number
  gva?: number
  rc?: number
}

/** Source-agnostic envelope. nowMs is the UPSTREAM clock in ms. */
export interface Snapshot {
  nowMs: number
  aircraft: ReadsbAircraft[]
}

/** One deduped position sample. tMs and rxMs are SERVER clock ms. ADS-B native units (ft, kt, fpm, deg). */
export interface Sample {
  hex: string
  tMs: number
  rxMs: number
  lat: number
  lon: number
  onGround: boolean
  altBaroFt: number | null
  altGeomFt: number | null
  gsKt: number | null
  trackDeg: number | null
  trueHeadingDeg: number | null
  rollDeg: number | null
  baroRateFpm: number | null
  geomRateFpm: number | null
  navQnhHpa: number | null
  version: number | null
  nic: number | null
  quality: Quality
  nM: number
  callsign: string | null
  typeCode: string | null
  reg: string | null
}
