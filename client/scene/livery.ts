// client/scene/livery.ts
// Airline liveries on the 3-D models (livery-pipeline-design.md): each airline's design (client/livery) is drawn onto
// the model's measured side profile as three atlases (the fuselage and fin, the nacelles, the wingtip devices), which a
// custom shader projects across the span; wings and tailplane take the design's flat colours. Airlines with only a
// colours entry in liveries.json get it drawn the old way (legacy.ts); airlines in neither fly plain white. A scenario
// brings its own livery (liveryFromSpec: colours, a body-wrap decal, a fin logo) and can fold the wing tips in (u_span)
// and cut away a damaged fin and tail cone (u_cut) on models whose paint map measures them.
import { Cartesian3, Cartesian4, Color, CustomShader, CustomShaderMode, TextureMinificationFilter, TextureUniform, UniformType, VaryingType } from 'cesium'
import { operatorOf } from '../../shared/airlines.ts'
import { DESIGNS } from '../livery/designs/index.ts'
import { WHITE as WHITE_HEX, WING, bellyHalf, profileOf, variantOf } from '../livery/kit.ts'
import type { Design, Target } from '../livery/kit.ts'
import { specDesign, tableDesign } from '../livery/legacy.ts'
import type { LiveryEntry } from '../livery/legacy.ts'
import { MARGIN, rasterize, sizesAt } from '../livery/raster.ts'
import type { Atlas } from '../livery/raster.ts'
import type { LiverySpec } from '../scenario/types.ts'
import type { ModelManifestEntry, ModelProfile, Paint } from '../types.ts'
import table from './liveries.json' with { type: 'json' }

export type { LiveryEntry }

/** A resolved livery: code keys the shader cache (null: plain white; "ELY~B": a design in one of its schemes). */
export interface Livery {
  code: string | null
  design: Design
  variant?: string | null
}

export const TABLE = table as { aliases: Record<string, string>; liveries: Record<string, LiveryEntry>; logos: Record<string, string> }

const WHITE_DESIGN: Design = { code: '', name: 'plain white', base: WHITE_HEX, engineColor: '#dfe3e8', side: (k) => k.fill(WHITE_HEX), engine: (k) => k.fill('#dfe3e8') }
export const WHITE: Livery = { code: null, design: WHITE_DESIGN }

const known = (code: string): boolean => code in DESIGNS || code in TABLE.liveries

/**
 * The livery a callsign flies in: its operator, or the brand a subsidiary or single-partner regional flies as; null
 * (plain white) when not in the table. Where the design has schemes by registration (Design.variants), "CODE~scheme".
 */
export function liveryCode(callsign: string | null, reg: string | null = null): string | null {
  const op = operatorOf(callsign)
  if (op === null) return null
  const code = TABLE.aliases[op] ?? op
  if (!known(code)) return null
  const d = DESIGNS[code]
  const v = d?.variants ? variantOf(d, reg) : null
  return v === null ? code : `${code}~${v}`
}

/** A code's design: drawn with the kit (designs/), else its colours entry, else plain white. "CODE~scheme" picks a scheme. */
export function liveryOf(key: string | null): Livery {
  if (key === null) return WHITE
  const [code, variant = null] = key.split('~')
  const d = DESIGNS[code]
  if (d !== undefined) return { code: key, design: d, variant }
  const l = TABLE.liveries[code]
  return l === undefined ? WHITE : { code, design: tableDesign(code, l, import.meta.env?.BASE_URL ?? '/') }
}

/**
 * A scenario's livery (scenario.json aircraft.livery). Decal paths are relative to the scenario folder `base` (ending
 * in '/'); present says which optional files the loader found (a missing fin logo is no error: the fin stays plain).
 * key must not be a table code (e.g. 'scenario:jal123').
 */
export function liveryFromSpec(key: string, spec: LiverySpec, base: string, present: { body: boolean; finLogo: boolean }): Livery {
  return { code: key, design: specDesign(key, spec, base, present) }
}

const f = (n: number): string => n.toFixed(3)

