// client/ui/photo.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PhotoCache, photoUrl, toPhoto } from './photo.ts'

// Shape of a planespotters.net /pub/photos/hex answer (field names as the API returns them; values made up).
const BODY = {
  photos: [
    {
      id: '1234567',
      thumbnail: { src: 'https://t.plnspttrs.net/12345/1234567_abcdef0123_t.jpg', size: { width: 200, height: 133 } },
      thumbnail_large: { src: 'https://t.plnspttrs.net/12345/1234567_abcdef0123_280.jpg', size: { width: 420, height: 280 } },
      link: 'https://www.planespotters.net/photo/1234567/sx-dnd-aegean-airlines-airbus-a320-232',
      photographer: 'A. Spotter',
    },
    {
      id: '7654321',
      thumbnail: { src: 'https://t.plnspttrs.net/1/2_t.jpg', size: { width: 200, height: 133 } },
      link: 'https://www.planespotters.net/photo/7654321/second',
      photographer: 'Someone Else',
    },
  ],
}

interface Call { url: string }

/** A fetch that answers from a script and records the URLs asked for. `gate` holds every answer until released. */
function fakeFetch(answer: (url: string) => Response | Error, gate?: Promise<void>): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push({ url })
    if (gate) await gate
    const a = answer(url)
    if (a instanceof Error) throw a
    return a
  }) as typeof fetch
  return { fn, calls }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('photoUrl: upper-case hex on the public endpoint', () => {
  assert.equal(photoUrl('4691c4'), 'https://api.planespotters.net/pub/photos/hex/4691C4')
})

test('toPhoto: first photo, large thumbnail preferred, photo page and photographer', () => {
  assert.deepEqual(toPhoto(BODY), {
    thumbUrl: 'https://t.plnspttrs.net/12345/1234567_abcdef0123_280.jpg',
    link: 'https://www.planespotters.net/photo/1234567/sx-dnd-aegean-airlines-airbus-a320-232',
    photographer: 'A. Spotter',
  })
  // Only the small thumbnail: use it.
  assert.equal(toPhoto({ photos: [BODY.photos[1]] })?.thumbUrl, 'https://t.plnspttrs.net/1/2_t.jpg')
})

test('toPhoto: no photos, malformed entries, missing credit or non-https URLs → null', () => {
  assert.equal(toPhoto({ photos: [] }), null)
  assert.equal(toPhoto({}), null)
  assert.equal(toPhoto(null), null)
  assert.equal(toPhoto({ photos: [{ ...BODY.photos[0], photographer: '  ' }] }), null) // credit is required by the terms
  assert.equal(toPhoto({ photos: [{ ...BODY.photos[0], link: 'javascript:alert(1)' }] }), null)
  assert.equal(toPhoto({ photos: [{ ...BODY.photos[0], thumbnail_large: { src: 'http://t.plnspttrs.net/x.jpg' }, thumbnail: undefined }] }), null)
})

test('PhotoCache: one request per hex, hits and misses cached for the session', async () => {
  const { fn, calls } = fakeFetch((url) => (url.endsWith('/4691C4') ? json(BODY) : json({ photos: [] })))
  const photos = new PhotoCache(fn)
  const a = await photos.get('4691c4')
  assert.equal(a?.photographer, 'A. Spotter')
  assert.equal(await photos.get('4691C4'), a) // same object, case-insensitive hex
  assert.equal(await photos.get('abcdef'), null)
  assert.equal(await photos.get('abcdef'), null)
  assert.deepEqual(calls.map((c) => c.url), [
    'https://api.planespotters.net/pub/photos/hex/4691C4',
    'https://api.planespotters.net/pub/photos/hex/ABCDEF',
  ])
})

test('PhotoCache: concurrent gets for one hex share one in-flight request', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { fn, calls } = fakeFetch(() => json(BODY), gate)
  const photos = new PhotoCache(fn)
  const p1 = photos.get('4691c4')
  const p2 = photos.get('4691c4')
  assert.equal(p1, p2)
  release()
  assert.equal((await p1)?.photographer, 'A. Spotter')
  assert.equal(calls.length, 1)
})

test('PhotoCache: HTTP and network errors are not cached, so the next selection retries', async () => {
  let fail: Response | Error = json({ error: 'nope' }, 503)
  const { fn, calls } = fakeFetch(() => fail)
  const photos = new PhotoCache(fn)
  assert.equal(await photos.get('4691c4'), null)
  assert.equal(photos.failed('4691C4'), true) // failed, as opposed to "no photo exists"
  fail = new TypeError('Failed to fetch') // what a browser reports when CORS refuses the origin
  assert.equal(await photos.get('4691c4'), null)
  fail = new Response('not json', { status: 200 })
  assert.equal(await photos.get('4691c4'), null)
  fail = json(BODY)
  assert.equal((await photos.get('4691c4'))?.photographer, 'A. Spotter')
  assert.equal(photos.failed('4691c4'), false)
  assert.equal(calls.length, 4)
})

test('PhotoCache: failed() is false for a real miss and for a hex never asked', async () => {
  const { fn } = fakeFetch(() => json({ photos: [] }))
  const photos = new PhotoCache(fn)
  assert.equal(photos.failed('abcdef'), false)
  assert.equal(await photos.get('abcdef'), null)
  assert.equal(photos.failed('abcdef'), false)
})

test('PhotoCache: a fetch that throws synchronously is not cached either', async () => {
  let n = 0
  const fn = ((): Promise<Response> => {
    n++
    if (n === 1) throw new Error('sync failure')
    return Promise.resolve(json(BODY))
  }) as typeof fetch
  const photos = new PhotoCache(fn)
  assert.equal(await photos.get('4691c4'), null)
  assert.equal((await photos.get('4691c4'))?.photographer, 'A. Spotter')
  assert.equal(n, 2)
})

test('PhotoCache: non-ICAO (~) and malformed hexes never reach the network', async () => {
  const { fn, calls } = fakeFetch(() => json(BODY))
  const photos = new PhotoCache(fn)
  assert.equal(await photos.get('~a330e6'), null)
  assert.equal(await photos.get('xyz'), null)
  assert.equal(await photos.get(''), null)
  assert.equal(calls.length, 0)
})
