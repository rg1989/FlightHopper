// client/scene/cloudVolume.ts
// The chase's weather as volumes: one post-process pass that walks every pixel's ray through the weather field (wxField.ts), so a cloud
// is a body with a near side and a far side. The aircraft flies into it, fades in it and is gone in thick cloud (nothing is cleared round
// it), and the terrain, the buildings and the aircraft hide the cloud behind them and are hidden by the cloud in front, as the depth
// buffer says. Weather3D hands it the cloud specs of every source at once (draw), and it builds the field round the aircraft from them.
// The pass is a PostProcessStageComposite of two stages, both on the scene's own colour:
// - the march, at half the size: the ray from the depth buffer (as groundFog.ts reads it), walked in at most 96 steps. Where no band
//   with weather near holds the ray's height it goes straight to the next band's heights, or 4.5 km on (a coarse map of where each band
//   has weather vouches for that far); in a band's heights it searches in steps that grow with the distance, and a step that lands in
//   cloud goes back: the cloud's near side is found (to a thirty-second of the step), and the cloud is walked in small steps from
//   there. Neighbouring pixels start their search a quarter of a step apart, in blocks of 2 × 2, and the mix lays the four together:
//   what one pixel's steps pass over the next one's find, with no random jitter, so no grain. It gives the weather's colour,
//   premultiplied, and how much it covers;
// - the mix, at full size: the march laid over the scene, each pixel the mean of the four march pixels round it, those that saw about
//   the same depth weighing most (so the aircraft's outline stays sharp against cloud); and under it the clouds' shadows on what is
//   ground.
// The shader works in a frame of its own, so that it holds no large number: km east, north and up from the field's middle at sea level
// (localFrame; JS gives it u_eyeToLocal each frame, worked out in doubles). A point's height over the sea is z + (x² + y²) / 2R, and
// its place on the field's flat map follows from x and y (localToMap, the shader's toMap: to 40 m within 150 km, 100 m in the corners).
// Three textures, each an ImageData that Cesium uploads as it is (the atlas's alpha is data: nothing may premultiply it): the field's
// atlas (wxField.ts fieldAtlas); a noise volume of 64³ packed as 64 tiles (noiseAtlas); the coarse map (survey). The density at a point
// is wxField.ts sampleField's (each band whose heights hold the point, cover × profile, the largest winning and giving the severity),
// taken where a domain warp puts the point and eroded by four octaves of the noise, as the approved mock does
// (.planning/mocks/chase-weather-mocks.html). In the two volume looks it is drawn times 1.5 and capped at 1 (GAIN, the mock's: bodies
// are solid, their edges crisp), so what is drawn is denser than sampleField's number; the blocks use the number as it is. The noise is
// fixed to the Earth, not to the field: a field built round another place keeps every cloud's detail.
// Three looks, switched on the fly (look): natural (sunlit white to shadowed blue-grey, by two samples toward the light; darker with
// severity), severity (the same, tinted by the severity's colour from light rain up) and blocks (the sky in cells of 1 × 1 km and 500 m
// of height, a cell solid when the field's cover at its middle is over 0.28: faces shaded by the way they face, darker edges, the
// severity's colour; from inside a body, a mist of its colour). The blocks are walked cell by cell: each step ends on the cell's far
// face, by the ray's way on the field's map at that cell, so the Earth's curve is in it and a face is exact at any distance. (The plan
// was steps of a quarter cell and a bisect back to the face: 96 of those reach 12 to 27 km, and a storm may stand 100 km off.) Under a
// cloud of light rain or more a thin veil of rain, streaked, falls to the ground. The cover fades to nothing between 130 and 150 km
// from the aircraft (fade). By night the light is dimmed as cloudField.ts sunBrightness says, and the shadows go.
// While hidden, while the field is empty and once destroyed there is no stage in the scene, so nothing runs.
// Each draw makes a new pass in place of the last (the plan was to give the running stage the new image). An image given to a stage
// that already runs is not uploaded until Cesium's next update, and the stage's sampler has nothing for that frame (the render fails);
// a new stage's image is uploaded before its first run. (Read in Cesium's PostProcessStage.js and createUniform.js; not tried.)
// ponytail: the clouds stand at their true heights when the relief is flattened or grown (the puffs moved with their station's ground).
// Upgrade: the frame's relief in the height the shader takes.
// ponytail: sea level is the geoid's at the field's middle, over the whole field (it differs by a few metres across it), and the blocks'
// cells and the rain's streaks are laid in the field's frame: they shift when the field is built round another place. Upgrade: a grid
// fixed to the Earth.
// ponytail: a band's shadow is its cover where the light's ray meets the band's lowest base, not the cloud's whole height marched
// toward the light. Upgrade: a few steps up the ray.
import { Cartesian2, Cartesian3, Matrix4, PostProcessStage, PostProcessStageComposite, Transforms, type Camera, type PostProcessStageCollection } from 'cesium'
import { geoidN } from '../../shared/geoid.ts'
import type { TerrainFrame } from '../types.ts'
import { sequence, sunBrightness, type CloudSpec } from './cloudField.ts'
import { BANDS, FALL, FALL_MAX_M, FIELD_KM, FIELD_N, HEIGHT_MAX_M, RISE, RISE_MAX_M, buildField, fieldAtlas, type WxField } from './wxField.ts'

