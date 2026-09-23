// client/scene/modelFor.ts
// Which 3-D model draws an aircraft: the one listing its ICAO type designator, else its family's (manifest fallback).
import type { ModelManifest, ModelManifestEntry } from '../types.ts'
import { iconFor } from './icons.ts'

/**
 * Picks a manifest model per aircraft. Order: an entry listing the designator exactly; the longest "PREFIX*" listed;
 * a helicopter designator → fallback.heli; the ADS-B category's fallback (A2 small jets → the bizjet); the type
 * family's (iconFor: light / jet / heavy); the default. Throws on a fallback that names no model.
 */
export class ModelPicker {
  readonly #byId = new Map<string, ModelManifestEntry>()
  readonly #exact = new Map<string, ModelManifestEntry>()
  readonly #prefixes: [string, ModelManifestEntry][] = []
  readonly #fallback: Record<string, string>
  readonly #default: ModelManifestEntry

  constructor(man: ModelManifest) {
    for (const m of man.models) {
      this.#byId.set(m.id, m)
      for (const t of m.types ?? []) {
        if (t.endsWith('*')) this.#prefixes.push([t.slice(0, -1), m])
        else this.#exact.set(t, m)
      }
    }
    this.#prefixes.sort((a, b) => b[0].length - a[0].length)
    this.#fallback = man.fallback ?? {}
    for (const id of [man.default, ...Object.values(this.#fallback)]) if (!this.#byId.has(id)) throw new Error(`manifest names no model "${id}"`)
    this.#default = this.#byId.get(man.default)!
  }

  get models(): readonly ModelManifestEntry[] {
    return [...this.#byId.values()]
  }

  for(typeCode: string | null, category: string | null): ModelManifestEntry {
    const t = typeCode ? typeCode.toUpperCase() : null
    if (t !== null) {
      const hit = this.#exact.get(t) ?? this.#prefixes.find(([p]) => t.startsWith(p))?.[1]
      if (hit) return hit
    }
    const kind = iconFor(category, t)
    const id = kind === 'heli' ? this.#fallback.heli : ((category ? this.#fallback[category] : undefined) ?? this.#fallback[kind])
    return (id === undefined ? undefined : this.#byId.get(id)) ?? this.#default
  }
}
