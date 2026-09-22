/** ENU kinematic point: t in seconds, e/n in metres, ve/vn in m/s. The origin is chosen by Track. */
export interface KinPoint {
  t: number
  e: number
  n: number
  ve: number
  vn: number
}

/** ENU position at time t (seconds). */
export interface PosT {
  t: number
  e: number
  n: number
}

/** Aircraft attitude. headingDeg true; pitch nose-up positive; roll right-wing-down positive. */
export interface Att {
  headingDeg: number
  pitchDeg: number
  rollDeg: number
}

export type Phase = 'ground' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'approach' | 'landing'

export type AltSource = 'geom' | 'baro-qnh' | 'baro-bias'
