// client/scene/runwayPaint.ts
// A runway's paving and its markings (ICAO Annex 14, simplified), drawn procedurally on its plane: threshold stripes,
// the designator, centre-line dashes, touchdown-zone and aiming-point bars, side stripes, the asphalt's own variation
// and the tyre rubber in the touchdown zones. The plane is a strip of quads every RUNWAY_STEP_M along the runway, at
// the height the terrain is flattened to there (flatTerrain.ts: linear between the threshold heights), so it follows
// the Earth's curvature (a 4 km two-triangle plane sags 0.3 m under it, through its 0.2 m lift). Its texture
// coordinates are metres, (across, right of the direction from end 0 to end 1; along from end 0), so the shader draws
// every marking at its real size with no texture but a glyph atlas for the designators.
import { BoundingSphere, Cartesian3, Cartesian4, Color, ComponentDatatype, Ellipsoid, Geometry, GeometryAttribute, GeometryAttributes, Material, PrimitiveType } from 'cesium'
import type { Runway } from '../../shared/airports.ts'
import { bearingDeg, destination } from '../../shared/geo.ts'

export const RUNWAY_STEP_M = 100 // quad length along the runway: a chord sags 0.2 mm under the curved plane
export const GLYPHS = '0123456789LRC' // the designator atlas, one cell each
const FT = 0.3048
const NM = 1852

/** A runway end's designator glyphs (atlas indices): its letter (−1: none), then two digits. Not a number: all −1. */
export function designator(ident: string): [number, number, number] {
  const m = /^(\d{1,2})([LRC]?)$/.exec(ident.trim().toUpperCase())
  if (m === null) return [-1, -1, -1]
  const digits = m[1].padStart(2, '0')
  return [m[2] === '' ? -1 : GLYPHS.indexOf(m[2]), GLYPHS.indexOf(digits[0]), GLYPHS.indexOf(digits[1])]
}

/** Threshold stripes each side of the centre line: 1.8 m on a 3.6 m pitch from 1.8 m out, to 27 m or 3 m inside the edge. */
export function thresholdStripesPerSide(widthM: number): number {
  return Math.max(1, Math.floor(Math.min(widthM / 2 - 3, 27) / 3.6))
}

export interface RunwayGeometryData {
  positions: Float64Array // ECEF metres: per row the left, then the right edge
  normals: Float32Array // the ellipsoid's up at each vertex
  st: Float32Array // metres: across (right of end 0 → end 1 positive), along from end 0
  indices: Uint32Array
  lengthM: number
  widthM: number
  thrA: number // end 0's threshold, metres from its physical end
  thrB: number // end 1's
}

/** The runway's plane as a strip of quads between its physical ends, heights linear between the thresholds + liftM. */
export function runwayGeometryData(r: Runway, liftM: number): RunwayGeometryData {
  const [a, b] = r.ends
  const brg = bearingDeg(a.lat, a.lon, b.lat, b.lon)
  const lengthM = distanceM(a.lat, a.lon, b.lat, b.lon)
  const widthM = r.widthFt * FT
  const rows = Math.max(2, Math.ceil(lengthM / RUNWAY_STEP_M) + 1)
  const positions = new Float64Array(rows * 6)
  const normals = new Float32Array(rows * 6)
  const st = new Float32Array(rows * 4)
  const up = new Cartesian3()
  const p = new Cartesian3()
  for (let i = 0; i < rows; i++) {
    const s = (lengthM * i) / (rows - 1)
    const c = destination(a.lat, a.lon, brg, s / NM)
    const h = a.thrHaeM + ((b.thrHaeM - a.thrHaeM) * s) / lengthM + liftM
    for (const [k, side] of [[0, -90], [1, 90]] as const) {
      const e = destination(c.lat, c.lon, brg + side, widthM / 2 / NM)
      Cartesian3.fromDegrees(e.lon, e.lat, h, Ellipsoid.WGS84, p)
      Ellipsoid.WGS84.geodeticSurfaceNormal(p, up)
      positions.set([p.x, p.y, p.z], 6 * i + 3 * k)
      normals.set([up.x, up.y, up.z], 6 * i + 3 * k)
      st.set([k === 0 ? -widthM / 2 : widthM / 2, s], 4 * i + 2 * k)
    }
  }
  const indices = new Uint32Array((rows - 1) * 6)
  for (let i = 0; i < rows - 1; i++) {
    const l0 = 2 * i
    indices.set([l0, l0 + 2, l0 + 1, l0 + 1, l0 + 2, l0 + 3], 6 * i) // counter-clockwise seen from above
  }
  return { positions, normals, st, indices, lengthM, widthM, thrA: a.displacedFt * FT, thrB: b.displacedFt * FT }
}

