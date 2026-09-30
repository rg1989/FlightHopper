// client/livery/legacy.ts
// The colours-only liveries of liveries.json and a scenario's LiverySpec, as designs: the flat regions the old shader
// painted (base, belly below the paint map's line, fin, fin2 under its slanted split, engines) and the title and fin
// logo decals at the paint map's boxes. So every livery takes the one atlas path.
import type { LiverySpec } from '../scenario/types.ts'
import type { Design, Kit } from './kit.ts'

export interface LiveryEntry {
  base: string // sRGB hex; belly and engine default to it, fin2 to fin
  belly?: string
  fin: string
  fin2?: string
  engine?: string
  wing?: string // wings and tailplane (default: the kit's light grey)
  title?: boolean // public/liveries/<code>-title.png
  finLogo?: boolean // public/liveries/<code>-fin.png
}

/** The flat colours and decal URLs of an old-style livery. Decals: null = none. */
export interface Flat {
  base: string
  belly: string
  fin: string
  fin2: string
  engine: string
  finUrl: string | null
  titleUrl: string | null
  bodyUrl: string | null // a scenario's body wrap over Paint.body
  wing?: string
}

const FAR = 200 // metres: past any model's box

/** The old shader's regions, drawn on one side. Needs the model's paint map (k.paint). */
export function drawFlat(k: Kit, f: Flat): void {
  const P = k.paint
  k.fill(f.base)
  if (P === undefined) return
  const [zMin, zMax, , yMax] = k.a.box
  k.poly([[zMax + FAR, P.bellyBelowY], [zMin - FAR, P.bellyBelowY], [zMin - FAR, -FAR], [zMax + FAR, -FAR]], f.belly)
  if (f.bodyUrl !== null && P.body) k.wrap(f.bodyUrl, P.body)
  const { behindZ, aboveY } = P.fin
  const top = yMax + FAR
  const aft = zMin - FAR
  k.poly([[behindZ, aboveY], [behindZ, top], [aft, top], [aft, aboveY]], f.fin)
  // fin2 where (y − aboveY) + slope·(z − zRef) < below: under a line that falls towards the nose
  const [slope, zRef, below] = P.finSplit
  const split = (z: number): number => Math.max(aboveY, aboveY + below - slope * (z - zRef))
  if (f.fin2 !== f.fin) k.poly([[behindZ, aboveY], [behindZ, split(behindZ)], [aft, split(aft)], [aft, aboveY]], f.fin2)
  const [lz, ly, ls] = P.finLogo
  if (f.finUrl !== null) k.image(f.finUrl, { z: lz, y: ly, w: ls, h: ls })
  const [tz, ty, tw] = P.title
  if (f.titleUrl !== null) k.image(f.titleUrl, { z: tz, y: ty, w: tw, h: tw / 4 })
}

export function flatDesign(code: string, name: string, f: Flat): Design {
  return {
    code, name, base: f.base, engineColor: f.engine, wing: f.wing,
    side: (k) => drawFlat(k, f),
    engine: (k) => k.fill(f.engine),
  }
}

/** A liveries.json entry as a design; decals live in public/liveries/<code>-title.png and -fin.png. */
export function tableDesign(code: string, l: LiveryEntry, baseUrl: string): Design {
  const url = `${baseUrl}liveries/${code}`
  return flatDesign(code, `${code} (colours)`, {
    base: l.base, belly: l.belly ?? l.base, fin: l.fin, fin2: l.fin2 ?? l.fin, engine: l.engine ?? l.base,
    finUrl: l.finLogo === true ? `${url}-fin.png` : null, titleUrl: l.title === true ? `${url}-title.png` : null, bodyUrl: null,
    wing: l.wing,
  })
}

/**
 * A scenario's livery (scenario.json aircraft.livery). Decal paths are relative to the scenario folder `base` (ending
 * in '/'); present says which optional files the loader found (a missing fin logo is no error: the fin stays plain).
 * key must not be a table code (e.g. 'scenario:jal123').
 * ponytail: the paths are joined, not URL-resolved: the format gives plain relative paths. Upgrade: new URL(path, base)
 * if a package ever points outside its folder.
 */
export function specDesign(key: string, spec: LiverySpec, base: string, present: { body: boolean; finLogo: boolean }): Design {
  const url = (path: string | undefined, found: boolean): string | null => (path === undefined || !found ? null : `${base}${path}`)
  return flatDesign(key, key, {
    base: spec.base, belly: spec.belly ?? spec.base, fin: spec.fin, fin2: spec.fin2 ?? spec.fin, engine: spec.engine ?? spec.base,
    bodyUrl: url(spec.body, present.body), finUrl: url(spec.finLogo, present.finLogo), titleUrl: url(spec.title, true),
  })
}
