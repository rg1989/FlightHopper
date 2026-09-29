// client/ui/settings.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// settings.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { CHECK_URL, checkKey, keyStatus } = await import('./settings.ts')

const KEY = 'test-invalid-arcgis-key-000'

/** A fetch answering status (and body) once, recording what it was asked. */
function answer(status: number, body: unknown = {}): { fetch: typeof fetch; asked: { url: string; auth: string | null }[] } {
  const asked: { url: string; auth: string | null }[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetch: f, asked }
}

test('checkKey: asks the key\'s own provider, the key in the Authorization header and never in the URL', async () => {
  for (const id of ['arcgis', 'ion'] as const) {
    const { fetch, asked } = answer(200)
    assert.deepEqual(await checkKey(id, KEY, fetch), { ok: true })
    assert.deepEqual(asked, [{ url: CHECK_URL[id], auth: `Bearer ${KEY}` }])
    assert.ok(!asked[0].url.includes(KEY))
  }
  assert.match(CHECK_URL.arcgis, /^https:\/\/basemapstyles-api\.arcgis\.com\//)
  assert.match(CHECK_URL.ion, /^https:\/\/api\.cesium\.com\//)
})

test('checkKey: a refusal says why and is final (not saved)', async () => {
  const why = async (id: 'arcgis' | 'ion', status: number, body?: unknown): Promise<unknown> => checkKey(id, KEY, answer(status, body).fetch)
  assert.deepEqual(await why('arcgis', 401, { error: { code: 498 } }), { ok: false, why: 'ArcGIS says this key is invalid or expired' })
  assert.deepEqual(await why('arcgis', 403), { ok: false, why: 'This key lacks the “Basemap styles service” privilege' })
  assert.deepEqual(await why('ion', 401), { ok: false, why: 'Cesium ion says this token is invalid or expired' })
  assert.deepEqual(await why('ion', 404), { ok: false, why: 'This token cannot open Cesium World Terrain (asset 1)' })
  assert.deepEqual(await why('ion', 429), { ok: false, why: 'Cesium ion refused this token (HTTP 429)' })
  // ArcGIS can answer 200 with its error in the body.
  assert.deepEqual(await why('arcgis', 200, { error: { code: 498, message: 'Token Invalid.' } }), { ok: false, why: 'ArcGIS says this key is invalid or expired' })
  assert.deepEqual(await why('arcgis', 200, { error: { code: 403 } }), { ok: false, why: 'This key lacks the “Basemap styles service” privilege' })
})

test('checkKey: no answer (offline, blocked by CORS, timed out, a 5xx) is not a refusal: saved with a warning', async () => {
  const down = (async () => {
    throw new TypeError('Failed to fetch')
  }) as typeof fetch
  assert.deepEqual(await checkKey('arcgis', KEY, down), { ok: null, why: 'ArcGIS could not be reached' })
  assert.deepEqual(await checkKey('ion', KEY, answer(503).fetch), { ok: null, why: 'Cesium ion answered HTTP 503' })
})

test('keyStatus: where the key comes from, a reload still to come, a failure while in use', () => {
  assert.deepEqual(keyStatus('arcgis', 'env', false, null), { text: 'Using the key from .env.local', tone: 'ok' })
  assert.deepEqual(keyStatus('ion', 'env', false, null), { text: 'Using the token from .env.local', tone: 'ok' })
  assert.deepEqual(keyStatus('arcgis', 'saved', false, null), { text: 'Saved in this browser', tone: 'ok' })
  assert.deepEqual(keyStatus('arcgis', 'none', false, null), { text: 'Not set — using keyless EOX imagery', tone: 'off' })
  assert.deepEqual(keyStatus('ion', 'none', false, null), { text: 'Not set — using keyless Re:Earth terrain', tone: 'off' })
  assert.deepEqual(keyStatus('arcgis', 'saved', true, null), { text: 'Saved in this browser · reload to apply', tone: 'ok' })
  assert.deepEqual(keyStatus('ion', 'none', true, null), { text: 'Not set — using keyless Re:Earth terrain · reload to apply', tone: 'off' })
  const failed = (what: ('terrain' | 'imagery')[]): string => keyStatus('ion', 'saved', false, { why: 'ion HTTP 401', what }).text
  assert.equal(failed(['terrain']), 'Saved in this browser, but it failed (ion HTTP 401): Re:Earth terrain instead')
  assert.equal(failed(['imagery']), 'Saved in this browser, but it failed (ion HTTP 401): EOX imagery instead')
  assert.equal(failed(['imagery', 'terrain']), 'Saved in this browser, but it failed (ion HTTP 401): Re:Earth terrain and EOX imagery instead')
  assert.deepEqual(keyStatus('arcgis', 'env', false, { why: 'Esri HTTP 498', what: ['imagery'] }), {
    text: 'Using the key from .env.local, but it failed (Esri HTTP 498): EOX imagery instead', tone: 'warn',
  })
  assert.equal(keyStatus('ion', 'saved', true, { why: 'ion HTTP 401', what: ['terrain'] }).tone, 'ok', 'a new key since: its reload is what counts')
})