/**
 * The damage (scenarios-design §6.3), in the turned frame. The fin goes above a jagged line at finKeepY and, below it,
 * in the aft rudderFrac of its local chord (edges interpolated through the two measured heights); the fuselage goes
 * aft of tailConeZ. Back faces, seen through the holes, are drawn dark.
 */
function cutText(c: NonNullable<Paint['cut']>, finHalfWidth: number): string {
  const [y0, le0, te0, y1, le1, te1] = c.finEdges
  return `
  if (u_cut > 0.5) {
    if (abs(p.x) < ${f(finHalfWidth)}) {
      float k = (p.y - ${f(y0)}) / ${f(y1 - y0)};
      float le = mix(${f(le0)}, ${f(le1)}, k);
      float te = mix(${f(te0)}, ${f(te1)}, k);
      float jag = 0.6 * (abs(fract(p.z * 0.8) - 0.5) * 4.0 - 1.0) + 0.4 * (abs(fract(p.z * 2.3 + 0.37) - 0.5) * 4.0 - 1.0);
      if (p.y > ${f(c.finKeepY)} + 0.35 * jag) discard;
      if (p.y > ${f(y0)} && p.z < te + ${f(c.rudderFrac)} * (le - te)) discard;
    }
    if (p.z < ${f(c.tailConeZ)} && abs(p.x) < ${f(c.tailHalfWidth)}) discard;
    if (czm_backFacing()) { material.diffuse = vec3(0.04); return; }
  }`
}

/**
 * The cabin window row (the paint map's windows, turned frame), 0…1 on the skin: rounded windows 0.45 pitch wide and
 * 0.34 m tall (taller with a wider pitch), antialiased by the skin's footprint in a pixel, and, once a window is
 * smaller than a few pixels, its average share of the row instead of shimmering. Only on skin facing sideways.
 */
function windowsText([y, zAft, zFore, pitch]: NonNullable<Paint['windows']>): string {
  const hh = 0.17 * Math.min(1.4, Math.max(1, pitch / 0.51))
  return `
float windowRow(vec3 p, vec3 n) {
  if (abs(n.x) < 0.35 || p.z < ${f(zAft)} || p.z > ${f(zFore)}) return 0.0;
  float px = max(max(fwidth(p.z), fwidth(p.y)), 1e-4);
  vec2 hs = vec2(${f(0.225 * pitch)}, ${f(hh)});
  vec2 q = vec2(abs(fract((p.z - ${f(zAft)}) / ${f(pitch)}) - 0.5) * ${f(pitch)}, abs(p.y - ${f(y)}));
  float d = length(max(q - hs + 0.07, 0.0)) - 0.07;
  float one = 1.0 - smoothstep(-px, px, d);
  float row = (1.0 - smoothstep(hs.y - px, hs.y + px, q.y)) * ${f((2 * 0.225 * pitch) / pitch)};
  return mix(one, row, smoothstep(0.08, 0.25, px / ${f(pitch)}));
}`
}

/**
 * GLSL shared by every paint shader: a lamp on the aircraft's own skin, and how far below 10,000 ft a fragment is.
 * lamp: l.xyz a light's place in the mesh frame, l.w its strength (0: off); about full strength within reach (mesh
 * units), then falling off with the square of distance, brighter on skin facing it. low: 1 below 8,000 ft, 0 above
 * 10,000 ft, from the fragment's height above the ellipsoid (|p|·(1 − 1/|p/radii|), exact to ~1 m at these heights).
 */
const LIGHTING_GLSL = `
vec3 lamp(vec4 l, vec3 color, float reach, vec3 q, vec3 nq) {
  if (l.w <= 0.0) return vec3(0.0);
  vec3 d = l.xyz - q;
  float dd = dot(d, d);
  float facing = 0.3 + 0.7 * max(0.0, dot(nq, d) * inversesqrt(dd + 1e-4));
  return color * (l.w * facing * reach * reach / (dd + reach * reach));
}
float lowAltitude(vec3 wc) {
  float h = length(wc) * (1.0 - 1.0 / length(wc * czm_ellipsoidInverseRadii));
  return 1.0 - smoothstep(2438.4, 3048.0, h);
}`