export type CloudLook = 'natural' | 'severity' | 'blocks'
/** How a hazard area's edge is drawn: a curtain hung from its top, a fence (lines and posts), or the box of today (a faint fill and its edges). */
export type HazardStyle = 'curtain' | 'fence' | 'box'
const LOOK: Record<CloudLook, number> = { natural: 0, severity: 1, blocks: 2 } // u_look
const R_KM = 6371 // the sphere the heights curve over
const KM_PER_DEG = 111.195 // of latitude on it: the field's map
const RAD = Math.PI / 180
const TEXEL_KM = FIELD_KM / FIELD_N
const ATLAS_W = 3 * FIELD_N // wxField.ts fieldAtlas: 3 × 2 tiles
const ATLAS_H = 2 * FIELD_N
const NOISE_M = 32 // the noise is made in a volume of this side (the mock's) …
const NOISE_N = 2 * NOISE_M // … and given to the shader at twice that, so that its texels do not show in a cloud near the camera
const NOISE_TILE = NOISE_N + 2 // a slice and its rim
const NOISE_COLS = 8
const NOISE_ROWS = NOISE_N / NOISE_COLS
const NOISE_KM = 32 // its longest period: the octaves and the warp are whole fractions of it, so a shift of 32 km changes nothing
const NOISE_SEED = 5
const NEAR_N = 64 // the coarse map's side: cells of 5 km
// Where the coarse map reads 0 for a band, between its cells' middles, that band has no weather within 7.2 km (the four cells round,
// and theirs, are clear); the warp moves a sample 2.2 km at most and a block's middle is 0.7 km from its corner: a stride of this is safe.
const CLEAR_KM = 4.5
const SEARCH = 0.035 // a search step is this share of the distance from the camera (0.12 km at least) …
const SEARCH_UP_KM = 0.25 // … and climbs or sinks no more than this: the thinnest cloud is 0.45 km
const STAY_KM = 0.8 // out of a cloud, the ray keeps to small steps this far
const STEPS = 96 // of the march, at most
const REACH_KM: readonly [number, number] = [130, 150] // the cover fades to nothing between these, from the aircraft
const RIM_KM: readonly [number, number] = [150, 158] // and at the square's rim
const BOX_KM = 165 // the ray is clipped to this in the frame: the field's 160 km and room for the map's bend
const GAIN = 1.5 // the field's cover × profile is drawn times this, capped at 1 (the mock's): bodies are solid, their edges crisp
const SIGMA = 7 // extinction per km of full cloud (the mock's) …
const SIGMA_STORM = 11 // … and in heavy rain and storms
const RAIN = 0.1 // the rain's veil: this share of its cloud's extinction …
const RAIN_MOST = 0.5 // … and however much rain the ray passes, it hides no more than this of what is behind: a veil, not a wall
const FILL = 0.28 // blocks: a cell is solid when the field's cover at its middle is over this
const SHADOW = 0.5 // the ground under full cover is darkened by this, by day
const SHADOW_LOW = 0.26 // the light's ray is taken no flatter than 15° for the shadows (a 2° sun would lay them 40 km off)
// The mix: a march pixel weighs 1 / (1 + (its depth's difference from the pixel's / this)²). Depths are logarithmic: 0.01 is a quarter
// farther or nearer, so the ground's own slope changes nothing, and an aircraft against the cloud behind it changes everything.
const DEPTH_SAME = 0.01

const glsl = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n))

/** Bytes of an RGBA image, row by row from the first. */
export interface Bitmap {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** The numbers that turn a place of the frame into a place of the field's map (mapScale). */
export interface MapScale {
  sx: number // the map's km per km of the frame eastward, at the field's middle
  sy: number // and northward
  t: number // tan(latitude) / R: how the meridians close in northward, per km
}

const TO_KM = Matrix4.fromUniformScale(0.001)

/**
 * World metres to the frame at lat, lon, heightM (above the ellipsoid): km east, north and up from there.
 */
export function localFrame(lat: number, lon: number, heightM: number, result = new Matrix4()): Matrix4 {
  const toWorld = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, heightM), undefined, result)
  return Matrix4.multiply(TO_KM, Matrix4.inverseTransformation(toWorld, result), result)
}

/** Eye metres to the frame: the frame's matrix (localFrame) times the camera's inverse view, in doubles, so the shader's floats hold only km round the field. */
export function eyeToLocal(inverseView: Matrix4, frame: Matrix4, result: Matrix4): Matrix4 {
  return Matrix4.multiply(frame, inverseView, result)
}

/** The map's scale in the frame at lat, lon, heightM: the field maps a degree as 111.195 km (× cos(lat) eastward), the frame is the ellipsoid's metres. */
export function mapScale(lat: number, lon: number, heightM: number): MapScale {
  const frame = localFrame(lat, lon, heightM)
  const d = 0.01 // degrees: about a km
  const east = Matrix4.multiplyByPoint(frame, Cartesian3.fromDegrees(lon + d, lat, heightM), new Cartesian3())
  const north = Matrix4.multiplyByPoint(frame, Cartesian3.fromDegrees(lon, lat + d, heightM), new Cartesian3())
  return { sx: (d * KM_PER_DEG * Math.max(0.01, Math.cos(lat * RAD))) / east.x, sy: (d * KM_PER_DEG) / north.y, t: Math.tan(lat * RAD) / R_KM }
}

/**
 * A place of the frame (km) as the field maps it: [km east, km north, km above the sea]. The shader's toMap. The height is the frame's
 * z and the Earth's curve; east and north are the frame's x and y drawn in to sea level, with a tangent plane's terms of the second
 * and third order (the meridians close in northward; a parallel bends away from the plane's east axis; an arc is longer than its chord).
 */
export function localToMap(x: number, y: number, z: number, s: MapScale): [number, number, number] {
  const h = z + (x * x + y * y) / (2 * R_KM)
  const k = 1 - h / R_KM
  const [ex, ey] = [x * k, y * k]
  const c = 1 / (R_KM * R_KM)
  const east = ex * (1 + s.t * ey + (s.t * s.t + 0.5 * c) * ey * ey + (c / 6 - (s.t * s.t) / 3) * ex * ex)
  const north = ey - 0.5 * s.t * ex * ex * (1 + s.t * ey) + (c / 6) * ey * ey * ey
  return [s.sx * east, s.sy * north, h]
}

/**
 * The atlas's texture coordinate of a place of the map (km east and north of the field's middle) in band b's tile. The shader's band().
 * A place beyond the outer texels' middles has theirs, as sampleField holds them out to the edge, so no bilinear mix reaches the next
 * tile. Cesium flips an image it uploads: the image's first row is the top of the texture.
 */
export function tileUv(band: number, eastKm: number, northKm: number): [number, number] {
  const inTile = (km: number): number => Math.min(FIELD_N - 1, Math.max(0, km / TEXEL_KM + (FIELD_N - 1) / 2)) + 0.5
  return [((band % 3) * FIELD_N + inTile(eastKm)) / ATLAS_W, 1 - (Math.floor(band / 3) * FIELD_N + inTile(northKm)) / ATLAS_H]
}

let noiseMade: Bitmap | null = null

/** A periodic volume of side n along each axis, twice as fine along the axis of stride `step`: the cubic B-spline through its values (smooth, no creases). */
function twice(v: Float32Array, dims: readonly [number, number, number], axis: 0 | 1 | 2): Float32Array {
  const out = [...dims] as [number, number, number]
  out[axis] *= 2
  const o = new Float32Array(out[0] * out[1] * out[2])
  const n = dims[axis]
  const at = (i: number[]): number => v[(i[2] * dims[1] + i[1]) * dims[0] + i[0]]
  const i = [0, 0, 0]
  for (let z = 0; z < out[2]; z++) {
    for (let y = 0; y < out[1]; y++) {
      for (let x = 0; x < out[0]; x++) {
        const k = [x, y, z]
        const j = k[axis] >> 1
        i[0] = x
        i[1] = y
        i[2] = z
        const tap = (d: number): number => {
          i[axis] = (j + d + n) % n
          return at(i)
        }
        // on a value's own place the spline weighs it and its neighbours 1 : 4 : 1; half-way between two, the four round 1 : 23 : 23 : 1
        o[(z * out[1] + y) * out[0] + x] = k[axis] % 2 === 0 ? (tap(-1) + 4 * tap(0) + tap(1)) / 6 : (tap(-1) + 23 * tap(0) + 23 * tap(1) + tap(2)) / 48
      }
    }
  }
  return o
}

