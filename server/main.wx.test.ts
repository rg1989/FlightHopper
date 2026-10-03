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
import { modelUrl, modelGeo } from './wx.ts'

const FILE = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))

/** Open-Meteo's answer for a grid: one object a place; 40 % cloud at 700 hPa everywhere. */
const places = (): unknown => Array.from({ length: 49 }, () => ({ elevation: 12, hourly: { time: [1791014400], cloud_cover_700hPa: [40] } }))

test('GET /api/wx/model?lat&lon: the model grid of the cell as JSON, shared by the next ask; 400 for a bad place, 502 when Open-Meteo is down and nothing is held', async (t) => {
  const asked: string[] = []
  let down = false
  const wxFetch = (async (url: string) => {
    asked.push(url)
    if (down) throw new Error('offline')
    return new Response(JSON.stringify(places()))
  }) as unknown as typeof fetch
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: join(mkdtempSync(join(tmpdir(), 'fh-wx-')), 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs: () => 2_000_000_000_000 }), nowMs: () => 2_000_000_000_000, wxFetch })
  const base = await app.listen(0)
  t.after(() => app.close())
  const get = async (q: string): Promise<{ status: number; type: string | null; body: ModelGrid & { error?: string } }> => {
    const res = await fetch(`${base}/api/wx/model${q}`)
    return { status: res.status, type: res.headers.get('content-type'), body: (await res.json()) as ModelGrid & { error?: string } }
  }

  const a = await get('?lat=32.1&lon=34.9')
  assert.equal(a.status, 200)
  assert.match(a.type ?? '', /^application\/json/)
  assert.deepEqual([a.body.lat0, a.body.lon0, a.body.step, a.body.n, a.body.timeMs], [31.5, 34, 0.25, 7, 1791014400_000])
  assert.deepEqual(a.body.clouds.find((l) => l.hPa === 700)!.cover.slice(0, 3), [40, 40, 40])
  assert.deepEqual(asked, [modelUrl(modelGeo('32.1', '34.9'))])
  assert.deepEqual((await get('?lat=32.4&lon=34.6')).body, a.body, 'the same cell')
  assert.equal(asked.length, 1, 'Open-Meteo is asked once for it')

  for (const q of ['', '?lat=32.1', '?lat=x&lon=1', '?lat=95&lon=0', '?lat=0&lon=200']) {
    const bad = await get(q)
    assert.equal(bad.status, 400, q)
    assert.match(bad.body.error ?? '', /lat and lon/)
  }
  assert.equal(asked.length, 1)

  down = true
  const gone = await get('?lat=-33.9&lon=151.2')
  assert.equal(gone.status, 502)
  assert.match(gone.body.error ?? '', /api\.open-meteo\.com: offline/)
  assert.equal((await get('?lat=32.1&lon=34.9')).status, 200, 'a cell held is still served')
})
