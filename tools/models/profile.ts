// tools/models/profile.ts
// Measures each painted manifest model's side geometry (client/types.ts ModelProfile) from its GLB, in the paint frame
// (client/scene/livery.ts: the primitive's POSITION, turned 180° about y when noseMinusZ; +z nose, +y up, +x left wing),
// mesh metres, rounded to 1 cm. The livery kit draws airline artwork onto it (.planning/livery-pipeline-design.md §5).
//
//   node tools/models/profile.ts               print each model's profile, one line
//   node tools/models/profile.ts --write       write each model's "profile" line into the manifest
//   node tools/models/profile.ts --png <dir>   draw each profile over the model (tools/models/render.py, python3)
//
// How, on the triangles (plane sections: the decimated tubes have few vertices):
// - The parts (vertices welded by position, then joined by triangles) that reach out past 2.5 × bodyHalfWidth (wings,
//   tailplanes, nacelles) or are long thin blades (rotor blades) are left out of the body (never the longest part: the
//   fuselage, or the whole welded airframe); so are the engines (a rear-mounted pair beside the fuselage).
// - body: a section every 0.25 m (the plane z = c) within bodyHalfWidth. Bottom: its lowest point (keel, belly fairing).
//   Top: its highest, except where a narrow blade (under 0.6 of its width and 0.5 m, not a V) at least 0.3 m tall stands on it (the
//   fin, an antenna, a rotor mast): there, where the section going down widens past that narrow part's width (0.06 m
//   within 0.3 m, and twice as wide within 0.6 m more). The same rule upside down (0.25 m tall, 0.2 m wide) keeps belly
//   antennas out of the bottom. The body ends where only a fin is left. No blades in the nose's 12 % (a pointed top).
// - fin: horizontal slices of the aft half above the body top (|x| < 0.7 m), from the tip down: its leading edge is the
//   most forward point, its trailing edge the aftmost; the outline runs up the leading edge (along the body top where
//   the root slopes), along the tip, down the trailing edge and back along the body top. finRoot/finTip: lines fitted to
//   the edges between 30 % and 85 % of the fin's height (above a dorsal fillet), taken down to the body top and up to
//   the fin's top (the kit interpolates along them).
// - wing: the root chord from the longest part in sections 0.6 m and 1.2 m outboard of bodyHalfWidth, extended in to
//   it; the tip, the outermost vertex at the wing's own level (its upper surface, fitted outboard of the engines); the
//   device: whole triangles near the tip reaching above (or well below) that level.
// - engines: every left nacelle and its pylon (engineParts); stab: the flat parts by the fin reaching out past it.
// - doors (left passenger doors) and cockpit (the aft edge of the cockpit side windows): published stations (DOCS)
//   scaled to the mesh's length. The meshes model neither reliably, and their COLOR_0 is a shade from the normals
//   (0.55…1), not dark at the windows.
// - A helicopter (ROTOR): its rotor (above the cabin and cowling) and skids (below the cabin) are left out of the body;
//   it has no wing: its `wing` is the rotor mast's station on the body top, with no chord or span.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModelManifest, ModelManifestEntry, ModelProfile, Paint } from '../../client/types.ts'
import { MANIFEST, loadBody, type Mesh } from './light-anchors.ts'

type Seg = number[] // flat [u0, v0, u1, v1, …]

/** e's mesh in the paint frame: loadBody's body frame (nose +X, left +Y, up +Z) read as (Y, Z, X). */
export function paintMesh(e: ModelManifestEntry): Mesh {
  const b = loadBody(e)
  const p = new Float64Array(b.p.length)
  for (let i = 0; i < p.length; i += 3) [p[i], p[i + 1], p[i + 2]] = [b.p[i + 1], b.p[i + 2], b.p[i]]
  return { p, tri: b.tri }
}

/** Each triangle's part: vertices welded by position (1 mm), then joined through shared triangles (union-find). */
export function parts(m: Mesh): Int32Array {
  const key = new Map<string, number>()
  const id = new Int32Array(m.p.length / 3)
  for (let i = 0; i < id.length; i++) {
    const k = `${Math.round(m.p[3 * i] * 1000)},${Math.round(m.p[3 * i + 1] * 1000)},${Math.round(m.p[3 * i + 2] * 1000)}`
    let v = key.get(k)
    if (v === undefined) key.set(k, (v = key.size))
    id[i] = v
  }
  const up = Int32Array.from({ length: key.size }, (_, i) => i)
  const find = (a: number): number => {
    while (up[a] !== a) a = up[a] = up[up[a]]
    return a
  }
  for (let t = 0; t < m.tri.length; t += 3) {
    const a = find(id[m.tri[t]])
    for (const k of [1, 2]) {
      const b = find(id[m.tri[t + k]])
      if (b !== a) up[b] = a
    }
  }
  return Int32Array.from({ length: m.tri.length / 3 }, (_, t) => find(id[m.tri[3 * t]]))
}

/** Per part: its bounding box [xMin, xMax, yMin, yMax, zMin, zMax] and triangle count. */
export function partBoxes(m: Mesh, part: Int32Array): Map<number, { box: number[]; n: number }> {
  const out = new Map<number, { box: number[]; n: number }>()
  for (let t = 0; t < part.length; t++) {
    let b = out.get(part[t])
    if (b === undefined) out.set(part[t], (b = { box: [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity], n: 0 }))
    b.n++
    for (let k = 0; k < 3; k++) {
      const i = 3 * m.tri[3 * t + k]
      for (let a = 0; a < 3; a++) {
        b.box[2 * a] = Math.min(b.box[2 * a], m.p[i + a])
        b.box[2 * a + 1] = Math.max(b.box[2 * a + 1], m.p[i + a])
      }
    }
  }
  return out
}

const OTHER: Record<number, [number, number]> = { 0: [2, 1], 1: [0, 2], 2: [0, 1] } // x → (z, y), y → (x, z), z → (x, y)