/**
 * The noise the clouds are eroded by, the mock's: random values in a volume of 32³, smoothed twice over each texel's 27 neighbours
 * (round the volume's sides, so it tiles). Made twice as fine each way by a cubic spline (64³: the GPU's straight mix between texels
 * then follows a smooth curve, and no texel shows where the noise cuts a cloud's edge near the camera) and stretched over 0 … 255.
 * As an image: 8 × 8 tiles of 66 × 66, slice z at column z % 8 and row ⌊z / 8⌋, each with a rim of one texel from its far side so
 * that a bilinear mix at its edge wraps; R the slice's value, G the next slice's (so one read gives both to mix for the third axis).
 * The same every time (made once).
 */
export function noiseAtlas(): Bitmap {
  if (noiseMade !== null) return noiseMade
  const M = NOISE_M
  const r = sequence(NOISE_SEED)
  let v: Float32Array = Float32Array.from({ length: M * M * M }, r)
  const wrap = (i: number, n: number): number => (i + n) % n
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(M * M * M)
    for (let z = 0; z < M; z++) {
      for (let y = 0; y < M; y++) {
        for (let x = 0; x < M; x++) {
          let s = 0
          for (let c = -1; c <= 1; c++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) s += v[(wrap(z + c, M) * M + wrap(y + b, M)) * M + wrap(x + a, M)]
          o[(z * M + y) * M + x] = s / 27
        }
      }
    }
    v = o
  }
  v = twice(twice(twice(v, [M, M, M], 0), [2 * M, M, M], 1), [2 * M, 2 * M, M], 2)
  const N = NOISE_N
  let [lo, hi] = [1, 0]
  for (const x of v) [lo, hi] = [Math.min(lo, x), Math.max(hi, x)]
  const [width, height] = [NOISE_COLS * NOISE_TILE, NOISE_ROWS * NOISE_TILE]
  const data = new Uint8ClampedArray(width * height * 4)
  const byte = (z: number, y: number, x: number): number => ((v[(wrap(z, N) * N + wrap(y, N)) * N + wrap(x, N)] - lo) / (hi - lo)) * 255
  for (let z = 0; z < N; z++) {
    const [x0, y0] = [(z % NOISE_COLS) * NOISE_TILE + 1, Math.floor(z / NOISE_COLS) * NOISE_TILE + 1]
    for (let y = -1; y <= N; y++) {
      for (let x = -1; x <= N; x++) {
        const o = ((y0 + y) * width + x0 + x) * 4
        data[o] = byte(z, y, x)
        data[o + 1] = byte(z + 1, y, x)
        data[o + 3] = 255
      }
    }
  }
  return (noiseMade = { data, width, height })
}

/**
 * What the march asks of a field before it walks it: `near`, where each band has weather, coarsely (64 × 64 cells of 5 km, the first
 * row the south; 255 where the band has cover in the cell or in a cell beside it, else 0: where a bilinear read of it is 0 the band has
 * no weather within 7.2 km. R is the lowest layer band's, G the next one's, B the two high ones' together, A the towers'); and `wet`,
 * per band, whether rain falls from it (cover with a severity of light rain or more).
 */
export function survey(f: WxField): { near: Bitmap; wet: boolean[] } {
  const n = NEAR_N
  const per = FIELD_N / n
  const hit = new Uint8Array(n * n * 4)
  const wet = Array.from({ length: BANDS }, () => false)
  for (let b = 0; b < BANDS; b++) {
    if (f.lo[b] > f.hi[b]) continue
    const [cov, sev] = [f.cov[b], f.sev[b]]
    const channel = NEAR_CHANNEL[b]
    for (let j = 0; j < FIELD_N; j++) {
      const row = Math.floor(j / per) * n
      for (let i = 0; i < FIELD_N; i++) {
        const o = j * FIELD_N + i
        if (!(cov[o] > 0)) continue
        hit[(row + Math.floor(i / per)) * 4 + channel] = 1
        if (sev[o] >= 0.5) wet[b] = true
      }
    }
  }
  const data = new Uint8ClampedArray(n * n * 4)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        let any = 0
        for (let b = Math.max(0, j - 1); b <= Math.min(n - 1, j + 1); b++) for (let a = Math.max(0, i - 1); a <= Math.min(n - 1, i + 1); a++) any |= hit[(b * n + a) * 4 + c]
        data[(j * n + i) * 4 + c] = any * 255
      }
    }
  }
  return { near: { data, width: n, height: n }, wet }
}
const NEAR_CHANNEL: readonly number[] = [0, 1, 2, 2, 3] // the coarse map's channel for each band (the shader's nearOf)

/** Bytes as an image Cesium uploads as they are (an ImageData: no canvas, so nothing premultiplies them). Node has none: there the bytes stand in, for the tests. */
function image(b: Bitmap): unknown {
  return typeof ImageData === 'undefined' ? b : new ImageData(b.data as Uint8ClampedArray<ArrayBuffer>, b.width, b.height)
}

/**
 * What both shaders share: the frame's place on the map, the reach, and a band's texel. Lengths are km. Each shader declares the
 * uniforms these read (u_field, u_map, u_plane).
 */