/**
 * GLSL that samples one atlas (raster.ts) over a side box [zMin, zMax, yMin, yMax]: the half by `left` (seen from the
 * left: top half), the row inside the half's margins, u from the nose at the left.
 */
function atlasText(name: string, [zMin, zMax, yMin, yMax]: [number, number, number, number], height: number): string {
  const half = height / 2
  return `
vec3 ${name}At(vec3 p, bool left) {
  float u = clamp((${f(zMax)} - p.z) / ${f(zMax - zMin)}, 0.0, 1.0);
  float r = clamp((${f(yMax)} - p.y) / ${f(yMax - yMin)}, 0.0, 1.0);
  return texture(u_${name}, vec2(u, (left ? 0.0 : ${f(half)}) / ${f(height)} + (${f(MARGIN)} + r * ${f(half - 2 * MARGIN)}) / ${f(height)})).rgb;
}`
}

/** GLSL that samples the belly atlas (premultiplied) in plan view over [zMin, zMax] × ±half, the left wing at the top. */
function bellyText([zMin, zMax]: [number, number, number, number], half: number, height: number): string {
  return `
vec4 bellyAt(vec3 p) {
  float u = clamp((${f(zMax)} - p.z) / ${f(zMax - zMin)}, 0.0, 1.0);
  float r = clamp((${f(half)} - p.x) / ${f(2 * half)}, 0.0, 1.0);
  return texture(u_belly, vec2(u, (${f(MARGIN)} + r * ${f(height - 2 * MARGIN)}) / ${f(height)}));
}`
}

/**
 * The fragment shader for one model's paint map and profile. The airline's paint is in the atlases (uniforms), so every
 * airline on a model shares one GLSL program. The fuselage and fin take the skin atlas by position (x > 0: the left
 * side), nacelles theirs by the facing (the outboard face of the left engine faces +x), wingtip devices theirs by
 * outboard or inboard face (the winglet atlas's "left" half paints both outboard faces, its "right" half both inboard
 * faces: winglets are painted differently inside and out, the same on both wings). The old
 * texture survives only where it is near black (windows). Translucent parts (propeller discs) keep their own look. The
 * damage is compiled in only where the paint map measures it (cut).
 * The finish: glossy paint, semi-gloss grey wings and tailplane, dark glass in the windows; where the model reflects
 * its own sky map (u_env: the chased aircraft), bare-metal wing leading edges and polished engine inlet lips. By night
 * (u_night) the cabin windows glow warm and, below 10,000 ft, the logo lights on the tailplane light the fin. The
 * chased aircraft's own lamps (aircraftLights.ts) light its skin: position lights, strobe flashes and beacons.
 */
