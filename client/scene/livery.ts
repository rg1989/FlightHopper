// client/scene/livery.ts
// Airline liveries on the 3-D models: a custom shader paints regions of the model (fuselage, belly, fin, engines) in
// the airline's colours from liveries.json and projects its logo decals onto the fin and the fuselage sides. Where the
// regions are comes from the model's manifest paint map. Airlines not in the table fly plain white.
import { Cartesian3, Color, CustomShader, CustomShaderMode, TextureMinificationFilter, TextureUniform, UniformType, VaryingType } from 'cesium'
import { operatorOf } from '../../shared/airlines.ts'
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

export interface Livery { code: string | null; base: string; belly: string; fin: string; fin2: string; engine: string; title: boolean; finLogo: boolean }

export const TABLE = table as { aliases: Record<string, string>; liveries: Record<string, LiveryEntry>; logos: Record<string, string> }

export const WHITE: Livery = { code: null, base: '#f7f7f7', belly: '#f7f7f7', fin: '#f7f7f7', fin2: '#f7f7f7', engine: '#dfe3e8', title: false, finLogo: false }

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
  return { code, base: l.base, belly: l.belly ?? l.base, fin: l.fin, fin2: l.fin2 ?? l.fin, engine: l.engine ?? l.base, title: l.title === true, finLogo: l.finLogo === true }
}

const f = (n: number): string => n.toFixed(3)

/**
 * The fragment shader for one model's paint map. Colours and decals are uniforms, so every airline on a model shares
 * one GLSL program. The old texture survives only where it is near black (windows). Translucent parts (propeller
 * discs) keep their own look. Decals are side projections along x, flipped on one side so they read front to back.
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
}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  if (material.alpha < 0.98) return;
  vec3 p = fsInput.attributes.positionMC;
  vec3 n = normalize(v_nMC);
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
  } else if (body && side) {
    vec4 t = decal(u_title, p, ${f(tz)}, ${f(ty)}, ${f(tw)}, ${f(tw / 4)}); c = mix(c, t.rgb, t.a);
  }
  material.diffuse = czm_srgbToLinear(c) * detail;
}`
}

const VERTEX = 'void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) { v_nMC = vsInput.attributes.normalMC; }'
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
 * ponytail: the cache keeps every livery seen for the session (≤ the table's ~40 + white). Upgrade: evict if it grows.
 */
export class LiveryShaders {
  readonly #text: string
  readonly #cache = new Map<string, CustomShader>()

  constructor(paint: Paint) {
    this.#text = paintShaderText(paint)
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

  #make(l: Livery): CustomShader {
    const base = `${import.meta.env?.BASE_URL ?? '/'}liveries/${l.code}`
    return new CustomShader({
      mode: CustomShaderMode.MODIFY_MATERIAL,
      uniforms: {
        u_base: { type: UniformType.VEC3, value: rgb(l.base) },
        u_belly: { type: UniformType.VEC3, value: rgb(l.belly) },
        u_fin: { type: UniformType.VEC3, value: rgb(l.fin) },
        u_fin2: { type: UniformType.VEC3, value: rgb(l.fin2) },
        u_engine: { type: UniformType.VEC3, value: rgb(l.engine) },
        u_finLogo: { type: UniformType.SAMPLER_2D, value: decal(l.finLogo ? `${base}-fin.png` : null) },
        u_title: { type: UniformType.SAMPLER_2D, value: decal(l.title ? `${base}-title.png` : null) },
      },
      varyings: { v_nMC: VaryingType.VEC3 },
      vertexShaderText: VERTEX,
      fragmentShaderText: this.#text,
    })
  }
}