/** Where the kept triangles cross the plane (coordinate axis) = c: segments in the other two axes (OTHER). */
export function section(m: Mesh, axis: 0 | 1 | 2, c: number, keep?: (t: number) => boolean): Seg {
  const [ua, va] = OTHER[axis]
  const out: Seg = []
  const { p, tri } = m
  for (let t = 0; t < tri.length / 3; t++) {
    if (keep && !keep(t)) continue
    const i = [3 * tri[3 * t], 3 * tri[3 * t + 1], 3 * tri[3 * t + 2]]
    const d = i.map((k) => p[k + axis] - c)
    if ((d[0] < 0 && d[1] < 0 && d[2] < 0) || (d[0] >= 0 && d[1] >= 0 && d[2] >= 0)) continue
    const hit: number[] = []
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      if (d[a] < 0 === d[b] < 0) continue
      const s = d[a] / (d[a] - d[b])
      hit.push(p[i[a] + ua] + s * (p[i[b] + ua] - p[i[a] + ua]), p[i[a] + va] + s * (p[i[b] + va] - p[i[a] + va]))
    }
    if (hit.length === 4) out.push(...hit)
  }
  return out
}

/** section(m, 0, x) grouped by part: each part's crossing points, [z, y]. */
function sectionByPart(m: Mesh, part: Int32Array, x: number): Map<number, Array<[number, number]>> {
  const out = new Map<number, Array<[number, number]>>()
  for (let t = 0; t < part.length; t++) {
    const s = section({ p: m.p, tri: m.tri.subarray(3 * t, 3 * t + 3) }, 0, x)
    if (s.length === 0) continue
    let q = out.get(part[t])
    if (q === undefined) out.set(part[t], (q = []))
    q.push([s[0], s[1]], [s[2], s[3]])
  }
  return out
}

const STEP = 0.01 // the width profile's vertical step, m

/** A section's half-width against height: w[i] = the largest |u| at v = vTop − i·STEP. */
function widths(s: Seg): { vTop: number; vBottom: number; w: Float64Array } {
  let [lo, hi] = [Infinity, -Infinity]
  for (let k = 1; k < s.length; k += 2) [lo, hi] = [Math.min(lo, s[k]), Math.max(hi, s[k])]
  const w = new Float64Array(Math.max(1, Math.ceil((hi - lo) / STEP) + 1))
  for (let k = 0; k < s.length; k += 4) {
    const [u0, v0, u1, v1] = [s[k], s[k + 1], s[k + 2], s[k + 3]]
    const [a, b] = [Math.ceil((hi - Math.max(v0, v1)) / STEP - 1e-9), Math.floor((hi - Math.min(v0, v1)) / STEP + 1e-9)]
    for (let i = Math.max(0, a); i <= Math.min(w.length - 1, b); i++) {
      const v = hi - i * STEP
      const u = v1 === v0 ? Math.max(Math.abs(u0), Math.abs(u1)) : Math.abs(u0 + ((v - v0) / (v1 - v0)) * (u1 - u0))
      if (u > w[i]) w[i] = u
    }
  }
  return { vTop: hi, vBottom: lo, w }
}

/**
 * How far in from the end of w a narrow blade stands on the section (a fin, a mast, an antenna): 0 unless its end part,
 * over minTall, is narrower than 0.6 of the widest and than maxHalf (a round top is not, over 0.3 m); else the first step past 0.35 m at which the
 * section is 0.06 m wider than 0.3 m before and, within 0.6 m below, twice as wide (the fuselage, not a step in the
 * fin's own skin).
 */
function bladeEnd(w: Float64Array, minTall: number, maxHalf: number): number {
  let W = 0
  for (const x of w) W = Math.max(W, x)
  let h = 0
  while (h < w.length && w[h] < Math.min(0.6 * W, maxHalf)) h++
  if (h * STEP <= minTall) return 0
  const k = Math.round(0.3 / STEP)
  const wide = (i: number): boolean => { // the fuselage right below: twice the blade's width within 0.6 m
    let most = 0
    for (let j = i; j < Math.min(w.length, i + Math.round(0.6 / STEP)); j++) most = Math.max(most, w[j])
    return most >= 2 * w[i - k]
  }
  for (let i = Math.max(h, Math.round(0.35 / STEP)); i < w.length; i++) if (w[i] > w[i - k] + 0.06 && wide(i)) return i
  return 0
}

interface Station { z: number; bottom: number; top: number; max: number; halfWidth: number; blade: boolean }

/** The fuselage section at z (see the header), or null where there is none. */
function station(m: Mesh, keep: (t: number) => boolean, z: number, hw: number, blades: boolean): Station | null {
  const all = section(m, 2, z, keep)
  const s: Seg = []
  for (let k = 0; k < all.length; k += 4) if (Math.abs(all[k]) <= 1.03 * hw && Math.abs(all[k + 2]) <= 1.03 * hw) s.push(all[k], all[k + 1], all[k + 2], all[k + 3])
  if (s.length === 0) return null
  const { vTop, vBottom, w } = widths(s)
  const W = Math.max(...w)
  const i = blades ? bladeEnd(w, 0.3, 0.5) : 0
  const j = bladeEnd(w.toReversed(), 0.25, 0.2)
  const [top, bottom] = [vTop - i * STEP, vBottom + j * STEP]
  if (W < 0.4 * hw && top - bottom > 5 * W) return null // a fin or a rudder alone, behind the tail cone
  return { z, bottom, top, max: vTop, halfWidth: W, blade: i > 0 }
}

/** y at z along a polyline of [z, y] sorted by z descending (nose first); clamped at the ends. */
function along(line: Array<[number, number]>, z: number): number {
  if (z >= line[0][0]) return line[0][1]
  for (let k = 1; k < line.length; k++) {
    const [a, b] = [line[k - 1], line[k]]
    if (z >= b[0]) return a[1] + ((z - a[0]) / (b[0] - a[0])) * (b[1] - a[1])
  }
  return line[line.length - 1][1]
}