/** Great-circle distance, metres (haversine). */
function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const s = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** The Cesium Geometry of runwayGeometryData (position, normal, st: MaterialAppearance's TEXTURED format). */
export function runwayGeometry(d: RunwayGeometryData): Geometry {
  return new Geometry({
    attributes: {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: d.positions }),
      normal: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: d.normals }),
      st: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: d.st }),
    } as unknown as GeometryAttributes,
    indices: d.indices,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(Array.from(d.positions)),
  })
}

// ---------- the markings ----------

const CELL_W = 64
const CELL_H = 128
let atlas: HTMLCanvasElement | null = null

/** The designator glyphs, white on transparent, one CELL_W × CELL_H cell each in a row (a bold condensed face). Browser only. */
function glyphAtlas(): HTMLCanvasElement {
  if (atlas !== null) return atlas
  const cv = document.createElement('canvas')
  cv.width = CELL_W * GLYPHS.length
  cv.height = CELL_H
  const g = cv.getContext('2d')!
  g.fillStyle = g.strokeStyle = '#fff'
  g.lineJoin = 'round'
  g.lineWidth = CELL_H * 0.07 // block figures: ~0.9 m strokes on a 9 m figure
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `bold ${CELL_H * 0.86}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`
  for (let i = 0; i < GLYPHS.length; i++) {
    g.save()
    g.translate(CELL_W * (i + 0.5), CELL_H / 2)
    g.scale(0.68, 1) // runway figures are tall and narrow: 9 m by ~3.5 m
    g.strokeText(GLYPHS[i], 0, CELL_H * 0.04)
    g.fillText(GLYPHS[i], 0, CELL_H * 0.04)
    g.restore()
  }
  return (atlas = cv)
}

const SOURCE = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
// 1 inside [a, b], edges anti-aliased over aa
float band(float v, float a, float b, float aa) {
  return smoothstep(a - aa, a + aa, v) * (1.0 - smoothstep(b - aa, b + aa, v));
}
float rect(vec2 p, vec2 lo, vec2 hi, vec2 aa) {
  return band(p.x, lo.x, hi.x, aa.x) * band(p.y, lo.y, hi.y, aa.y);
}
float glyph(vec2 p, vec2 lo, vec2 size, float index) {
  if (index < 0.0) return 0.0;
  vec2 uv = (p - lo) / size;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture(glyphs, vec2((index + uv.x) / ${GLYPHS.length.toFixed(1)}, uv.y)).a;
}
// One end's markings, in its own frame: x metres right of an aircraft landing there, y metres past its threshold.
float endMarks(vec2 p, vec2 aa, float w, float len, vec3 des) {
  float m = 0.0;
  if (p.y < -1.0 || p.y > 1000.0) return 0.0;
  // threshold stripes, 6 to 36 m
  float n = max(1.0, floor(min(w * 0.5 - 3.0, 27.0) / 3.6));
  float ax = abs(p.x);
  float k = floor((ax - 1.8) / 3.6);
  if (k >= 0.0 && k < n) m = max(m, rect(vec2(ax, p.y), vec2(1.8 + 3.6 * k, 6.0), vec2(3.6 + 3.6 * k, 36.0), aa));
  // designator: its letter 48 to 57 m, the two figures 63 to 72 m, 3.6 m wide each
  m = max(m, glyph(p, vec2(-1.8, 48.0), vec2(3.6, 9.0), des.x));
  m = max(m, glyph(p, vec2(-4.2, 63.0), vec2(3.6, 9.0), des.y));
  m = max(m, glyph(p, vec2(0.6, 63.0), vec2(3.6, 9.0), des.z));
  if (len >= 1500.0 && w >= 30.0) {
    float s = w >= 45.0 ? 1.0 : 0.75;
    // aiming point: two 9 m bars, 400 to 450 m
    m = max(m, rect(vec2(ax, p.y), vec2(10.0, 400.0) * vec2(s, 1.0), vec2(19.0 * s, 450.0), aa));
    // touchdown zone: 3, 3, 2, 2, 1 bars each side at 150, 300, 600, 750, 900 m
    for (int i = 0; i < 5; i++) {
      float at = i == 0 ? 150.0 : i == 1 ? 300.0 : i == 2 ? 600.0 : i == 3 ? 750.0 : 900.0;
      float cnt = i < 2 ? 3.0 : i < 4 ? 2.0 : 1.0;
      if (len < 2.0 * (at + 150.0)) break;
      float j = floor((ax - 9.0 * s) / (4.5 * s));
      if (j >= 0.0 && j < cnt) m = max(m, rect(vec2(ax, p.y), vec2(9.0 * s + 4.5 * s * j, at), vec2(9.0 * s + 4.5 * s * j + 3.0 * s, at + 22.5), aa));
    }
  }
  return m;
}

czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st; // metres: across, along from end 0
  vec2 aa = max(fwidth(st), vec2(0.02)) * 0.75;
  float len = dims.x;
  float w = dims.y;
  // paint: both ends in their own frames, the centre line between the designators, the side stripes
  float m = max(endMarks(vec2(st.x, st.y - dims.z), aa, w, len, desA.xyz), endMarks(vec2(-st.x, len - st.y - dims.w), aa, w, len, desB.xyz));
  float cl0 = dims.z + 80.0;
  float cl1 = len - dims.w - 80.0;
  if (st.y > cl0 && st.y < cl1) m = max(m, band(st.x, -0.45, 0.45, aa.x) * band(mod(st.y - cl0, 50.0), 0.0, 30.0, aa.y));
  if (w >= 30.0) m = max(m, band(abs(st.x), w * 0.5 - 0.9, w * 0.5, aa.x));
  // the asphalt: patches of different pours and weathering, and tyre rubber in the touchdown zones
  float fade = 1.0 - smoothstep(0.4, 4.0, max(aa.x, aa.y)); // fine detail only where it can show
  float grain = 0.92 + 0.08 * vnoise(st * vec2(0.9, 0.35)) * fade + 0.05 * (vnoise(st * vec2(0.02, 0.006)) - 0.5);
  float tdzA = band(st.y - dims.z, 150.0, 1100.0, 60.0);
  float tdzB = band(len - st.y - dims.w, 150.0, 1100.0, 60.0);
  float streaks = 0.6 + 0.4 * vnoise(vec2(st.x * 1.6, st.y * 0.04));
  float rubber = max(tdzA, tdzB) * band(abs(st.x), -1.0, 11.0, 3.0) * streaks;
  vec3 ground = asphalt.rgb * grain * (1.0 - 0.45 * rubber);
  float wear = 0.8 + 0.2 * vnoise(st * vec2(1.3, 0.5));
  material.diffuse = mix(ground, paint.rgb * mix(1.0, 0.75, rubber), clamp(m * wear, 0.0, 1.0));
  material.alpha = 1.0;
  return material;
}
`

/** The runway's material: asphalt and paint are Colors the caller rescales in place for the light (runways.ts setLight). */
export function runwayMaterial(d: RunwayGeometryData, r: Runway, asphalt: Color, paint: Color): Material {
  const [a, b] = r.ends.map((e) => designator(e.ident))
  return new Material({
    fabric: {
      uniforms: {
        asphalt,
        paint,
        glyphs: typeof document === 'undefined' ? Material.DefaultImageId : glyphAtlas(), // Node (tests): no canvas
        dims: new Cartesian4(d.lengthM, d.widthM, d.thrA, d.thrB),
        desA: new Cartesian3(...a),
        desB: new Cartesian3(...b),
      },
      source: SOURCE,
    },
    translucent: false,
  })
}
