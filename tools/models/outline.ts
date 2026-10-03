// tools/models/outline.ts
// Measures each manifest model's outline from its GLB, and prints or writes the manifest's `outline` entries: spheres
// that together cover the mesh, for what must tell the aircraft from the square round it (client/scene/modelOutline.ts:
// the place names keep off the aircraft, not off its brackets). Measured in the body frame, written in the model frame
// the manifest keeps (like `box` and `lights`; unscaled mesh units), to 1 cm.
//
//   node tools/models/outline.ts            print each model's count of spheres and their largest radius
//   node tools/models/outline.ts --write    replace (or add after "lights") each model's line in the manifest
//
// How: a grid of CELLS cells along the mesh's longest side; every triangle sampled a quarter of a cell apart at most (a
// sparse vertex layout does not matter); one sphere per cell the surface passes through, round the box of the cell's
// samples and what of the surface lies between samples. A thin part (a wing, the fin) so gets spheres about as wide as
// a cell, not as wide as the aircraft.
import { readFileSync, writeFileSync } from 'node:fs'
import type { ModelManifest, ModelManifestEntry } from '../../client/types.ts'
import { MANIFEST, loadBody, toModelFrame, type Mesh } from './light-anchors.ts'

export type Sphere = [x: number, y: number, z: number, r: number]
export const CELLS = 16
const STEP = 0.25 // of a cell: the samples are this far apart at most

/** Spheres that cover m's surface: one per cell of the grid (cells along its longest side) the surface passes through. */
export function outlineOf(m: Mesh, cells = CELLS): Sphere[] {
  const { p, tri } = m
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], p[i])
    hi[i % 3] = Math.max(hi[i % 3], p[i])
  }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / cells
  const boxes = new Map<number, number[]>() // per cell: its samples' least x, y, z, then their greatest
  const q = [0, 0, 0]
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3
    const edge = (u: number, v: number): number => Math.hypot(p[u] - p[v], p[u + 1] - p[v + 1], p[u + 2] - p[v + 2])
    const n = Math.max(1, Math.ceil(Math.max(edge(a, b), edge(b, c), edge(c, a)) / (size * STEP)))
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        let key = 0
        for (let d = 0; d < 3; d++) {
          q[d] = p[a + d] + ((p[b + d] - p[a + d]) * i + (p[c + d] - p[a + d]) * j) / n
          key = key * (cells + 1) + Math.min(cells, Math.floor((q[d] - lo[d]) / size))
        }
        const box = boxes.get(key)
        if (box === undefined) boxes.set(key, [...q, ...q])
        else for (let d = 0; d < 3; d++) {
          box[d] = Math.min(box[d], q[d])
          box[d + 3] = Math.max(box[d + 3], q[d])
        }
      }
    }
  }
  // No point of a triangle is farther from its nearest corner than its longest side / √3: the samples' little triangles.
  const between = (size * STEP) / Math.sqrt(3)
  return [...boxes.values()].map((b) => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2, Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2 + between])
}

/** e's `outline` entry, measured from its GLB: each radius rounded up, past what rounding its centre moves it. */
export function outlineFor(e: ModelManifestEntry): Sphere[] {
  return outlineOf(loadBody(e)).map(([x, y, z, r]) => [...toModelFrame(e, [x, y, z]), Math.ceil((r + 0.01) * 100) / 100])
}

/** The manifest line: `"outline": [[x, y, z, r], …]`, the manifest's one-line-per-field style. */
export const outlineLine = (o: Sphere[]): string => `"outline": [${o.map((s) => `[${s.join(', ')}]`).join(', ')}]`

/** Replaces (or adds, after "lights") each listed model's outline line in the manifest text. */
export function writeOutlines(text: string, outlines: Map<string, Sphere[]>): string {
  const lines = text.split('\n')
  for (const [id, o] of outlines) {
    const at = lines.findIndex((l) => l.includes(`"id": "${id}"`))
    const end = lines.findIndex((l, i) => i > at && /^ {4}\}/.test(l))
    const line = outlineLine(o)
    const old = lines.findIndex((l, i) => i > at && i < end && l.trim().startsWith('"outline"'))
    if (old >= 0) lines[old] = lines[old].replace(/"outline".*?(,?)$/, `${line}$1`)
    else {
      const after = lines.findLastIndex((l, i) => i > at && i < end && /^ {6}"(lights|box|scale|gearHeightM)"/.test(l))
      const last = !lines[after].endsWith(',') // the entry's last line has no comma: it gets one, the new line none
      if (last) lines[after] += ','
      lines.splice(after + 1, 0, `      ${line}${last ? '' : ','}`)
    }
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const text = readFileSync(MANIFEST, 'utf8')
  const manifest: ModelManifest = JSON.parse(text)
  const outlines = new Map(manifest.models.map((e) => [e.id, outlineFor(e)]))
  for (const [id, o] of outlines) console.log(`${id}: ${o.length} spheres, the largest ${Math.max(...o.map((s) => s[3]))} across its radius`)
  if (process.argv.includes('--write')) {
    const out = writeOutlines(text, outlines)
    JSON.parse(out) // still JSON
    writeFileSync(MANIFEST, out)
    console.log(`wrote ${MANIFEST}`)
  }
}