export function paintShaderText(p: Paint, prof: ModelProfile, detail = 1): string {
  const size = sizesAt(detail)
  const [ex0, ex1, ez0, ez1] = p.engines
  const [, ty, tw] = p.title
  const finH = Math.max(0.5, 2 * (p.finLogo[1] - p.fin.aboveY)) // the fin's height, about twice its logo's centre above its root
  const e = prof.engines
  const w = prof.winglet
  const engineTest = e
    // in the nacelle box: everything but the wing's lower skin over it (facing down, in the box's upper part)
    ? `abs(p.x) > ${f(e[0])} && abs(p.x) < ${f(e[1])} && p.z > ${f(e[2])} && p.z < ${f(e[3])} && p.y > ${f(e[4])} && p.y < ${f(e[5])} && (n.y > -0.8 || p.y < ${f(e[4] + 0.6 * (e[5] - e[4]))})`
    : `abs(p.x) > ${f(ex0)} && abs(p.x) < ${f(ex1)} && p.z > ${f(ez0)} && p.z < ${f(ez1)} && abs(n.y) < 0.8`
  return `${atlasText('skin', prof.box, size.skin[1])}${bellyText(prof.box, bellyHalf(p), size.belly[1])}${e ? atlasText('nacelle', [e[2], e[3], e[4], e[5]], size.nacelle[1]) : ''}${w ? atlasText('tip', [w[2], w[3], w[4], w[5]], size.tip[1]) : ''}${LIGHTING_GLSL}${p.windows ? windowsText(p.windows) : ''}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 turn = vec3(${p.noseMinusZ ? '-1.0, 1.0, -1.0' : '1.0'});
  vec3 p = fsInput.attributes.positionMC * turn;${p.cut ? cutText(p.cut, p.fin.halfWidth) : ''}
  if (material.alpha < 0.98) return;
  vec3 n = normalize(v_nMC) * turn;
  float lum = dot(material.diffuse, vec3(0.299, 0.587, 0.114));
  float detail = mix(0.2, 1.0, smoothstep(0.06, 0.14, lum));
  bool body = abs(p.x) < ${f(p.bodyHalfWidth)};
  bool fin = p.z < ${f(p.fin.behindZ)} && p.y > ${f(p.fin.aboveY)} && abs(p.x) < ${f(p.fin.halfWidth)};
  bool engine = ${engineTest};
  bool tip = ${w ? `!body && !fin && !engine && abs(p.x) > ${f(w[0])} && abs(p.x) < ${f(w[1])} && p.z > ${f(w[2])} && p.z < ${f(w[3])} && p.y > ${f(w[4])} && p.y < ${f(w[5])}` : 'false'};
  vec3 c = ${prof.stab ? `p.z < ${f(prof.stab[1])} && abs(p.x) < ${f(prof.stab[2] + 0.3)} ? u_stab : u_wing` : 'u_wing'};
  if (body || fin) c = skinAt(p, p.x > 0.0);
  if (body && !fin && n.y < -0.3) { // markings seen from below, on the skin that faces down
    vec4 b = bellyAt(p);
    float down = smoothstep(0.3, 0.6, -n.y) * b.a;
    c = c * (1.0 - down) + b.rgb * smoothstep(0.3, 0.6, -n.y);
  }${e ? `
  if (engine) c = nacelleAt(p, n.x > 0.0);` : `
  if (engine) c = u_engine;`}${w ? `
  if (tip) c = tipAt(p, (n.x > 0.0) == (p.x > 0.0));` : ''}
  bool side = abs(n.x) > 0.3;
  vec3 albedo = czm_srgbToLinear(c) * detail;
  bool wing = !body && !fin && !engine && !tip;
  float ahead = smoothstep(0.55, 0.85, n.z); // facing forward: a leading edge, an inlet lip
  float metal = u_env * ahead * (engine ? 1.0 : wing ? 0.85 : 0.0);
  float cabin = body && !fin ? ${p.windows ? 'windowRow(p, n)' : `(abs(n.x) > 0.5 && p.y > ${f(p.bellyBelowY)} && p.y < ${f(ty + tw / 8)} ? 1.0 - smoothstep(0.035, 0.1, lum) : 0.0)`} : 0.0;
  float glass = max(cabin, body ? 1.0 - smoothstep(0.035, 0.1, lum) : 0.0);
  albedo = mix(albedo, vec3(0.012), glass);
  material.diffuse = albedo * (1.0 - metal);
  material.specular = mix(vec3(0.04), albedo, metal);
  material.roughness = mix(wing ? mix(0.46, 0.3, ahead) : engine ? mix(0.3, 0.2, ahead) : 0.24, 0.08, glass);
  vec3 glow = vec3(0.0);
  if (u_night > 0.0) {
    float low = lowAltitude(fsInput.attributes.positionWC);
    glow += vec3(1.0, 0.76, 0.48) * cabin * (1.3 - 0.6 * low); // the cabin is dimmed for take-off and landing
    if (fin && side) glow += albedo * vec3(1.0, 0.95, 0.86) * (1.6 - 1.2 * clamp((p.y - ${f(p.fin.aboveY)}) / ${f(finH)}, 0.0, 1.0)) * low;
    glow *= u_night;
  }
  vec3 q = fsInput.attributes.positionMC;
  vec3 nq = normalize(v_nMC);
  glow += albedo * (lamp(u_navL, vec3(1.0, 0.1, 0.06), 2.5, q, nq) + lamp(u_navR, vec3(0.08, 1.0, 0.4), 2.5, q, nq)
    + lamp(u_navT, vec3(1.0, 0.94, 0.85), 2.0, q, nq) + lamp(u_bcn0, vec3(1.0, 0.06, 0.03), 2.5, q, nq)
    + lamp(u_bcn1, vec3(1.0, 0.06, 0.03), 2.5, q, nq));
  // A strobe flash lights its wing and the skin near it, not the whole airframe evenly.
  if (u_strobe > 0.0) glow += albedo * u_strobe * (lamp(vec4(u_navL.xyz, 1.0), vec3(1.8), 4.0, q, nq)
    + lamp(vec4(u_navR.xyz, 1.0), vec3(1.8), 4.0, q, nq) + lamp(vec4(u_navT.xyz, 1.0), vec3(1.8), 3.5, q, nq));
  material.emissive += glow;
}`
}