const SHARED = `
const float INV_R = ${glsl(1 / R_KM)};
const float FIELD_N = ${glsl(FIELD_N)};
const float FIELD_KM = ${glsl(FIELD_KM)};
const vec2 ATLAS = vec2(${glsl(ATLAS_W)}, ${glsl(ATLAS_H)});
const float HEIGHT_MAX = ${glsl(HEIGHT_MAX_M / 1000)};

// A place of the frame as the field maps it: km east and north on its flat map, km above the sea (cloudVolume.ts localToMap).
vec3 toMap(vec3 p) {
  float h = p.z + dot(p.xy, p.xy) * (0.5 * INV_R);
  vec2 e = p.xy * (1.0 - h * INV_R);
  vec2 e2 = e * e;
  float t = u_map.z, c = INV_R * INV_R;
  float east = e.x * (1.0 + t * e.y + (t * t + 0.5 * c) * e2.y + (c / 6.0 - t * t / 3.0) * e2.x);
  float north = e.y - 0.5 * t * e2.x * (1.0 + t * e.y) + (c / 6.0) * e2.y * e.y;
  return vec3(u_map.x * east, u_map.y * north, h);
}

// How much of the field shows at a place of the map: all of it near the aircraft, none far from it or at the square's rim.
float reach(vec2 m) {
  vec2 a = abs(m);
  return (1.0 - smoothstep(${glsl(REACH_KM[0])}, ${glsl(REACH_KM[1])}, length(m - u_plane))) * (1.0 - smoothstep(${glsl(RIM_KM[0])}, ${glsl(RIM_KM[1])}, max(a.x, a.y)));
}

// Band b's texel at a place of the map, mixed from the four round it: cover, base and top (over HEIGHT_MAX), severity (over 3).
// The image's first row is the top of the texture (cloudVolume.ts tileUv).
vec4 band(int b, vec2 m) {
  vec2 c = clamp(m * (FIELD_N / FIELD_KM) + (FIELD_N - 1.0) * 0.5, 0.0, FIELD_N - 1.0) + 0.5;
  vec2 px = vec2(mod(float(b), 3.0), floor(float(b) / 3.0)) * FIELD_N + c;
  return textureLod(u_field, vec2(px.x / ATLAS.x, 1.0 - px.y / ATLAS.y), 0.0);
}
`

/**
 * The march (see the header). Its output is the weather's colour, premultiplied, and how much of the pixel it covers.
 */
