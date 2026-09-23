// client/scene/livery.ts
// Airline liveries on the 3-D models: a custom shader paints regions of the model (fuselage, belly, fin, engines) in
// the airline's colours from liveries.json and projects its logo decals onto the fin and the fuselage sides. Where the
// regions are comes from the model's manifest paint map. Airlines not in the table fly plain white. A scenario brings
// its own livery (liveryFromSpec: colours, a body-wrap decal, a fin logo) and can fold the wing tips in (u_span) and
// cut away a damaged fin and tail cone (u_cut) on models whose paint map measures them.
import { Cartesian3, Color, CustomShader, CustomShaderMode, TextureMinificationFilter, TextureUniform, UniformType, VaryingType } from 'cesium'
import { operatorOf } from '../../shared/airlines.ts'
import type { LiverySpec } from '../scenario/types.ts'
import type { Paint } from '../types.ts'
import table from './liveries.json' with { type: 'json' }

export interface LiveryEntry {
  base: string // sRGB hex; belly and engine default to it, fin2 to fin
  belly?: string
  fin: string
  fin2?: string
  engine?: string
  title?: boolean // public/liveries/<code>-title.png
  finLogo?: boolean // public/liveries/<code>-fin.png
}

/** A resolved livery. code keys the shader cache. Decal URLs: null = none (a blank texture). */
export interface Livery {
  code: string | null
  base: string
  belly: string
  fin: string
  fin2: string
  engine: string
  bodyUrl: string | null // body-wrap decal over Paint.body (scenarios only)
  finUrl: string | null
  titleUrl: string | null
}

export const TABLE = table as { aliases: Record<string, string>; liveries: Record<string, LiveryEntry>; logos: Record<string, string> }

export const WHITE: Livery = { code: null, base: '#f7f7f7', belly: '#f7f7f7', fin: '#f7f7f7', fin2: '#f7f7f7', engine: '#dfe3e8', bodyUrl: null, finUrl: null, titleUrl: null }

/** The livery a callsign flies in: its operator, or the brand a subsidiary or single-partner regional flies as; null (plain white) when not in the table. */
export function liveryCode(callsign: string | null): string | null {
  const op = operatorOf(callsign)
  if (op === null) return null
  const code = TABLE.aliases[op] ?? op
  return code in TABLE.liveries ? code : null
}

export function liveryOf(code: string | null): Livery {
  const l = code === null ? undefined : TABLE.liveries[code]
  if (l === undefined) return WHITE
  const base = `${import.meta.env?.BASE_URL ?? '/'}liveries/${code}`
  return {
    code, base: l.base, belly: l.belly ?? l.base, fin: l.fin, fin2: l.fin2 ?? l.fin, engine: l.engine ?? l.base,
    bodyUrl: null, finUrl: l.finLogo === true ? `${base}-fin.png` : null, titleUrl: l.title === true ? `${base}-title.png` : null,
  }
}

/**
 * A scenario's livery (scenario.json aircraft.livery). Decal paths are relative to the scenario folder `base` (ending
 * in '/'); present says which optional files the loader found (a missing fin logo is no error: the fin stays plain).
 * key must not be a table code (e.g. 'scenario:jal123').
 * ponytail: the paths are joined, not URL-resolved: the format gives plain relative paths. Upgrade: new URL(path, base)
 * if a package ever points outside its folder.
 */
export function liveryFromSpec(key: string, spec: LiverySpec, base: string, present: { body: boolean; finLogo: boolean }): Livery {
  const url = (path: string | undefined, found: boolean): string | null => (path === undefined || !found ? null : `${base}${path}`)
  return {
    code: key, base: spec.base, belly: spec.belly ?? spec.base, fin: spec.fin, fin2: spec.fin2 ?? spec.fin, engine: spec.engine ?? spec.base,
    bodyUrl: url(spec.body, present.body), finUrl: url(spec.finLogo, present.finLogo), titleUrl: url(spec.title, true),
  }
}

const f = (n: number): string => n.toFixed(3)

/**
 * The body wrap (scenarios-design §6.2): u runs nose → tail across the box, f top → bottom; the image's top half is
 * the left side (turned +x), its bottom half the right side, both nose at the left. uv.y grows towards the image top,
 * as in decal().
 */
function wrapText([zNose, zTail, yBottom, yTop]: NonNullable<Paint['body']>): string {
  return `
vec4 bodyWrap(sampler2D t, vec3 p) {
  float u = (${f(zNose)} - p.z) / ${f(zNose - zTail)};
  float f = (${f(yTop)} - p.y) / ${f(yTop - yBottom)};
  if (u < 0.0 || u > 1.0 || f < 0.0 || f > 1.0) return vec4(0.0);
  float row = p.x > 0.0 ? 0.5 * f : 0.5 + 0.5 * f;
  return texture(t, vec2(u, 1.0 - row));
}`
}

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
 * The fragment shader for one model's paint map. Colours and decals are uniforms, so every airline on a model shares
 * one GLSL program. The old texture survives only where it is near black (windows). Translucent parts (propeller
 * discs) keep their own look. Decals are side projections along x, flipped on one side so they read front to back.
 * The body wrap and the damage are compiled in only where the paint map measures them (body, cut).
 */