/**
 * The vertex shader: passes the normal on and, where the paint map knows the wing plane at the tip (wingTipY), folds
 * every vertex outboard of u_span (mesh metres; 0 = off) in to it and down onto that plane: the tips and winglets
 * collapse into a closed, shorter tip. The mesh frame's x is the span in both nose conventions.
 */
export function paintVertexText(p: Paint): string {
  const fold = p.wingTipY === undefined ? '' : `
  vec3 q = vsInput.attributes.positionMC;
  if (u_span > 0.0 && abs(q.x) > u_span) { q.x = sign(q.x) * u_span; q.y = min(q.y, ${f(p.wingTipY)}); vsOutput.positionMC = q; }`
  return `void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
  v_nMC = vsInput.attributes.normalMC;${fold}
}`
}

const rgb = (hex: string): Cartesian3 => {
  const c = Color.fromCssColorString(hex)
  return new Cartesian3(c.red, c.green, c.blue)
}

/** A 1×1 texture of one colour: the atlas until the design is drawn. */
const flat = (hex: string): TextureUniform => {
  const c = Color.fromCssColorString(hex)
  return new TextureUniform({ typedArray: new Uint8Array(c.toBytes()), width: 1, height: 1 })
}

const texture = (a: Atlas): TextureUniform =>
  new TextureUniform({ typedArray: a.data, width: a.width, height: a.height, repeat: false, minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR })

/** Every paint shader made, for setNight. They live as long as their LiveryShaders caches: the session. */
const made = new Set<CustomShader>()
let nightNow = 0

/** Atlases are drawn one at a time, a task apart, so a burst of new traffic does not stall a frame. */
let queue: Promise<unknown> = Promise.resolve()
const later = (job: () => Promise<void>): void => {
  queue = queue.then(job).catch((err: unknown) => console.warn('FlightHopper: livery not drawn:', err)).then(() => new Promise((r) => setTimeout(r, 0)))
}

/**
 * One CustomShader per livery for one model, made on first use and shared by every model of that airline and type.
 * It starts in the design's flat colours and takes its atlases once raster.ts has drawn them (browser only). Every
 * shader declares u_span and u_cut (off), so ChaseModel can set them on whichever it draws, and the lights' uniforms
 * (aircraftLights.ts sets them on the chased aircraft's): u_env, u_navL, u_navR, u_navT, u_bcn0, u_bcn1 and u_strobe,
 * all off. u_night is every shader's at once (setNight).
 * detail: the atlases' resolution, 1 for the chased aircraft, 0.5 for traffic (sizesAt).
 * ponytail: the cache keeps every livery seen for the session (≤ the table's ~40 + white + a scenario's, per type):
 * ~12 MB of GPU memory per livery and type at detail 1, ~3 MB at 0.5. Upgrade: evict, and destroy the atlases, if it grows.
 */
export class LiveryShaders {
  /** The night on every paint shader (0 day … 1 night: the cabin windows and the logo lights). Cheap when unchanged. */
  static setNight(night: number): void {
    const n = Number.isFinite(night) ? Math.min(1, Math.max(0, night)) : 0
    if (Math.abs(n - nightNow) < 0.002 && (n === 0) === (nightNow === 0)) return
    nightNow = n
    for (const s of made) s.setUniform('u_night', n)
  }

