// client/scene/traffic.ts
// Chase traffic (.planning/chase-traffic-design.md): the other aircraft within RANGE_NM of the chased one as 3-D models
// (the one GLB, sized by ADS-B emitter category), each framed on screen by two corner brackets whose square is also
// its click target.
import { Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import { targetAttitude } from '../track/attitude.ts'
import type { FleetEntry, ModelManifestEntry } from '../types.ts'

export const RANGE_NM = 10
export const MAX_MODELS = 30
export const MIN_PX = 24 // a far model keeps this size on screen (Model.minimumPixelSize), and so does its square
const KT = 1852 / 3600
const FPM = 0.3048 / 60
const SLOW_KT = 40 // slower than this a vertical rate says little about pitch (a helicopter, a hover): level
/** Length factor per ADS-B emitter category on the one model (37.6 m long: a large airliner). */
const SCALE: Record<string, number> = { A1: 0.35, A2: 0.6, A3: 1, A4: 1.2, A5: 1.8, A7: 0.4 }

export const scaleFor = (category: string | null | undefined): number => (category ? SCALE[category] : undefined) ?? 1

export interface Near { e: FleetEntry; nm: number }

/** The entries within rangeNm of (lat, lon), except skipHex and stale ones, nearest first. */
export function nearestInRange(entries: readonly FleetEntry[], skipHex: string | null, lat: number, lon: number, rangeNm: number): Near[] {
  const dLat = rangeNm / 60 // a nautical mile is a minute of latitude: a cheap reject before the great-circle distance
  const out: Near[] = []
  for (const e of entries) {
    if (e.hex === skipHex || e.ageS > e.staleS || Math.abs(e.lat - lat) > dLat) continue
    const nm = distanceNm(lat, lon, e.lat, e.lon)
    if (nm <= rangeNm) out.push({ e, nm })
  }
  return out.sort((a, b) => a.nm - b.nm)
}

/** Side of the on-screen square around a sphere of radius rM at depthM along the view, in CSS px: its projected diameter, ≥ MIN_PX, ≤ 4 screens. */
export function squarePx(rM: number, depthM: number, fovyRad: number, viewHeightPx: number): number {
  const px = (rM * viewHeightPx) / (depthM * Math.tan(fovyRad / 2))
  return Math.min(Math.max(px, MIN_PX), 4 * viewHeightPx)
}

/** A bracket square: centre (CSS px from the canvas's top-left), side, and depth along the view (m). */
export interface Box { hex: string; x: number; y: number; side: number; depthM: number }

/** The hex whose square (of the first n boxes) holds (x, y); the nearest to the camera when squares overlap; else null. */
export function hitAt(boxes: readonly Box[], n: number, x: number, y: number): string | null {
  let best: Box | null = null
  for (let i = 0; i < n; i++) {
    const b = boxes[i]
    const h = b.side / 2
    if (Math.abs(x - b.x) <= h && Math.abs(y - b.y) <= h && (best === null || b.depthM < best.depthM)) best = b
  }
  return best === null ? null : best.hex
}

/**
 * Cesium HeadingPitchRoll of a traffic aircraft on model m: the nose along its track (headingDeg when it has none),
 * pitch from its climb (targetAttitude: flight-path angle + AoA), wings level (the fleet keeps only the newest sample,
 * so no turn rate). ponytail: roll 0; upgrade: the track change between samples, as the chased Track does.
 */
export function trafficHpr(e: FleetEntry, m: ModelManifestEntry, headingDeg: number, out: HeadingPitchRoll): HeadingPitchRoll {
  const gs = e.gsKt ?? 0
  const att = targetAttitude({
    gsMs: gs * KT, vsMs: gs >= SLOW_KT ? (e.vsFpm ?? 0) * FPM : 0, headingDeg: e.trackDeg ?? headingDeg,
    broadcastRollDeg: 0, turnRateDegS: 0, onGround: e.onGround, phase: null, mlat: false,
  })
  const fix = m.forwardAxisFix
  out.heading = CesiumMath.toRadians(att.headingDeg + fix.headingDeg)
  out.pitch = CesiumMath.toRadians(att.pitchDeg + fix.pitchDeg)
  out.roll = CesiumMath.toRadians(fix.rollDeg)
  return out
}

const lift = new Cartesian3()

/** World matrix of a traffic model: wheels at pos (the origin k × gearHeightM above, along body up), attitude hpr, k × m.scale. */
export function trafficMatrix(pos: Cartesian3, hpr: HeadingPitchRoll, m: ModelManifestEntry, k: number, out: Matrix4): Matrix4 {
  Transforms.headingPitchRollToFixedFrame(pos, hpr, undefined, undefined, out)
  Matrix4.multiplyByTranslation(out, Cartesian3.fromElements(0, 0, m.gearHeightM * k, lift), out)
  return Matrix4.multiplyByUniformScale(out, m.scale * k, out)
}