/** Least-squares line v = a + b·u through the points. */
function fit(pts: Array<[number, number]>): (u: number) => number {
  const n = pts.length
  const mu = pts.reduce((s, q) => s + q[0], 0) / n
  const mv = pts.reduce((s, q) => s + q[1], 0) / n
  const b = pts.reduce((s, q) => s + (q[0] - mu) * (q[1] - mv), 0) / Math.max(1e-12, pts.reduce((s, q) => s + (q[0] - mu) ** 2, 0))
  return (u) => mv + b * (u - mu)
}

/** Douglas–Peucker: the polyline's points that keep it within tol. */
function simplify(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length < 3) return pts
  const [a, b] = [pts[0], pts[pts.length - 1]]
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9
  let [far, at] = [0, 0]
  for (let k = 1; k < pts.length - 1; k++) {
    const d = Math.abs((b[0] - a[0]) * (a[1] - pts[k][1]) - (a[0] - pts[k][0]) * (b[1] - a[1])) / L
    if (d > far) [far, at] = [d, k]
  }
  return far <= tol ? [a, b] : [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)]
}

/** Helicopters: no wing (see rotorWing). */
const ROTOR = new Set(['ec135'])

const cm = (x: number): number => Math.round(x * 100) / 100 + 0 // + 0: no −0 in the JSON

/**
 * Published door and cockpit stations, metres aft of the nose tip, and the length they were measured on (the
 * document's overall length): scaled onto the mesh's own length (null: read off the mesh itself). Doors: the left passenger (and service) doors' centre
 * lines, nose → tail; overwing window exits are not doors. Cockpit: the aft edge of the side windows.
 */
