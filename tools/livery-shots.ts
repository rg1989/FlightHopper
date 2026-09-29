// tools/livery-shots.ts
// Captures the livery lab's comparison sheets headless (livery-pipeline-design.md §8): for each model:livery pair, the
// whole sheet (reference photos beside the same views of the model, the other views, the atlases) and every view as
// its own PNG, for a person or an agent to compare with the photos. Headless Chrome over CDP, frame-capped.
//
//   node tools/livery-shots.ts [--host http://localhost:5182] [--out data/livery-refs/shots] [--views refs|all|a,b]
//        [--port 9352] a21n:WZZ b738:ELY …
// Needs the vite dev server (npx vite, or the liveries-*-client launch config). Writes <out>/<model>-<CODE>/sheet.png
// and <view>.png, and prints each folder.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** "a21n:WZZ" → [model, livery]; the livery may be empty ("a21n:") for plain white. */
export function parsePair(s: string): [model: string, livery: string | null] {
  const [model, livery] = s.split(':')
  if (!model) throw new Error(`not model:LIVERY: ${s}`)
  return [model, livery ? livery.toUpperCase() : null]
}

/** The lab URL for one pair. */
export function labUrl(host: string, model: string, livery: string | null, views: string): string {
  const q = new URLSearchParams({ model })
  if (livery) q.set('livery', livery)
  if (views !== 'all') q.set('views', views)
  return `${host.replace(/\/$/, '')}/tools/livery-lab/?${q}`
}

interface Cdp {
  send(method: string, params?: object): Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  close(): void
}

async function chrome(port: number): Promise<Cdp> {
  const profile = join(tmpdir(), `fh-livery-shots-${port}`)
  rmSync(profile, { recursive: true, force: true })
  // Frame-capped (no --disable-frame-rate-limit): an uncapped Cesium page takes the whole GPU.
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1400,1000',
    '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
  const kill = (): void => {
    try { proc.kill('SIGKILL') } catch { /* gone */ }
    rmSync(profile, { recursive: true, force: true })
  }
  process.on('exit', kill)
  let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = []
  for (let i = 0; i < 100 && !targets.some((t) => t.type === 'page'); i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { /* starting */ }
    await sleep(200)
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) }
  })
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
      ws.send(JSON.stringify({ id: n, method, params }))
    }),
    close: () => { ws.close(); kill() },
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: 'string', default: 'http://localhost:5182' },
      out: { type: 'string', default: 'data/livery-refs/shots' },
      views: { type: 'string', default: 'all' },
      port: { type: 'string', default: '9352' }, // other sessions' headless Chromes use 9334–9351
    },
  })
  if (positionals.length === 0) throw new Error('usage: node tools/livery-shots.ts [--host …] [--views refs|all|a,b] model:LIVERY …')
  const cdp = await chrome(Number(values.port))
  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false })
    for (const pair of positionals) {
      const [model, livery] = parsePair(pair)
      const dir = join(values.out, `${model}-${livery ?? 'WHITE'}`)
      mkdirSync(dir, { recursive: true })
      await cdp.send('Page.navigate', { url: labUrl(values.host, model, livery, values.views) })
      let lab: { done: boolean; errors: string[]; tiles: Array<{ view: string; dataUrl: string }> } | null = null
      for (let i = 0; i < 240; i++) { // 2 minutes
        await sleep(500)
        const r = await cdp.send('Runtime.evaluate', { expression: 'window.__lab && window.__lab.done ? JSON.stringify(window.__lab) : null', returnByValue: true })
        if (r.result?.value) { lab = JSON.parse(r.result.value); break }
      }
      if (lab === null) throw new Error(`${pair}: the lab did not finish`)
      if (lab.errors.length) console.warn(`${pair}: ${lab.errors.join('; ')}`)
      for (const t of lab.tiles) writeFileSync(join(dir, `${t.view}.png`), Buffer.from(t.dataUrl.split(',')[1], 'base64'))
      await sleep(1500) // the sheet's images decode
      const { cssContentSize } = await cdp.send('Page.getLayoutMetrics')
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1400, height: Math.ceil(cssContentSize.height), scale: 1 } })
      writeFileSync(join(dir, 'sheet.png'), Buffer.from(shot.data, 'base64'))
      console.log(`${pair}: ${lab.tiles.length} views → ${dir}`)
    }
  } finally {
    cdp.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0), (err: unknown) => {
  console.error(err)
  process.exit(1)
})