export const MARCH_SHADER = `
uniform sampler2D depthTexture;
uniform sampler2D u_field; // wxField.ts fieldAtlas
uniform sampler2D u_noise; // noiseAtlas
uniform sampler2D u_near; // survey: where each band has weather, coarsely
uniform mat4 u_eyeToLocal; // eye metres to the frame, km
uniform mat4 u_noiseFrame; // the frame to the noise's own, fixed to the Earth, in periods of ${NOISE_KM} km
uniform vec3 u_map; // toMap's scale east and north, and tan(latitude) / R
uniform float u_lo[${BANDS}]; // each band's lowest base, km
uniform float u_hi[${BANDS}]; // and highest top
uniform float u_floor[${BANDS}]; // how low it is read: its lowest base, or the sea when rain falls from it
uniform float u_top; // the highest top of all
uniform vec2 u_plane; // the aircraft on the map: the reach is round it
uniform float u_look; // 0 natural, 1 severity colours, 2 blocks
uniform float u_light; // the Sun's brightness: 1 by day
in vec2 v_textureCoordinates;
${SHARED}
const vec3 HAZE = vec3(0.66, 0.76, 0.88); // the air's colour over a long way
const float GAIN = ${glsl(GAIN)};
const float CLEAR = ${glsl(CLEAR_KM)};
const float BOX = ${glsl(BOX_KM)};
const float PAD = 1.0; // the warp moves a sample's height by 0.9 km at most
const vec3 CELL = vec3(1.0, 1.0, 0.5); // blocks: a cell's size east, north and up

// The severity's colour: cloud, light rain, heavy rain, thunderstorm (#f2f5f8, #58a6ff, #ffbe3d, #ff4d3d).
vec3 sevCol(float s) {
  vec3 c0 = vec3(0.95, 0.96, 0.97), c1 = vec3(0.345, 0.65, 1.0), c2 = vec3(1.0, 0.745, 0.24), c3 = vec3(1.0, 0.3, 0.24);
  return s < 1.0 ? mix(c0, c1, s) : s < 2.0 ? mix(c1, c2, s - 1.0) : mix(c2, c3, clamp(s - 2.0, 0.0, 1.0));
}

// Extinction per km of full cloud: more in heavy rain and storms.
float sigma(float sev) { return sev > 1.5 ? ${glsl(SIGMA_STORM)} : ${glsl(SIGMA)}; }

// wxField.ts profile(): 0 … 1 across a band's cloud at height h, from base b to top t.
float prof(float h, float b, float t) {
  float d = t - b;
  if (d <= 0.0) return 0.0;
  float rise = min(${glsl(RISE)} * d, ${glsl(RISE_MAX_M / 1000)});
  float fall = min(${glsl(1 - FALL)} * d, ${glsl(FALL_MAX_M / 1000)});
  return smoothstep(0.0, rise, h - b) * (1.0 - smoothstep(t - fall, t, h));
}

// The coarse map's word for band b (survey): 0 where the band has no weather within 7 km.
float nearOf(vec4 nr, int b) { return b == 0 ? nr.r : b == 1 ? nr.g : b < 4 ? nr.b : nr.a; }

// What a ray may meet at a height h where the coarse map reads nr, climbing dh per km: 2, cloud (a band with weather near holds the
// height; pad: how far from h a sample may be read); 1, only rain (under such a band, when rain falls from it); 0, nothing.
// edge: how far along the ray the next band's heights begin (1e9: never).
int meets(vec4 nr, float h, float dh, float pad, out float edge) {
  edge = 1.0e9;
  int kind = 0;
  for (int b = 0; b < ${BANDS}; b++) {
    if (u_lo[b] > u_hi[b] || nearOf(nr, b) <= 0.0) continue;
    float lo = u_lo[b] - pad, hi = u_hi[b] + pad;
    if (h > hi) { if (dh < 0.0) edge = min(edge, (hi - h) / dh); }
    else if (h >= lo) kind = 2;
    else {
      float under = h >= u_floor[b] ? lo : min(u_floor[b], lo); // in its rain: the cloud is next; under its floor: the floor
      if (h >= u_floor[b] && kind < 1) kind = 1;
      if (dh > 0.0) edge = min(edge, (under - h) / dh);
    }
  }
  return kind;
}

// The field at a place of the map (wxField.ts sampleField): the most cloud any band has there, 0 … 1, and its severity. rain: under a
// band's cloud of light rain or more, how much rain falls there and its severity. nr: the coarse map there (a band with nothing near
// is not read).
float cover(vec3 m, vec4 nr, out float sev, out vec2 rain) {
  sev = 0.0;
  rain = vec2(0.0);
  if (abs(m.x) > 0.5 * FIELD_KM || abs(m.y) > 0.5 * FIELD_KM) return 0.0;
  float most = 0.0;
  for (int b = 0; b < ${BANDS}; b++) {
    if (m.z < u_floor[b] || m.z > u_hi[b] || nearOf(nr, b) <= 0.0) continue;
    vec4 f = band(b, m.xy);
    if (f.r <= 0.0) continue;
    float base = f.g * HEIGHT_MAX;
    if (m.z < base) {
      float r = f.r * smoothstep(0.5, 1.0, f.a * 3.0);
      if (r > rain.x) rain = vec2(r, f.a * 3.0);
      continue;
    }
    float d = f.r * prof(m.z, base, f.b * HEIGHT_MAX);
    if (d > most) { most = d; sev = f.a * 3.0; }
  }
  float k = reach(m.xy);
  rain.x *= k;
  return most * k;
}

// The cloud at a place of the frame, with no detail: what the light is dimmed by on its way.
float body(vec3 p, vec4 nr) {
  float s;
  vec2 r;
  return min(1.0, GAIN * cover(toMap(p), nr, s, r));
}

// The noise at q, in its periods: slice ⌊z⌋ and the next from one read (R and G), mixed; a tile's rim makes the read wrap.
float noise(vec3 q) {
  vec3 f = fract(q) * ${glsl(NOISE_N)};
  float z = min(floor(f.z), ${glsl(NOISE_N - 1)});
  vec2 px = vec2(mod(z, ${glsl(NOISE_COLS)}), floor(z / ${glsl(NOISE_COLS)})) * ${glsl(NOISE_TILE)} + 1.0 + f.xy;
  vec2 v = textureLod(u_noise, vec2(px.x / ${glsl(NOISE_COLS * NOISE_TILE)}, 1.0 - px.y / ${glsl(NOISE_ROWS * NOISE_TILE)}), 0.0).rg;
  return mix(v.r, v.g, f.z - z);
}

// Four octaves, of 32, 10.7, 4 and 1.4 km (the mock's, with a little more weight on the two fine ones: the field's small clouds are a
// few texels wide, and their edges are the noise's to draw).
float fbm(vec3 q) {
  return 0.42 * noise(q) + 0.27 * noise(q * 3.0) + 0.19 * noise(q * 8.0) + 0.12 * noise(q * 23.0);
}

// The place the field is read at for p: moved by up to 1.3 km each way, smoothly (over 16 km), so that a disc is not a disc, and by
// 0.22 km more over 4 km, so that the field's texels do not show in a small cloud's outline.
vec3 warp(vec3 p, vec3 q) {
  float a = noise(q * 2.0) - 0.5, b = noise(q * 2.0 + vec3(0.37, 0.11, 0.53)) - 0.5;
  float c = noise(q * 8.0 + vec3(0.71, 0.23, 0.47)) - 0.5, d = noise(q * 8.0 + vec3(0.19, 0.83, 0.61)) - 0.5;
  return p + vec3(a, b, 0.35 * (a + b)) * 2.6 + vec3(c, d, 0.0) * 0.45;
}

// Where along the ray its height over the sea is H: the two places (the height is a parabola along it), the nearer first; none:
// (1e9, −1e9). The roots the stable way: no cancellation in the shader's floats.
vec2 atHeight(vec3 ro, vec3 rd, float H) {
  float a = max(dot(rd.xy, rd.xy), 1.0e-9) * (0.5 * INV_R);
  float b = rd.z + dot(ro.xy, rd.xy) * INV_R;
  float c = ro.z + dot(ro.xy, ro.xy) * (0.5 * INV_R) - H;
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0) return vec2(1.0e9, -1.0e9);
  float q = -0.5 * (b + (b >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
  float r0 = q / a, r1 = q != 0.0 ? c / q : r0;
  return vec2(min(r0, r1), max(r0, r1));
}

// The rain's colour for the look: grey-blue, or its severity's.
vec3 rainCol(float sev) {
  vec3 c = vec3(0.5, 0.56, 0.66);
  return u_look < 0.5 ? c : u_look < 1.5 ? mix(c, sevCol(sev), 0.62) : sevCol(sev) * 0.85;
}

// The rain's streaks at a place of the frame, t km along the ray: shafts a few km wide, and thin upright lines in them near the
// camera (far off those would shimmer).
float streaks(vec3 p, float t) {
  float shaft = smoothstep(0.25, 0.75, noise(vec3(p.xy / 19.0, p.z / 60.0)));
  float line = smoothstep(0.3, 0.7, noise(vec3(p.xy / 3.2, p.z / 40.0)));
  return (0.25 + 1.5 * shaft) * mix(0.3 + 1.4 * line, 1.0, smoothstep(6.0, 18.0, t));
}

// How far a colour t km off has gone to the air's: by 63 % at 120 km (the mock's) in the natural look, at twice that where the colour is
// the severity's and has to be read from afar.
float hazed(float t) { return 1.0 - exp(-t / (u_look < 0.5 ? 120.0 : 240.0)); }

void main() {
  out_FragColor = vec4(0.0);
  float depth = texture(depthTexture, v_textureCoordinates).r;
  vec4 eye = czm_windowToEyeCoordinates(v_textureCoordinates * czm_viewport.zw + czm_viewport.xy, depth);
  vec3 pe = eye.xyz / eye.w;
  float tO = depth >= 1.0 ? 1.0e9 : length(pe) * 0.001; // km to what the pixel shows; the sky: none
  vec3 ro = u_eyeToLocal[3].xyz;
  vec3 rd = normalize(mat3(u_eyeToLocal) * pe);
  vec3 sun = normalize(mat3(u_eyeToLocal) * czm_lightDirectionEC);
  float pix = 2.0 / (czm_projection[1][1] * czm_viewport.w); // a march pixel, radians

  // The part of the ray worth walking: under the highest top, inside the square, short of what the pixel shows.
  vec2 top = atHeight(ro, rd, u_top + PAD);
  vec2 dir = vec2(abs(rd.x) < 1.0e-6 ? 1.0e-6 : rd.x, abs(rd.y) < 1.0e-6 ? 1.0e-6 : rd.y);
  vec2 ta = (-BOX - ro.xy) / dir, tb = (BOX - ro.xy) / dir;
  vec2 tn = min(ta, tb), tf = max(ta, tb);
  float tS = max(max(tn.x, tn.y), max(top.x, 0.0));
  float tEnd = min(min(tf.x, tf.y), min(top.y, tO));
  if (tS >= tEnd) return;

  // Each march pixel starts a share of a step further on than its neighbour, the four of a 2 × 2 block a quarter apart: the mix
  // lays the four together, so what one pixel's steps pass over the next one's find.
  ivec2 pq = ivec2(gl_FragCoord.xy) & 1;
  float phase = float((pq.x * 2 + pq.y * 3) & 3) * 0.25;

  vec3 col = vec3(0.0);
  float A = 0.0;
  float tauR = 0.0; // the rain passed so far: its veil never hides more than RAIN_MOST of what is behind it
  float mist = 0.0, mistSev = 0.0; // blocks: the length of the ray inside the body the camera is in, and its severity

  if (u_look < 1.5) {
    // Clouds as volumes. Where a band with weather near holds the ray's height it is searched in steps that cannot pass over a cloud
    // unseen for long; a step that lands in cloud goes back, the stretch before it is walked again in quarters, and the cloud's near
    // side is then found by halving the last quarter three times: the cloud is walked from its own edge, not from a step's place, so
    // its shading is smooth from pixel to pixel. (There too the four pixels of a block start a quarter of a small step apart: the
    // noise is finer than the steps, and their mean reads it four times as closely.) In cloud, where the noise has eaten it away, and
    // for a little way past it, the steps are small; smallest while little is hidden yet, where the light changes fast. A ray that
    // has used two fifths of its steps takes longer and longer ones (twenty times at the last), so that it ends coarser, not short.
    float t = tS + phase * max(0.12, ${glsl(SEARCH)} * tS);
    float tLast = t, fineTo = -1.0, walk = 0.03;
    float by = -1.0; // cloud was met short of here: no long steps yet (a cloud's edge is in folds, and long steps would catch some and not others)
    bool searched = false; // the last step was a search step
    bool edging = false; // walking back up to a cloud: its near side is still to find
    int used = 0; // steps taken, the halvings too
    for (int i = 0; i < ${STEPS}; i++) {
      if (t >= tEnd || A > 0.985 || used >= ${STEPS}) break;
      used++;
      float late = max(0.0, float(used) - ${glsl(STEPS * 0.4)}) / ${glsl(STEPS / 8)};
      float stretch = 1.0 + late * late;
      vec3 p = ro + rd * t;
      vec3 m = toMap(p);
      float dh = rd.z + dot(p.xy, rd.xy) * INV_R; // the ray's climb here, km per km
      vec4 nr = textureLod(u_near, vec2(m.x / FIELD_KM + 0.5, 0.5 - m.y / FIELD_KM), 0.0);
      float edge;
      int kind = meets(nr, m.z, dh, PAD, edge);
      if (kind == 0) { t += min(CLEAR, edge) + 2.0e-3; searched = false; continue; }
      vec3 q = (u_noiseFrame * vec4(p, 1.0)).xyz;
      float sev;
      vec2 rain;
      float dm = min(1.0, GAIN * cover(toMap(warp(p, q)), nr, sev, rain));
      float ds = max(0.03, min(0.018 * t, 0.1 + 0.6 * A)) * stretch;
      if (dm > 0.0) {
        if (searched && t > fineTo) { fineTo = t; walk = max(0.03, 0.25 * (t - tLast)); t = tLast + walk; searched = false; edging = true; continue; }
        searched = false;
        if (edging) {
          edging = false;
          float clear = tLast;
          for (int k = 0; k < 3; k++) {
            float mid = 0.5 * (clear + t);
            vec3 pm = ro + rd * mid;
            float s2;
            vec2 r2;
            if (cover(toMap(warp(pm, (u_noiseFrame * vec4(pm, 1.0)).xyz)), nr, s2, r2) > 0.0) t = mid;
            else clear = mid;
          }
          used += 3;
          t += phase * max(0.03, min(0.018 * t, 0.1)); // from the edge found, each of the four pixels its share of a step in
          continue;
        }
        by = t + ${glsl(STAY_KM)};
        float n = fbm(q);
        float d = clamp((dm - n * 0.74) / (1.0 - n * 0.74), 0.0, 1.0);
        if (d <= 0.01) ds = max(0.03, min(0.018 * t, 0.1)) * stretch; // eaten away by the noise here: steps that still find where it is not
        else {
          float sh = exp(-(body(p + sun * 0.45, nr) * 1.1 + body(p + sun * 1.3, nr) * 1.6));
          vec3 c = mix(vec3(0.36, 0.42, 0.52), vec3(1.0, 0.98, 0.95), sh);
          c *= sev < 1.5 ? mix(1.0, 0.86, sev) : mix(0.8, 0.6, clamp(sev - 2.0, 0.0, 1.0));
          if (u_look > 0.5) c = mix(c, sevCol(sev) * (0.7 + 0.3 * sh), 0.62 * smoothstep(0.3, 0.7, sev));
          c = mix(c, HAZE, hazed(t)) * u_light;
          float a = 1.0 - exp(-d * sigma(sev) * min(ds, tEnd - t));
          col += (1.0 - A) * a * c;
          A += (1.0 - A) * a;
        }
      } else {
        if (t < fineTo) { ds = walk; searched = false; edging = true; } // walking up to the cloud a search step found
        else if (t < by) { ds = max(0.03, min(0.018 * t, 0.1)) * stretch; searched = false; } // just out of cloud
        else if (kind == 2) { ds = min(max(0.12, ${glsl(SEARCH)} * t), max(0.12, ${glsl(SEARCH_UP_KM)} / max(abs(dh), 1.0e-4))) * stretch; searched = true; }
        else { ds = min(min(max(0.12, 0.07 * t), CLEAR), edge + 2.0e-3); searched = false; }
        if (rain.x > 0.0) {
          float tau = tauR + rain.x * streaks(p, t) * ${glsl(RAIN)} * sigma(rain.y) * min(ds, tEnd - t);
          float a = ${glsl(RAIN_MOST)} * (exp(-tauR) - exp(-tau));
          tauR = tau;
          col += (1.0 - A) * a * mix(rainCol(rain.y), HAZE, hazed(t)) * u_light;
          A += (1.0 - A) * a;
        }
      }
      tLast = t;
      t += ds;
    }
  } else {
    // Clouds as blocks: the sky in cells, walked cell by cell where a band with weather near holds the height. The ray's way through
    // the cells is worked out again in each (the map's heights curve with the Earth), so each step ends on the cell's far face.
    float t = tS;
    bool inBody = false;
    vec3 face = vec3(0.0, 0.0, rd.z < 0.0 ? 1.0 : -1.0); // the face the ray came in by: a top or a bottom at first
    float tB = -1.0, sevB = 0.0;
    vec3 mB = vec3(0.0);
    for (int i = 0; i < ${STEPS}; i++) {
      if (t >= tEnd) break;
      vec3 p = ro + rd * t;
      vec3 m = toMap(p);
      float dh = rd.z + dot(p.xy, rd.xy) * INV_R;
      vec4 nr = textureLod(u_near, vec2(m.x / FIELD_KM + 0.5, 0.5 - m.y / FIELD_KM), 0.0);
      float edge;
      int kind = meets(nr, m.z, dh, 0.5 * CELL.z, edge);
      float sev;
      vec2 rain;
      float adv;
      bool filled = false;
      if (kind < 2) {
        // nothing here, or only rain: on to the next band's heights, or as far as the coarse map vouches for
        adv = min(CLEAR, edge);
        if (kind == 1) { adv = min(adv, max(0.12, 0.07 * t)); cover(m, nr, sev, rain); }
        else rain = vec2(0.0);
        inBody = false;
        face = vec3(0.0, 0.0, dh < 0.0 ? 1.0 : -1.0);
      } else {
        vec3 cell = floor(m / CELL);
        filled = cover((cell + 0.5) * CELL, nr, sev, rain) > ${glsl(FILL)};
        if (i == 0 && filled && tS <= 0.0) { inBody = true; mistSev = sev; }
        if (filled && !inBody) { tB = t; sevB = sev; mB = m; break; }
        vec3 dm = vec3(u_map.xy * rd.xy, dh); // the ray's way on the map here
        vec3 sg = vec3(dm.x >= 0.0 ? 1.0 : -1.0, dm.y >= 0.0 ? 1.0 : -1.0, dm.z >= 0.0 ? 1.0 : -1.0);
        vec3 tM = ((cell + max(sg, 0.0)) * CELL - m) / (sg * max(abs(dm), vec3(1.0e-6)));
        if (tM.x < tM.y && tM.x < tM.z) { adv = tM.x; face = vec3(-sg.x, 0.0, 0.0); }
        else if (tM.y < tM.z) { adv = tM.y; face = vec3(0.0, -sg.y, 0.0); }
        else { adv = tM.z; face = vec3(0.0, 0.0, -sg.z); }
        if (inBody) {
          if (filled) mist = min(t + max(adv, 0.0), tEnd);
          else inBody = false;
        }
        if (filled) rain = vec2(0.0);
        adv = max(adv, 0.0);
      }
      if (rain.x > 0.0) {
        float tau = tauR + rain.x * ${glsl(RAIN)} * sigma(rain.y) * min(adv, tEnd - t);
        float a = ${glsl(RAIN_MOST)} * (exp(-tauR) - exp(-tau));
        tauR = tau;
        col += (1.0 - A) * a * mix(rainCol(rain.y), HAZE, hazed(t)) * u_light;
        A += (1.0 - A) * a;
      }
      t += adv + 2.0e-3; // 2 m into what is next
    }
    if (tB >= 0.0) {
      vec3 f = fract(mB / CELL);
      vec2 e = abs(face.x) > 0.5 ? f.yz : abs(face.y) > 0.5 ? f.xz : f.xy;
      vec2 de = min(e, 1.0 - e) * (abs(face.z) > 0.5 ? vec2(1.0) : vec2(1.0, 0.5));
      float lw = max(0.035, 1.5 * pix * tB);
      float line = 1.0 - smoothstep(lw * 0.5, lw, min(de.x, de.y));
      float shade = face.z > 0.5 ? 1.0 : face.z < -0.5 ? 0.55 : abs(face.x) > 0.5 ? 0.84 : 0.7;
      vec3 bc = sevB < 0.5 ? mix(vec3(0.6, 0.68, 0.8), vec3(0.96, 0.97, 0.98), shade) : sevCol(sevB) * shade;
      bc *= 1.0 - 0.22 * line;
      col += (1.0 - A) * mix(bc, HAZE, hazed(tB)) * u_light;
      A = 1.0;
    }
  }
  // From inside a block's body: its mist over everything, as thick as the cloud it stands for.
  float fogA = 1.0 - exp(-sigma(mistSev) * mist);
  vec3 fogC = (mistSev < 0.5 ? vec3(0.86, 0.89, 0.93) : sevCol(mistSev) * 0.85) * u_light;
  out_FragColor = vec4(mix(col, fogC, fogA), 1.0 - (1.0 - fogA) * (1.0 - A));
}
`