export function paintShaderText(p: Paint): string {
  const [ex0, ex1, ez0, ez1] = p.engines
  const [slope, zRef, below] = p.finSplit
  const [lz, ly, ls] = p.finLogo
  const [tz, ty, tw] = p.title
  return `
vec4 decal(sampler2D t, vec3 p, float z0, float y0, float w, float h) {
  vec2 uv = vec2((p.x > 0.0 ? -1.0 : 1.0) * (p.z - z0) / w + 0.5, (p.y - y0) / h + 0.5);
  return all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0))) ? texture(t, uv) : vec4(0.0);
}${p.body ? wrapText(p.body) : ''}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 turn = vec3(${p.noseMinusZ ? '-1.0, 1.0, -1.0' : '1.0'});
  vec3 p = fsInput.attributes.positionMC * turn;${p.cut ? cutText(p.cut, p.fin.halfWidth) : ''}
  if (material.alpha < 0.98) return;
  vec3 n = normalize(v_nMC) * turn;
  float lum = dot(material.diffuse, vec3(0.299, 0.587, 0.114));
  float detail = mix(0.2, 1.0, smoothstep(0.06, 0.14, lum));
  bool body = abs(p.x) < ${f(p.bodyHalfWidth)};
  bool fin = p.z < ${f(p.fin.behindZ)} && p.y > ${f(p.fin.aboveY)} && abs(p.x) < ${f(p.fin.halfWidth)};
  bool engine = abs(p.x) > ${f(ex0)} && abs(p.x) < ${f(ex1)} && p.z > ${f(ez0)} && p.z < ${f(ez1)} && abs(n.y) < 0.8;
  vec3 c = vec3(0.86, 0.88, 0.9);
  if (body) c = p.y < ${f(p.bellyBelowY)} ? u_belly : u_base;
  if (engine) c = u_engine;
  bool side = abs(n.x) > 0.3;
  if (fin) {
    c = (p.y - ${f(p.fin.aboveY)}) + ${f(slope)} * (p.z - ${f(zRef)}) < ${f(below)} ? u_fin2 : u_fin;
    if (side) { vec4 t = decal(u_finLogo, p, ${f(lz)}, ${f(ly)}, ${f(ls)}, ${f(ls)}); c = mix(c, t.rgb, t.a); }
  } else if (body) {${p.body ? `
    if (abs(n.x) > 0.2) { vec4 t = bodyWrap(u_body, p); c = mix(c, t.rgb, t.a); }` : ''}
    if (side) { vec4 t = decal(u_title, p, ${f(tz)}, ${f(ty)}, ${f(tw)}, ${f(tw / 4)}); c = mix(c, t.rgb, t.a); }
  }
  material.diffuse = czm_srgbToLinear(c) * detail;
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

const BLANK = new Uint8Array([0, 0, 0, 0])

const rgb = (hex: string): Cartesian3 => {
  const c = Color.fromCssColorString(hex)
  return new Cartesian3(c.red, c.green, c.blue)
}

const decal = (url: string | null): TextureUniform =>
  url === null
    ? new TextureUniform({ typedArray: BLANK, width: 1, height: 1 })
    : new TextureUniform({ url, repeat: false, minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR })

/**
 * One CustomShader per livery for one model's paint map, made on first use and shared by every model of that airline.
 * Every one declares u_body, u_span and u_cut (off), so ChaseModel can set them on whichever it draws.
 * ponytail: the cache keeps every livery seen for the session (≤ the table's ~40 + white + a scenario's). Upgrade:
 * evict if it grows.
 */
export class LiveryShaders {
  readonly #fragment: string
  readonly #vertex: string
  readonly #cache = new Map<string, CustomShader>()
  readonly #custom = new Map<string, CustomShader>()

  constructor(paint: Paint) {
    this.#fragment = paintShaderText(paint)
    this.#vertex = paintVertexText(paint)
  }

  for(code: string | null): CustomShader {
    const key = code ?? ''
    let s = this.#cache.get(key)
    if (s === undefined) {
      s = this.#make(liveryOf(code))
      this.#cache.set(key, s)
    }
    return s
  }

  /** A livery that is not in the table (a scenario's), cached by its code apart from the table's. */
  custom(livery: Livery): CustomShader {
    const key = livery.code ?? ''
    let s = this.#custom.get(key)
    if (s === undefined) {
      s = this.#make(livery)
      this.#custom.set(key, s)
    }
    return s
  }

  #make(l: Livery): CustomShader {
    return new CustomShader({
      mode: CustomShaderMode.MODIFY_MATERIAL,
      uniforms: {
        u_base: { type: UniformType.VEC3, value: rgb(l.base) },
        u_belly: { type: UniformType.VEC3, value: rgb(l.belly) },
        u_fin: { type: UniformType.VEC3, value: rgb(l.fin) },
        u_fin2: { type: UniformType.VEC3, value: rgb(l.fin2) },
        u_engine: { type: UniformType.VEC3, value: rgb(l.engine) },
        u_finLogo: { type: UniformType.SAMPLER_2D, value: decal(l.finUrl) },
        u_title: { type: UniformType.SAMPLER_2D, value: decal(l.titleUrl) },
        u_body: { type: UniformType.SAMPLER_2D, value: decal(l.bodyUrl) },
        u_span: { type: UniformType.FLOAT, value: 0 },
        u_cut: { type: UniformType.FLOAT, value: 0 },
      },
      varyings: { v_nMC: VaryingType.VEC3 },
      vertexShaderText: this.#vertex,
      fragmentShaderText: this.#fragment,
    })
  }
}
