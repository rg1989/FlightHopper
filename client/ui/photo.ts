// client/ui/photo.ts
// Aircraft photos for the detail panel from the planespotters.net public photo API, asked only for the selected
// aircraft. Terms (planespotters.net Terms of Use, checked 2026-09-22): a thumbnail must show the author credit as
// "© name" and link back to the photo's page on planespotters.net, which the panel does. Browsers may call it
// cross-origin: from http://localhost:5415 on 2026-09-22 one request came back without CORS headers (refused, a
// retryable error here) and the next returned the photo. It refuses server User-Agents without a contact URL or email.

export interface Photo {
  thumbUrl: string // https image on planespotters' CDN; hotlinked, never copied
  link: string // the photo's page on planespotters.net (the required link-back)
  photographer: string // the required credit: "Image © {photographer}"
}

const API = 'https://api.planespotters.net/pub/photos/hex/'
const ICAO_HEX = /^[0-9a-f]{6}$/ // '~' hexes are non-ICAO (TIS-B / anonymous): no airframe to look up
const TIMEOUT_MS = 8000

export function photoUrl(hex: string): string {
  return API + hex.toUpperCase()
}

const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  try {
    return new URL(v).protocol === 'https:' ? v : null // never put javascript: or http: into an href or src
  } catch {
    return null
  }
}

/** The API's first photo as a Photo, or null when there is none or it lacks a usable image, link or credit. */
export function toPhoto(body: unknown): Photo | null {
  const first = (body as { photos?: unknown } | null)?.photos
  const p = Array.isArray(first) ? (first[0] as Record<string, unknown> | undefined) : undefined
  if (typeof p !== 'object' || p === null) return null
  const src = (k: string): unknown => (p[k] as { src?: unknown } | undefined)?.src
  const thumbUrl = httpsUrl(src('thumbnail_large')) ?? httpsUrl(src('thumbnail'))
  const link = httpsUrl(p.link)
  const photographer = typeof p.photographer === 'string' ? p.photographer.trim() : ''
  return thumbUrl && link && photographer ? { thumbUrl, link, photographer } : null
}

/**
 * Per-hex photo lookups for the session. Each hex is asked at most once while its request is in flight, and an answer
 * (a photo, or "none") is kept for the session. Network errors, HTTP errors and unreadable bodies are not kept, so
 * selecting the aircraft again retries.
 * ponytail: the cache is an unbounded Map; a session selects tens to hundreds of aircraft. Upgrade: LRU if that grows.
 */
export class PhotoCache {
  #fetch: typeof fetch
  #cache = new Map<string, Promise<Photo | null>>()
  #failed = new Set<string>()

  constructor(fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
    this.#fetch = fetchFn
  }

  get(hex: string): Promise<Photo | null> {
    const key = hex.trim().toLowerCase()
    if (!ICAO_HEX.test(key)) return Promise.resolve(null)
    const hit = this.#cache.get(key)
    if (hit) return hit
    // .then runs its handlers in a later microtask, so a failure is forgotten only after the promise is stored.
    const p = this.#load(key).then(
      (photo) => {
        this.#failed.delete(key)
        return photo
      },
      () => {
        this.#cache.delete(key)
        this.#failed.add(key)
        return null
      },
    )
    this.#cache.set(key, p)
    return p
  }

  /** True when the newest lookup for hex failed (network, CORS, HTTP or unreadable body), not "no photo exists". */
  failed(hex: string): boolean {
    return this.#failed.has(hex.trim().toLowerCase())
  }

  async #load(hex: string): Promise<Photo | null> {
    const res = await this.#fetch(photoUrl(hex), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`planespotters ${res.status}`)
    return toPhoto(await res.json())
  }
}