export const DOCS: Record<string, { lengthM: number | null; doors: number[]; cockpit: number; source: string }> = {
  // Airbus AC A320 (2025-01) §2-2 door location (PDF p.74), cockpit off the side view (PDF p.42)
  a320: { lengthM: 37.57, doors: [5.04, 29.53], cockpit: 3.26, source: 'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2025-01/AC_A320_0624.pdf' },
  // the A320neo: the A320's doors and nose (the same AC document)
  a20n: { lengthM: 37.57, doors: [5.04, 29.53], cockpit: 3.26, source: 'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2025-01/AC_A320_0624.pdf' },
  // Airbus AC A321 (2023-12) PDF p.87: L1, L2 and L3 (the emergency-exit doors either side of the wing), L4; nose as the A320
  a321: { lengthM: 44.51, doors: [5.02, 13.84, 24.79, 36.58], cockpit: 3.26, source: 'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2023-12/ac_a321_1223.pdf' },
  // the same, PDF p.89: the A321neo Airbus Cabin Flex (the Wizz Air layout): L1, L3 moved aft, L4; overwing exits instead of L2
  a21n: { lengthM: 44.51, doors: [5.04, 26.82, 36.47], cockpit: 3.26, source: 'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2023-12/ac_a321_1223.pdf' },
  // Boeing D6-58325-7 Rev C (737NG) §2.7.1, figure 2-14
  b738: { lengthM: 39.47, doors: [5.03, 31.88], cockpit: 2.92, source: 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/737NG_REV_C.pdf' },
  // Boeing D6-38A004 Rev H (737 MAX) §2.7.1: the MAX 8's doors where the 737-800's are
  b38m: { lengthM: 39.52, doors: [5.03, 31.88], cockpit: 2.92, source: 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/737MAX_RevH.pdf' },
  // Boeing 777-200LR/-300ER/F Rev G §2.7.1, figure 2-4 (the -300ER: the -300's fuselage)
  b773: { lengthM: 73.86, doors: [6.74, 17.07, 32.92, 46.46, 59.87], cockpit: 2.98, source: 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/777-200LR-300ER-F_Rev_G.pdf' },
  // Boeing 787 §2.7.1, figure 2-6 (the 787-9)
  b789: { lengthM: 62.81, doors: [6.3, 18.36, 35.43, 49.66], cockpit: 3.46, source: 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/787.pdf' },
  // Airbus AC A330 (2025-12) PDF p.119, p.60 (the -300)
  a333: { lengthM: 63.67, doors: [5.85, 17.74, 35.96, 50.96], cockpit: 3.22, source: 'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2025-12/AC_A330_20251201.pdf' },
  // Airbus AC A350 (2025-07) PDF p.108, p.50 (the -900)
  a359: { lengthM: 66.8, doors: [6.82, 18.86, 37.93, 52.55], cockpit: 3.69, source: 'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2025-07/AC_A350_20250715.pdf' },
  // Boeing 747-400 Rev F §2.7.1, figure 2-14: the main deck doors; the flight deck on the upper deck
  b744: { lengthM: 70.67, doors: [9.5, 18.8, 30.61, 40.74, 55.14], cockpit: 6.3, source: 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/747-400_Rev_F.pdf' },
  // Embraer 175 APM figure 2.3 (via NTSB docket DCA20IA014): L1 at 5.18; the aft door's front edge 23.04, its centre estimated
  e75l: { lengthM: 31.68, doors: [5.18, 23.45], cockpit: 3.26, source: 'https://data.ntsb.gov/Docket/Document/docBLOB?ID=13691419&FileExtension=pdf&FileName=DCA20IA014+Attachment+2+-+Embraer+175+Airport+Planning+Manual-Rel.pdf' },
  // Embraer 190 APM (a mirror; Embraer's link is gone) PDF p.30, p.33: the aft door's centre estimated from its front edge
  e190: { lengthM: 36.24, doors: [5.18, 28.0], cockpit: 3.26, source: 'https://s3728f283e85acd32.jimcontent.com/download/version/1613653381/module/9054823520/name/Embraer%20190%20Airport%20Planning%20Manual.pdf' },
  // Bombardier CRJ900 APM figure 4 (PDF p.38): one passenger door, off the drawing
  crj9: { lengthM: 36.24, doors: [4.71], cockpit: 3.84, source: 'https://customer.aero.bombardier.com/webd/BAG/CustSite/BRAD/RACSDocument.nsf/51aae8b2b3bfdf6685256c300045ff31/ec63f8639ff3ab9d85257c1500635bd8/$FILE/ATTQF1EY.pdf/CRJ900APMR11.pdf' },
  // ATR 72-600 fact sheet side view: the passenger door is aft on the left (the forward left door is the cargo door)
  at75: { lengthM: 27.17, doors: [19.7], cockpit: 2.6, source: 'https://skybrary.aero/sites/default/files/bookshelf/3696.pdf' },
  // a Citation II three-view (estimate, ±0.2 m); cockpit off the mesh's own windows
  c550: { lengthM: 14.39, doors: [4.5], cockpit: 3.1, source: 'https://www.the-blueprints.com/vectordrawings/show/4741/cessna_citation_ii_model_550/' },
  // lengthM null: read off the mesh's own side view (its modelled door and windows), metres aft of its nose tip
  c182: { lengthM: null, doors: [2.85], cockpit: 3.2, source: 'the mesh: the cabin door and its window' },
  ec135: { lengthM: null, doors: [1.65, 2.62], cockpit: 2.1, source: 'the mesh: the pilot door and the sliding cabin door' },
  'cesium-air': { lengthM: null, doors: [], cockpit: 2.5, source: 'estimate: 1 m behind the windscreen top (the windows are texture only)' },
}

/** A left engine's parts (ids from parts()): the nacelle (cowl, fan, cone, nozzle) and its pylon, and their box. */
export interface EngineParts {
  nacelle: number[]
  pylon: number[]
  core: number[] // the cowl's bounding box [xMin, xMax, yMin, yMax, zMin, zMax]
  box: NonNullable<ModelProfile['engines']> // nacelle and pylon x, nacelle z and y, up to the pylon's top
}

/**
 * The left engines, outboard last: each the part in the paint map's engine box (x, z) that is round in section and at
 * least half as long as wide (a cowl, not a wing panel or a propeller disc), at least half the biggest such; grown from
 * it along the nacelle: parts centred on its axis (fan, cone, nozzle) touching the group's length; then its pylon: parts
 * over the axis reaching above the cowl, alongside.
 */
export function engineParts(boxes: Map<number, { box: number[]; n: number }>, [ex0, ex1, ez0, ez1]: Paint['engines']): EngineParts[] {
  if (ex1 <= ex0) return []
  const cand = [...boxes].filter(([, { box: b }]) => b[0] >= ex0 - 0.3 && b[1] <= ex1 + 0.3 && b[4] >= ez0 - 1 && b[5] <= ez1 + 1)
  const vol = (b: number[]): number => (b[1] - b[0]) * (b[3] - b[2]) * (b[5] - b[4])
  const pod = (b: number[]): boolean => {
    const [w, h, l] = [b[1] - b[0], b[3] - b[2], b[5] - b[4]]
    return Math.min(w, h) >= 0.5 * Math.max(w, h) && l >= 0.5 * Math.max(w, h)
  }
  const pods = cand.filter(([, c]) => pod(c.box)).sort((a, b) => vol(b[1].box) - vol(a[1].box))
  const out: EngineParts[] = []
  const taken = new Set<number>()
  for (const [coreId, { box: core }] of pods) {
    if (taken.has(coreId) || vol(core) < 0.5 * vol(pods[0][1].box)) continue
    const [ax, ay, r] = [(core[0] + core[1]) / 2, (core[2] + core[3]) / 2, (core[1] - core[0]) / 2]
    const onAxis = (b: number[]): boolean => Math.abs((b[0] + b[1]) / 2 - ax) < 0.5 * r && b[0] >= core[0] - 0.3 && b[1] <= core[1] + 0.3
    const pool = cand.filter(([k, { box: b }]) => !taken.has(k) && onAxis(b) && Math.abs((b[2] + b[3]) / 2 - ay) < 0.5 * r && b[2] >= core[2] - 0.3)
    const nac = new Map<number, number[]>([[coreId, core]])
    for (let grew = true; grew;) {
      grew = false
      const [z0, z1] = [Math.min(...[...nac.values()].map((b) => b[4])), Math.max(...[...nac.values()].map((b) => b[5]))]
      for (const [k, { box: b }] of pool) if (!nac.has(k) && b[5] >= z0 - 0.3 && b[4] <= z1 + 0.3) [grew] = [true, nac.set(k, b)]
    }
    const nb = [...nac.values()]
    const [z0, z1] = [Math.min(...nb.map((b) => b[4])), Math.max(...nb.map((b) => b[5]))]
    const pylon = new Map(cand.filter(([k, { box: b }]) => !nac.has(k) && !taken.has(k) && onAxis(b) && b[3] > core[3] + 0.05 && b[3] < core[3] + 1.5 && b[5] >= z0 && b[4] <= z1).map(([k, { box }]) => [k, box]))
    for (const k of [...nac.keys(), ...pylon.keys()]) taken.add(k)
    const all = [...nb, ...pylon.values()]
    out.push({
      nacelle: [...nac.keys()], pylon: [...pylon.keys()], core,
      box: [
        Math.min(...all.map((b) => b[0])), Math.max(...all.map((b) => b[1])), Math.min(...nb.map((b) => b[4])),
        Math.max(...nb.map((b) => b[5])), Math.min(...nb.map((b) => b[2])), Math.max(...all.map((b) => b[3])),
      ].map(cm) as EngineParts['box'],
    })
  }
  return out.sort((a, b) => a.core[0] - b.core[0])
}

/** Everything but the documents: the measured part of e's profile, plus what the PNG overlay draws. */
export interface Measured {
  profile: ModelProfile
  stabY: number | null // the tailplane's mean height (the overlay draws it)
  wingPlane: (x: number) => number // the wing's upper surface outboard of the engines
}

/** e's profile, measured on its paint-frame mesh m. */
export function profileOf(e: ModelManifestEntry, m: Mesh = paintMesh(e)): Measured {
  const P = e.paint
  if (P === undefined) throw new Error(`${e.id}: no paint map (its fuselage width and fin are needed)`)
  const hw = P.bodyHalfWidth
  const n = m.p.length / 3
  let [zMin, zMax, xMax] = [Infinity, -Infinity, 0]
  for (let i = 0; i < n; i++) [zMin, zMax, xMax] = [Math.min(zMin, m.p[3 * i + 2]), Math.max(zMax, m.p[3 * i + 2]), Math.max(xMax, m.p[3 * i])]
  const part = parts(m)
  const boxes = partBoxes(m, part)
  const spans = new Set([...boxes].filter(([, { box: b }]) => {
    const long = Math.max(b[1] - b[0], b[5] - b[4])
    return Math.max(-b[0], b[1]) > 2.5 * hw || (long > 2.5 * hw && b[3] - b[2] < 0.3) // reaching far out, or a thin blade
  }).map(([k]) => k))
  spans.delete([...boxes].reduce((a, b) => (b[1].box[5] - b[1].box[4] > a[1].box[5] - a[1].box[4] ? b : a))[0]) // never the longest part: the fuselage (or all of the airframe, welded)
  // engines: the biggest nacelle-shaped part in the paint map's engine box on the left, and what hangs with it
  const groups = engineParts(boxes, P.engines)
  const engines: ModelProfile['engines'] = groups.length === 0 ? null : [ // every left engine (a 747's two)
    Math.min(...groups.map((g) => g.box[0])), Math.max(...groups.map((g) => g.box[1])), Math.min(...groups.map((g) => g.box[2])),
    Math.max(...groups.map((g) => g.box[3])), Math.min(...groups.map((g) => g.box[4])), Math.max(...groups.map((g) => g.box[5])),
  ]

  const inBox = (x: number, y: number, z: number): boolean =>
    engines !== null && Math.abs(x) >= engines[0] - 0.05 && Math.abs(x) <= engines[1] + 0.05 && z >= engines[2] - 0.05 && z <= engines[3] + 0.05 && y >= engines[4] - 0.05 && y <= engines[5] + 0.05
  for (const [k, { box: b }] of boxes) { // both engines, out of the body (a rear-mounted pair beside the fuselage)
    if (engines !== null && Math.min(Math.abs(b[0]), Math.abs(b[1])) >= engines[0] - 0.1 && Math.max(Math.abs(b[0]), Math.abs(b[1])) <= engines[1] + 0.1 &&
      b[2] >= engines[4] - 0.1 && b[3] <= engines[5] + 0.1 && b[4] >= engines[2] - 0.1 && b[5] <= engines[3] + 0.1) spans.add(k)
  }
  if (ROTOR.has(e.id)) { // and the rotor above the cabin and cowling (the two biggest parts), the skids below the cabin
    const big = [...boxes.values()].sort((a, b) => b.n - a.n).slice(0, 2).map((b) => b.box)
    const [floor, roof] = [big[0][2], Math.max(big[0][3], big[1][3])]
    for (const [k, { box: b }] of boxes) if (b[2] > roof - 0.05 || b[3] < floor + 0.1) spans.add(k)
  }
  const keep = (t: number): boolean => !spans.has(part[t])

  // body: nose → tail every 0.25 m, the nose tip first
  const stations: Station[] = []
  for (let z = zMax - 0.02; z > zMin + 0.01; z -= 0.25) {
    const s = station(m, keep, z, hw, z < zMax - 0.12 * (zMax - zMin)) // no blades on the nose cone (its pointed top)
    if (s !== null) stations.push(s)
    else if (z < (zMin + zMax) / 2 && stations.length > 0) break // the tail cone has ended
  }
  let nose: [number, number] = [-Infinity, 0] // the nose tip's [z, y]: the forward-most point within the fuselage's width
  for (let t = 0; t < m.tri.length; t++) {
    const i = 3 * m.tri[t]
    if (keep(Math.floor(t / 3)) && Math.abs(m.p[i]) < hw && m.p[i + 2] > nose[0]) nose = [m.p[i + 2], m.p[i + 1]]
  }
  const body: Array<[number, number, number]> = [[nose[0], nose[1], nose[1]], ...stations.map((s): [number, number, number] => [s.z, s.bottom, s.top])]
  const top: Array<[number, number]> = body.map((b) => [b[0], b[2]])
  const zMid = (zMin + zMax) / 2

  // fin: horizontal slices above the body top, aft half
  const finX = Math.min(P.fin.halfWidth, 0.7)
  const aft = stations.filter((s) => s.z < zMid)
  const rootLow = Math.min(...aft.map((s) => s.top))
  let finTopY = -Infinity
  for (let t = 0; t < m.tri.length; t++) {
    const i = 3 * m.tri[t]
    if (keep(Math.floor(t / 3)) && m.p[i + 2] < zMid && Math.abs(m.p[i]) < finX) finTopY = Math.max(finTopY, m.p[i + 1])
  }
  // from the tip down: each slice's points no further forward than the previous leading edge allows (it moves gradually,
  // along a dorsal fillet too), so a cowling or a canopy at the same height further forward is not taken for the fin
  const edges: Array<{ y: number; le: number; te: number }> = []
  for (let y = finTopY; y >= rootLow + 0.02; y -= 0.05) {
    const s = section(m, 1, Math.min(y, finTopY - 0.005), keep)
    const prev = edges[edges.length - 1]
    let [le, te] = [-Infinity, Infinity]
    for (let k = 0; k < s.length; k += 2) {
      const [x, z] = [s[k], s[k + 1]]
      if (Math.abs(x) > finX || z > zMid || y < along(top, z) + 0.06) continue
      if (prev !== undefined && z > prev.le + 1.5) continue
      ;[le, te] = [Math.max(le, z), Math.min(te, z)]
    }
    if (le > te) edges.push({ y: Math.min(y, finTopY), le, te })
    else if (edges.length > 0) break
  }
  edges.reverse()
  if (edges.length < 3) throw new Error(`${e.id}: no fin found`)
  const [y0, y1] = [edges[0].y, edges[edges.length - 1].y]
  const H = y1 - y0
  const mid = edges.filter((q) => q.y >= y0 + 0.3 * H && q.y <= y0 + 0.85 * H)
  const leLine = fit(mid.map((q) => [q.y, q.le]))
  const teLine = fit(mid.map((q) => [q.y, q.te]))
  for (const q of edges) q.te = Math.max(q.te, teLine(q.y) - 0.6) // not along the tail cone's top, behind the rudder
  let yRoot = y0
  for (let k = 0; k < 6; k++) yRoot = along(top, leLine(yRoot)) // where the leading edge meets the body top
  const tipEdge = edges[edges.length - 1]
  const outline: Array<[number, number]> = [
    ...edges.map((q): [number, number] => [q.le, q.y]),
    ...edges.toReversed().map((q): [number, number] => [q.te, q.y]),
    ...top.filter(([z]) => z > edges[0].te && z < edges[0].le).toReversed().map(([z, y]): [number, number] => [z, y]),
  ]
  const fin = simplify(outline, 0.02).map(([z, y]): [number, number] => [cm(z), cm(y)])


  // wing: the root chord, and the tip at the wing's own level
  const chordAt = (x: number): { le: number; te: number; y: number } | null => {
    // the section's longest part (the wing, not a propeller disc, a slat or a flap track), less engines and pylons
    const by = new Map<number, Array<[number, number]>>()
    for (const [k, pts] of sectionByPart(m, part, x)) {
      const kept = pts.filter(([z, y]) => z > zMin + 0.3 * (zMax - zMin) && z < zMax - 0.15 * (zMax - zMin) && !inBox(x, y, z))
      if (kept.length >= 2) by.set(k, kept)
    }
    const ext = (q: Array<[number, number]>): number => Math.max(...q.map((p) => p[0])) - Math.min(...q.map((p) => p[0]))
    const pts = [...by.values()].reduce<Array<[number, number]> | null>((a, q) => (a === null || ext(q) > ext(a) ? q : a), null)
    if (pts === null) return null
    const [le, te] = [Math.max(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[0]))]
    const thick = pts.filter(([z]) => z <= le - 0.1 * (le - te) && z >= le - 0.4 * (le - te)) // the thickest part of the chord
    const ys = (thick.length >= 2 ? thick : pts).map((q) => q[1])
    return { le, te, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
  }
  const r1 = chordAt(hw + 0.6)
  if (r1 === null) throw new Error(`${e.id}: no wing root`)
  const r2 = chordAt(hw + 1.2) ?? r1 // an engine close in (the E-jets): no taper
  const rootLe = r1.le + (r1.le - r2.le)
  const rootTe = r1.te + (r1.te - r2.te)
  // the wing's upper surface outboard of the engines (and of anything hung under it): its highest point per section
  const outer: Array<[number, number]> = []
  const x0 = Math.max(hw + 2, engines !== null ? engines[1] + 0.5 : 0.35 * xMax)
  for (let k = 0; k <= 4; k++) {
    const x = x0 + ((0.9 * xMax - x0) * k) / 4
    const s = section(m, 0, x)
    let hi = -Infinity
    for (let q = 0; q < s.length; q += 2) if (s[q] > zMin + 0.25 * (zMax - zMin) && !inBox(x, s[q + 1], s[q])) hi = Math.max(hi, s[q + 1])
    if (hi > -Infinity) outer.push([x, hi])
  }
  // the wing plane: the median slope of the stations, through their median point (a winglet or a nacelle top in one
  // station does not tilt it)
  const plane = ((): ((x: number) => number) => {
    const slopes: number[] = []
    for (let a = 0; a < outer.length; a++) for (let b = a + 1; b < outer.length; b++) slopes.push((outer[b][1] - outer[a][1]) / (outer[b][0] - outer[a][0]))
    const med = (v: number[]): number => v.toSorted((p, q) => p - q)[Math.floor(v.length / 2)]
    const sl = med(slopes)
    const c = med(outer.map(([x, y]) => y - sl * x))
    return (x: number) => c + sl * x
  })()
  // the tip: the outermost vertex at the wing's own level (a winglet rises above it); its y, the middle of the vertices
  // there
  let tipX = x0
  const level = (i: number): boolean => m.p[3 * i + 1] <= plane(m.p[3 * i]) + 0.1 && m.p[3 * i + 1] >= plane(m.p[3 * i]) - 0.7
  for (let i = 0; i < n; i++) if (m.p[3 * i] > tipX && level(i)) tipX = m.p[3 * i]
  let [lo, hi] = [Infinity, -Infinity]
  for (let i = 0; i < n; i++) if (m.p[3 * i] > tipX - 0.3 && level(i)) [lo, hi] = [Math.min(lo, m.p[3 * i + 1]), Math.max(hi, m.p[3 * i + 1])]
  const tipY = (lo + hi) / 2
  // the device: the triangles near the tip with a corner above the wing plane (or well below it), whole (a decimated
  // winglet is a plate from its root chord straight to its tip)
  let dev = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity] // x, z, y ranges
  const off = (i: number): boolean => m.p[3 * i] > tipX - 1.5 && (m.p[3 * i + 1] > plane(m.p[3 * i]) + 0.15 || m.p[3 * i + 1] < plane(m.p[3 * i]) - 0.75)
  for (let t = 0; t < m.tri.length; t += 3) {
    if (!off(m.tri[t]) && !off(m.tri[t + 1]) && !off(m.tri[t + 2])) continue
    for (let k = 0; k < 3; k++) {
      const i = 3 * m.tri[t + k]
      const [x, y, z] = [m.p[i], m.p[i + 1], m.p[i + 2]]
      dev = [Math.min(dev[0], x), Math.max(dev[1], x), Math.min(dev[2], z), Math.max(dev[3], z), Math.min(dev[4], y), Math.max(dev[5], y)]
    }
  }
  const winglet = dev[5] - plane(dev[1]) > 0.3 || plane(dev[1]) - dev[4] > 0.9
    ? ([dev[0], dev[1], dev[2], dev[3], Math.min(dev[4], plane(dev[0])), dev[5]].map(cm) as ModelProfile['winglet'])
    : null

  // stab: the flat parts near the fin (aft of its root leading edge less 2 m) reaching out past it, not engines
  let stab: ModelProfile['stab'] = null
  let stabY: number | null = null
  {
    const flat = [...boxes.values()].filter(({ box: b }) => b[5] < leLine(yRoot) + 2 && b[1] > finX + 1 && b[1] - Math.max(0, b[0]) > 1 &&
      b[3] - b[2] < 0.5 * (b[1] - Math.max(0, b[0])) && !inBox((b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2) && b[1] < 0.6 * tipX)
    if (flat.length > 0) {
      stab = [cm(Math.min(...flat.map((f) => f.box[4]))), cm(Math.max(...flat.map((f) => f.box[5]))), cm(Math.max(...flat.map((f) => f.box[1])))]
      stabY = flat.reduce((s, f) => s + f.n * (f.box[2] + f.box[3]) / 2, 0) / flat.reduce((s, f) => s + f.n, 0)
    }
  }

  /** A helicopter's "wing": no chord, no span; at the rotor mast (the middle of everything above the roof), on the body top. */
  const rotorWing = (): ModelProfile['wing'] => {
    const roof = Math.max(...stations.map((q) => q.top))
    let [sz, c] = [0, 0]
    for (let i = 0; i < n; i++) if (m.p[3 * i + 1] > roof + 0.3) [sz, c] = [sz + m.p[3 * i + 2], c + 1] // the rotor, centred on its mast
    const z = c > 0 ? sz / c : (zMin + zMax) / 2
    return [cm(z), cm(z), cm(along(top, z)), 0, cm(along(top, z))]
  }
  const tailZ = Math.min(stations[stations.length - 1].z, ...edges.map((q) => q.te))
  const keel = Math.min(...body.map((b) => b[1]))
  const profile: ModelProfile = {
    box: [cm(tailZ - 0.1), cm(nose[0] + 0.1), cm(keel - 0.1), cm(finTopY + 0.1)],
    body: body.map(([z, b, t]) => [cm(z), cm(b), cm(t)]),
    fin,
    finRoot: [cm(yRoot), cm(leLine(yRoot)), cm(teLine(yRoot))],
    finTip: [cm(tipEdge.y), cm(leLine(tipEdge.y)), cm(teLine(tipEdge.y))],
    wing: ROTOR.has(e.id) ? rotorWing() : [cm(rootLe), cm(rootTe), cm(r1.y), cm(tipX), cm(tipY)],
    engines,
    winglet,
    stab,
    doors: [],
    cockpit: cm(nose[0]),
  }
  const doc = DOCS[e.id]
  if (doc !== undefined) {
    const k = doc.lengthM === null ? 1 : (zMax - zMin) / doc.lengthM
    profile.doors = doc.doors.map((d) => cm(nose[0] - k * d))
    profile.cockpit = cm(nose[0] - k * doc.cockpit)
  }
  return { profile, stabY, wingPlane: plane }
}

/** The manifest line: `"profile": { … }`, the manifest's one-line-per-field style. */
export function profileLine(p: ModelProfile): string {
  const a = (v: readonly number[] | null): string => (v === null ? 'null' : `[${v.join(', ')}]`)
  return `"profile": { "box": ${a(p.box)}, "body": [${p.body.map(a).join(', ')}], "fin": [${p.fin.map(a).join(', ')}], ` +
    `"finRoot": ${a(p.finRoot)}, "finTip": ${a(p.finTip)}, "wing": ${a(p.wing)}, "engines": ${a(p.engines)}, ` +
    `"winglet": ${a(p.winglet)}, "stab": ${a(p.stab)}, "doors": ${a(p.doors)}, "cockpit": ${p.cockpit} }`
}

/** Replaces (or adds, after "lights") each listed model's profile line in the manifest text. */
export function writeProfiles(text: string, profiles: Map<string, ModelProfile>): string {
  const lines = text.split('\n')
  for (const [id, p] of profiles) {
    const at = lines.findIndex((l) => l.includes(`"id": "${id}"`))
    const end = lines.findIndex((l, i) => i > at && /^ {4}\}/.test(l))
    const line = profileLine(p)
    const old = lines.findIndex((l, i) => i > at && i < end && l.trim().startsWith('"profile"'))
    if (old >= 0) lines[old] = lines[old].replace(/"profile".*?(,?)$/, `${line}$1`)
    else {
      const after = lines.findLastIndex((l, i) => i > at && i < end && /^ {6}"(lights|box|scale|gearHeightM)"/.test(l))
      lines.splice(after + 1, 0, `      ${line},`)
    }
  }
  return lines.join('\n')
}

const RENDER = fileURLToPath(new URL('./render.py', import.meta.url))
const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url))

/** Draws e's profile over a side, a front and a top render of its mesh into <dir>/<id>-profile.png (python3). */
export function profilePng(e: ModelManifestEntry, r: Measured, dir: string): string {
  const p = r.profile
  const X = 0 // the side view projects x away
  const L = (pts: number[][], color: string, extra: object = {}): object => ({ pts, color, ...extra })
  const zy = (z: number, y: number): number[] => [X, y, z]
  const side: object[] = [
    L(p.body.map(([z, , t]) => zy(z, t)), '#e0201b', { width: 2 }),
    L(p.body.map(([z, b]) => zy(z, b)), '#1b4fe0', { width: 2 }),
    L(p.fin.map(([z, y]) => zy(z, y)), '#f08c00', { closed: true, width: 2 }),
    L([zy(p.finRoot[1], p.finRoot[0]), zy(p.finRoot[2], p.finRoot[0])], '#10a040', { width: 3, label: 'finRoot' }),
    L([zy(p.finTip[1], p.finTip[0]), zy(p.finTip[2], p.finTip[0])], '#10a040', { width: 3, label: 'finTip' }),
    L([zy(p.finRoot[1], p.finRoot[0]), zy(p.finTip[1], p.finTip[0])], '#10a040', { width: 1 }),
    L([zy(p.finRoot[2], p.finRoot[0]), zy(p.finTip[2], p.finTip[0])], '#10a040', { width: 1 }),
    L([zy(p.wing[0], p.wing[2]), zy(p.wing[1], p.wing[2])], '#7a18c8', { width: 3, label: 'wing root' }),
    L([zy(p.cockpit, along(p.body.map((b) => [b[0], b[2]]), p.cockpit)), zy(p.cockpit, along(p.body.map((b) => [b[0], b[1]]), p.cockpit))], '#00a0b0', { width: 2, label: 'cockpit' }),
    ...p.doors.map((z, i) => L([zy(z, along(p.body.map((b) => [b[0], b[2]]), z) - 0.2), zy(z, along(p.body.map((b) => [b[0], b[1]]), z) + 0.6)], '#b01060', { width: 2, label: `door ${i + 1}` })),
    L([zy(p.box[0], p.box[2]), zy(p.box[1], p.box[2]), zy(p.box[1], p.box[3]), zy(p.box[0], p.box[3])], '#555555', { closed: true, width: 1 }),
  ]
  if (p.engines) {
    const [, , z0, z1, y0, y1] = p.engines
    side.push(L([zy(z0, y0), zy(z1, y0), zy(z1, y1), zy(z0, y1)], '#00b5e2', { closed: true, width: 2, label: 'engines' }))
  }
  if (p.winglet) {
    const [, , z0, z1, y0, y1] = p.winglet
    side.push(L([zy(z0, y0), zy(z1, y0), zy(z1, y1), zy(z0, y1)], '#c8a000', { closed: true, width: 2, label: 'winglet' }))
  }
  if (p.stab && r.stabY !== null) side.push(L([zy(p.stab[0], r.stabY), zy(p.stab[1], r.stabY)], '#6a3d9a', { width: 3, label: 'stab' }))
  const front: object[] = [
    L([[p.wing[3], p.wing[4], 0], [-p.wing[3], p.wing[4], 0]], '#7a18c8', { width: 1, dots: true }),
    L([[0, r.wingPlane(0), 0], [p.wing[3], r.wingPlane(p.wing[3]), 0]], '#7a18c8', { width: 1, label: 'wing plane' }),
  ]
  const top: object[] = [
    L([[e.paint!.bodyHalfWidth, 0, p.wing[0]], [p.wing[3], 0, p.wing[0]]], '#7a18c8', { width: 1, label: 'root LE' }),
    L([[e.paint!.bodyHalfWidth, 0, p.wing[1]], [p.wing[3], 0, p.wing[1]]], '#7a18c8', { width: 1, label: 'root TE' }),
    L([[p.wing[3], 0, p.wing[0]], [p.wing[3], 0, p.wing[1] - 3]], '#7a18c8', { width: 1, label: 'tipX' }),
  ]
  for (const [box, color, label] of [[p.engines, '#00b5e2', 'engines'], [p.winglet, '#c8a000', 'winglet']] as const) {
    if (box === null) continue
    const [x0, x1, z0, z1, y0, y1] = box
    front.push(L([[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]], color, { closed: true, width: 2, label }))
    top.push(L([[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]], color, { closed: true, width: 2, label }))
  }
  if (p.stab) top.push(L([[p.stab[2], 0, p.stab[0]], [p.stab[2], 0, p.stab[1]], [-p.stab[2], 0, p.stab[1]], [-p.stab[2], 0, p.stab[0]]], '#6a3d9a', { closed: true, width: 2, label: 'stab' }))
  const out = join(dir, `${e.id}-profile.png`)
  const spec = {
    glb: join(PUBLIC, e.uri), turn: e.paint?.noseMinusZ === true, out, title: `${e.id} profile (paint frame; tools/models/profile.ts)`, cols: 2,
    views: [
      { name: 'left side (nose left)', dir: [-1, 0, 0], up: [0, 1, 0], px: 2400, overlay: side },
      { name: 'tail', dir: [-1, 0, 0], up: [0, 1, 0], px: 1200, overlay: side, centre: [0, (p.box[2] + p.box[3]) / 2, p.box[0] + 0.14 * (p.box[1] - p.box[0])], extent: 0.3 * (p.box[1] - p.box[0]), aspect: 0.75 },
      { name: 'nose', dir: [-1, 0, 0], up: [0, 1, 0], px: 1200, overlay: side, centre: [0, (p.body[0][1] + p.body[0][2]) / 2, p.box[1] - 0.12 * (p.box[1] - p.box[0])], extent: 0.24 * (p.box[1] - p.box[0]), aspect: 0.5 },
      { name: 'front', dir: [0, 0, -1], up: [0, 1, 0], px: 1400, overlay: front },
      { name: 'top (nose up)', dir: [0, -1, 0], up: [0, 0, 1], px: 1400, overlay: top },
    ],
  }
  const specPath = join(dir, `${e.id}-profile.json`)
  writeFileSync(specPath, JSON.stringify(spec))
  execFileSync('python3', [RENDER, specPath], { stdio: 'pipe' })
  return out
}

if (import.meta.main) {
  const text = readFileSync(MANIFEST, 'utf8')
  const manifest: ModelManifest = JSON.parse(text)
  const png = process.argv.indexOf('--png')
  const dir = png >= 0 ? process.argv[png + 1] : null
  if (dir !== null) mkdirSync(dir, { recursive: true })
  const only = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--png')
  const found = new Map<string, ModelProfile>()
  for (const e of manifest.models) {
    if (e.paint === undefined || (only.length > 0 && !only.includes(e.id))) continue
    let r: Measured
    try {
      r = profileOf(e)
    } catch (err) {
      console.error(`${e.id}: ${(err as Error).message}`)
      process.exitCode = 1
      continue
    }
    found.set(e.id, r.profile)
    console.log(`${e.id}: ${profileLine(r.profile).slice(0, 400)}…`)
    if (dir !== null) console.log(`  ${profilePng(e, r, dir)}`)
  }
  if (process.argv.includes('--write')) {
    writeFileSync(MANIFEST, writeProfiles(text, found))
    JSON.parse(readFileSync(MANIFEST, 'utf8')) // still JSON
    console.log(`wrote ${MANIFEST}`)
  }
}