/**
 * The mix (see the header): the scene, the clouds' shadows on its ground, and the march over it.
 */
export const MIX_SHADER = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D u_march; // the march's output, at half the size
uniform sampler2D u_field;
uniform mat4 u_eyeToLocal;
uniform vec3 u_map;
uniform float u_lo[${BANDS}]; // each band's lowest base, km
uniform float u_hi[${BANDS}];
uniform vec2 u_plane;
uniform float u_shadow; // how dark full cover's shadow is: none by night
uniform float u_look; // 2: blocks
in vec2 v_textureCoordinates;
${SHARED}
void main() {
  vec4 scene = texture(colorTexture, v_textureCoordinates);
  float depth = texture(depthTexture, v_textureCoordinates).r;

  // The clouds' shadows on what is ground: each band's cover where the light's ray from here meets the band's lowest base.
  if (depth < 1.0 && u_shadow > 0.0) {
    vec4 eye = czm_windowToEyeCoordinates(v_textureCoordinates * czm_viewport.zw + czm_viewport.xy, depth);
    vec3 m = toMap((u_eyeToLocal * vec4(eye.xyz / eye.w, 1.0)).xyz);
    vec3 sun = normalize(mat3(u_eyeToLocal) * czm_lightDirectionEC);
    vec2 slope = sun.xy / max(sun.z, ${glsl(SHADOW_LOW)});
    float sh = 0.0;
    for (int b = 0; b < ${BANDS}; b++) {
      if (u_lo[b] > u_hi[b] || m.z >= u_lo[b]) continue;
      vec2 at = m.xy + slope * (u_lo[b] - m.z);
      if (abs(at.x) > 0.5 * FIELD_KM || abs(at.y) > 0.5 * FIELD_KM) continue;
      sh = max(sh, smoothstep(0.2, 0.8, band(b, at).r) * reach(at));
    }
    scene.rgb *= 1.0 - u_shadow * sh * smoothstep(0.03, 0.3, sun.z);
  }

  // The march, from half the size: the four march pixels round this one. For the volumes all four alike: they are the four starts of
  // the march's steps, and their mean is a march of four times the steps. For the blocks, whose march has no such starts, by their
  // nearness. Those that saw about the same depth as this pixel weigh most, so the aircraft's and the terrain's outlines stay sharp.
  float even = u_look < 1.5 ? 1.0 : 0.0;
  vec2 size = vec2(textureSize(u_march, 0));
  vec2 g = v_textureCoordinates * size - 0.5;
  vec2 i = floor(g), f = g - i;
  vec4 sum = vec4(0.0);
  float weights = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(float(k & 1), float(k >> 1));
    vec2 uv = (i + o + 0.5) / size;
    float dd = (texture(depthTexture, uv).r - depth) / ${glsl(DEPTH_SAME)};
    float w = mix((o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y), 0.25, even) / (1.0 + dd * dd);
    sum += w * texture(u_march, uv);
    weights += w;
  }
  vec4 cloud = sum / max(weights, 1.0e-9);
  out_FragColor = vec4(scene.rgb * (1.0 - cloud.a) + cloud.rgb, scene.a);
}
`

let passes = 0 // each pass's stages are named by its number: a stage's name is unique in the scene

/**
 * Draws the weather field as volumes. One pass in the scene while it is shown and its field has weather; none otherwise. The shader's
 * numbers are read from this each frame as Cesium draws (its uniforms are functions).
 */
export class CloudVolume {
  /** The look, read each frame: changing it costs nothing. */
  look: CloudLook = 'severity'
  readonly #stages: PostProcessStageCollection
  readonly #camera: Camera
  readonly #geoid: (lat: number, lon: number) => number
  readonly #frame = new Matrix4() // world metres to the field's frame
  readonly #eyeToLocal = new Matrix4()
  readonly #noiseFrame = new Matrix4()
  readonly #map = new Cartesian3()
  readonly #plane = new Cartesian2() // the aircraft on the field's map; the field's middle until fade() gives it
  readonly #local = new Cartesian3()
  #pass: PostProcessStageComposite | null = null
  #field: WxField | null = null
  #images: { field: unknown; near: unknown } | null = null // the field's, for a pass made when it is shown again
  #scale: MapScale = { sx: 1, sy: 1, t: 0 }
  #lo: number[] = []
  #hi: number[] = []
  #floor: number[] = []
  #top = 0
  #from: Cartesian3 | null = null // the aircraft as fade() gave it
  #light = 1
  #shadow = SHADOW
  #show = false
  #destroyed = false

  constructor(scene: { postProcessStages: PostProcessStageCollection; camera: Camera }, opts: { geoid?: (lat: number, lon: number) => number } = {}) {
    this.#stages = scene.postProcessStages
    this.#camera = scene.camera
    this.#geoid = opts.geoid ?? geoidN
  }

  get show(): boolean {
    return this.#show
  }

  set show(on: boolean) {
    if (this.#destroyed || on === this.#show) return
    this.#show = on
    this.#sync(false)
  }

  /** The field last built: what the pass draws, and what the HUD asks (wxField.ts sampleField). Null before the first draw. */
  get field(): WxField | null {
    return this.#field
  }

  /** These clouds in place of those drawn before: the field built round `at` (the aircraft), and a pass for it. */
  draw(specs: readonly CloudSpec[], at: { lat: number; lon: number }): void {
    if (this.#destroyed) return
    const f = buildField(specs, at.lat, at.lon)
    this.#field = f
    this.#images = null
    if (!f.empty) {
      const { near, wet } = survey(f)
      this.#images = { field: image(fieldAtlas(f)), near: image(near) }
      this.#lo = f.lo.map((m) => m / 1000)
      this.#hi = f.hi.map((m) => m / 1000)
      this.#floor = this.#lo.map((km, b) => (wet[b] ? 0 : km))
      this.#top = Math.max(...this.#hi)
      const seaM = this.#geoid(f.lat, f.lon)
      localFrame(f.lat, f.lon, seaM, this.#frame)
      this.#scale = mapScale(f.lat, f.lon, seaM)
      Cartesian3.fromElements(this.#scale.sx, this.#scale.sy, this.#scale.t, this.#map)
      this.#anchorNoise(f.lat, f.lon, seaM)
      this.#place()
    }
    this.#sync(true)
  }

  /** Every frame while the weather shows: the Sun's night. (The relief drawn is not followed: see the header.) */
  frame(_tf: TerrainFrame, night: number): void {
    const n = Number.isFinite(night) ? Math.min(1, Math.max(0, night)) : 0
    this.#light = sunBrightness(n)
    this.#shadow = SHADOW * (1 - n)
  }

  /** Each look: the aircraft, which the reach's fade is centred on. */
  fade(from: Cartesian3): void {
    if (this.#destroyed) return
    this.#from = Cartesian3.clone(from, this.#from ?? new Cartesian3())
    this.#place()
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#show = false
    this.#images = null
    this.#sync(false)
  }

  /** The pass in the scene when it should be, and not otherwise; `fresh`: the field is new, so a pass that stands is replaced. */
  #sync(fresh: boolean): void {
    const wanted = this.#show && !this.#destroyed && this.#images !== null
    if (this.#pass !== null && (!wanted || fresh)) {
      this.#stages.remove(this.#pass) // and destroys it
      this.#pass = null
    }
    if (wanted && this.#pass === null) this.#stages.add((this.#pass = this.#build(this.#images!)))
  }

  #build(images: { field: unknown; near: unknown }): PostProcessStageComposite {
    const n = ++passes
    const look = (): number => LOOK[this.look] ?? LOOK.severity
    const shared = {
      u_field: images.field,
      u_eyeToLocal: () => eyeToLocal(this.#camera.inverseViewMatrix, this.#frame, this.#eyeToLocal),
      u_map: () => this.#map,
      u_hi: () => this.#hi,
      u_plane: () => this.#plane,
    }
    const march = new PostProcessStage({
      name: `fh_cloud_march_${n}`, fragmentShader: MARCH_SHADER, textureScale: 0.5,
      uniforms: {
        ...shared, u_noise: image(noiseAtlas()), u_near: images.near, u_noiseFrame: () => this.#noiseFrame, u_lo: () => this.#lo, u_floor: () => this.#floor, u_top: () => this.#top,
        u_look: look, u_light: () => this.#light,
      },
    })
    const mix = new PostProcessStage({
      name: `fh_cloud_mix_${n}`, fragmentShader: MIX_SHADER,
      uniforms: { ...shared, u_march: march.name, u_lo: () => this.#lo, u_shadow: () => this.#shadow, u_look: look },
    })
    return new PostProcessStageComposite({ name: `fh_cloud_${n}`, stages: [march, mix], inputPreviousStageTexture: false })
  }

  /** The aircraft's place on the field's map. */
  #place(): void {
    if (this.#from === null || this.#field === null) return
    const l = Matrix4.multiplyByPoint(this.#frame, this.#from, this.#local)
    const [x, y] = localToMap(l.x, l.y, l.z, this.#scale)
    this.#plane.x = x
    this.#plane.y = y
  }

  /**
   * The frame to the noise's own: the Earth's axes, in periods of 32 km, the field's middle taken into the first period (in doubles).
   * Every octave is a whole fraction of 32 km, so a point of the Earth reads the same noise from any field's frame.
   */
  #anchorNoise(lat: number, lon: number, seaM: number): void {
    const n = Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, seaM))) // the frame's metres to the world's
    for (let c = 0; c < 12; c++) n[c] /= NOISE_KM // its axes: a km of the frame, in periods
    for (const c of [12, 13, 14]) {
      const periods = n[c] / 1000 / NOISE_KM // the field's middle
      n[c] = periods - Math.floor(periods)
    }
    Matrix4.fromArray(n, 0, this.#noiseFrame)
  }
}
