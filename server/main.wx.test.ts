// server/main.wx.test.ts
// The weather over HTTP: /api/wx/model on the real server (port 0), Open-Meteo from a fake fetch: nothing here reaches it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModelGrid } from '../shared/wx.ts'
import { readServerConfig } from './config.ts'
import { createServer } from './main.ts'
import { makeReplay } from './sources/replay.ts'
import { modelGeo, modelPlaces, modelUrl } from './wx.ts'

const FILE = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))

/** Open-Meteo's answer for n places: one object a place; 40 % cloud at 700 hPa everywhere. */
const answer = (n: number): unknown => Array.from({ length: n }, () => ({ elevation: 12, hourly: { time: [1791014400], cloud_cover_700hPa: [40] } }))

test('GET /api/wx/model?lat&lon: the model grid of the cell as JSON, shared by the next ask; 400 for a bad place; 502 when Open-Meteo is down and nothing is held, then a 503 with Retry-After (and retryAfterS in the body) while the failure is remembered', async (t) => {
  const asked: string[] = []
  let down = false
  const wxFetch = (async (url: string) => {
    asked.push(url)
    if (down) throw new Error('offline')
    return new Response(JSON.stringify(answer(new URL(url).searchParams.get('latitude')!.split(',').length)))
  }) as unknown as typeof fetch
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: join(mkdtempSync(join(tmpdir(), 'fh-wx-')), 'dist') }
  let now = 2_000_000_000_000
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs: () => now }), nowMs: () => now, wxFetch })
  const base = await app.listen(0)
  t.after(() => app.close())
  type Body = ModelGrid & { error?: string; retryAfterS?: number }
  const get = async (q: string): Promise<{ status: number; type: string | null; retryAfter: string | null; body: Body }> => {
    const res = await fetch(`${base}/api/wx/model${q}`)
    return { status: res.status, type: res.headers.get('content-type'), retryAfter: res.headers.get('retry-after'), body: (await res.json()) as Body }
  }

  const a = await get('?lat=32.1&lon=34.9')
  assert.equal(a.status, 200)
  assert.match(a.type ?? '', /^application\/json/)
  assert.deepEqual([a.body.lat0, a.body.lon0, a.body.step, a.body.n, a.body.timeMs], [31.5, 34, 0.25, 7, 1791014400_000])
  assert.deepEqual(a.body.clouds.find((l) => l.hPa === 700)!.cover.slice(0, 3), [40, 40, 40])
  assert.deepEqual(asked, [modelUrl(modelPlaces(modelGeo('32.1', '34.9')))])
  assert.deepEqual((await get('?lat=32.4&lon=34.6')).body, a.body, 'the same cell')
  assert.equal(asked.length, 1, 'Open-Meteo is asked once for it')

  for (const q of ['', '?lat=32.1', '?lat=x&lon=1', '?lat=95&lon=0', '?lat=0&lon=200']) {
    const bad = await get(q)
    assert.equal(bad.status, 400, q)
    assert.match(bad.body.error ?? '', /lat and lon/)
    assert.equal(bad.body.retryAfterS, undefined, `${q}: nothing to wait for`)
  }
  assert.equal(asked.length, 1)

  down = true
  now += 60_000 // the clock the server keeps (nowMs) runs on
  const gone = await get('?lat=-33.9&lon=151.2')
  assert.equal(gone.status, 502)
  assert.equal(gone.retryAfter, null)
  assert.equal(gone.body.retryAfterS, undefined)
  assert.match(gone.body.error ?? '', /api\.open-meteo\.com: offline/)
  now += 10_000
  const again = await get('?lat=-33.9&lon=151.2')
  assert.equal(again.status, 503, 'the failure is remembered')
  assert.equal(again.retryAfter, '50', 'its own Retry-After: what is left of the 60 s')
  assert.equal(again.body.retryAfterS, 50, 'the same, in the body, for the client\'s own wait')
  assert.match(again.body.error ?? '', /failed/)
  assert.equal(asked.length, 2, 'Open-Meteo was not asked again')
  assert.equal((await get('?lat=32.1&lon=34.9')).status, 200, 'a cell held is still served')
})