  /** Resolves once every atlas asked for so far is drawn and handed to its shader (the livery lab waits on it). */
  static idle(): Promise<unknown> {
    return queue
  }

  readonly #target: Target
  readonly #detail: number
  readonly #fragment: string
  readonly #vertex: string
  readonly #cache = new Map<string, CustomShader>()
  readonly #custom = new Map<string, CustomShader>()

  constructor(m: ModelManifestEntry, detail = 1) {
    const paint = m.paint
    const profile = profileOf(m)
    if (paint === undefined || profile === null) throw new Error(`${m.id}: no paint map`)
    this.#target = { id: m.id, profile, paint }
    this.#detail = detail
    this.#fragment = paintShaderText(paint, profile, detail)
    this.#vertex = paintVertexText(paint)
  }

  for(code: string | null): CustomShader {
    const key = code ?? ''
    let s = this.#cache.get(key)
    if (s === undefined) {
      const l = liveryOf(code)
      s = this.#make(l.design, l.variant ?? null)
      this.#cache.set(key, s)
    }
    return s
  }

  /** A livery that is not in the table (a scenario's), cached by its code apart from the table's. */
  custom(livery: Livery): CustomShader {
    const key = livery.code ?? ''
    let s = this.#custom.get(key)
    if (s === undefined) {
      s = this.#make(livery.design, livery.variant ?? null)
      this.#custom.set(key, s)
    }
    return s
  }

  #make(d: Design, variant: string | null): CustomShader {
    const off = (): { type: UniformType; value: Cartesian4 } => ({ type: UniformType.VEC4, value: new Cartesian4() })
    const p = this.#target.profile
    const s = new CustomShader({
      mode: CustomShaderMode.MODIFY_MATERIAL,
      uniforms: {
        u_skin: { type: UniformType.SAMPLER_2D, value: flat(d.base ?? WHITE_HEX) },
        u_belly: { type: UniformType.SAMPLER_2D, value: new TextureUniform({ typedArray: new Uint8Array(4), width: 1, height: 1 }) }, // none: transparent
        ...(p.engines ? { u_nacelle: { type: UniformType.SAMPLER_2D, value: flat(d.engineColor ?? d.base ?? WHITE_HEX) } } : { u_engine: { type: UniformType.VEC3, value: rgb(d.engineColor ?? d.base ?? WHITE_HEX) } }),
        ...(p.winglet ? { u_tip: { type: UniformType.SAMPLER_2D, value: flat(d.wingletColor ?? d.wing ?? WING) } } : {}),
        u_wing: { type: UniformType.VEC3, value: rgb(d.wing ?? WING) },
        u_stab: { type: UniformType.VEC3, value: rgb(d.stab ?? d.wing ?? WING) },
        u_span: { type: UniformType.FLOAT, value: 0 },
        u_cut: { type: UniformType.FLOAT, value: 0 },
        u_night: { type: UniformType.FLOAT, value: nightNow },
        u_env: { type: UniformType.FLOAT, value: 0 },
        u_navL: off(), u_navR: off(), u_navT: off(), u_bcn0: off(), u_bcn1: off(),
        u_strobe: { type: UniformType.FLOAT, value: 0 },
      },
      varyings: { v_nMC: VaryingType.VEC3 },
      vertexShaderText: this.#vertex,
      fragmentShaderText: this.#fragment,
    })
    made.add(s)
    if (typeof document !== 'undefined') {
      later(async () => {
        const a = await rasterize(d, this.#target, this.#detail, variant)
        s.setUniform('u_skin', texture(a.skin))
        if (a.nacelle && p.engines) s.setUniform('u_nacelle', texture(a.nacelle))
        if (a.tip && p.winglet) s.setUniform('u_tip', texture(a.tip))
        if (a.belly) s.setUniform('u_belly', texture(a.belly))
      })
    }
    return s
  }
}
