// Drives harness/terrain-sun.html in a visible-to-itself headless Chrome (Metal GPU) over CDP: screenshots + FPS.
// usage: node bench.mjs <outDir> [scenario…]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const OUT = process.argv[2]
const ONLY = process.argv.slice(3)
mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173/harness/terrain-sun.html'
const PORT = 9333
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/profile`, '--window-size=1280,800',
  '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
process.on('exit', () => chrome.kill())

let targets
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.some((t) => t.type === 'page')) break } catch {}
  await sleep(200)
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id
  pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
  ws.send(JSON.stringify({ id: i, method, params }))
})
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 })
  if (r.exceptionDetails) throw new Error(`${expr.slice(0, 80)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'))
}
async function settle(extraMs = 3000, maxMs = 90000) {
  const t0 = Date.now()
  let ok = 0
  while (Date.now() - t0 < maxMs) {
    const s = await ev('window.poc ? poc.stats() : null').catch(() => null)
    ok = s && s.tilesLoaded && s.groundM !== null ? ok + 1 : 0
    if (ok >= 3) break
    await sleep(500)
  }
  await sleep(extraMs)
  return { loadS: (Date.now() - t0) / 1000 }
}
async function nav(query) {
  await send('Page.navigate', { url: `${BASE}?${query}` })
  await sleep(1000)
  return settle()
}
// rAF-timed frames over ms: fps, p50/p95/max frame time.
const measure = (ms = 5000) => ev(`new Promise((res) => { const t = []; const s = performance.now();
  const f = (n) => { t.push(n); if (n - s < ${ms}) requestAnimationFrame(f); else {
    const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b); const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
    res({ fps: +(1000 * d.length / (t.at(-1) - t[0])).toFixed(1), p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +d.at(-1).toFixed(1) }) } };
  requestAnimationFrame(f) })`)

await send('Page.enable')
await send('Runtime.enable')
const results = {}
const log = (k, v) => { results[k] = v; console.log(k, JSON.stringify(v)); writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2)) }
const want = (k) => ONLY.length === 0 || ONLY.includes(k)
const MORNING = 'time=2026-06-21T06:30:00Z'

if (want('base')) {
  log('base.load', await nav(`${MORNING}&light=0&shadow=0&hold=1`))
  log('gl', await ev(`(() => { const gl = poc.viewer.scene.context._gl; const x = gl.getExtension('WEBGL_debug_renderer_info'); return { renderer: x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), size: [poc.viewer.canvas.width, poc.viewer.canvas.height] } })()`))
  await shot('1-today-no-lighting'); log('base.fps', await measure())
}
if (want('lit')) {
  log('lit.load', await nav(`${MORNING}&shadow=0&hold=1`))
  await shot('2-sun-lighting'); log('lit.fps', await measure())
}
if (want('shadow')) {
  log('shadow.load', await nav(`${MORNING}&hold=1`))
  await shot('3-sun-lighting-shadows'); log('shadow.fps', await measure()); log('shadow.stats', await ev('poc.stats()'))
  await ev('poc.opt.globeCasts = false, poc.applyLight()'); await sleep(1500)
  log('shadow.receiveOnly.fps', await measure())
  await ev('poc.opt.globeCasts = true, poc.applyLight()')
}
if (want('golden')) {
  log('golden.load', await nav('time=2026-06-21T18:40:00Z&hold=1'))
  await shot('4-golden-hour'); log('golden.fps', await measure())
}
if (want('night')) {
  log('night.load', await nav('time=2026-06-21T21:30:00Z&hold=1'))
  await sleep(4000) // night-lights tiles
  await shot('5-night'); log('night.fps', await measure())
}
if (want('topo')) {
  log('topo.load', await nav(`${MORNING}&hold=1`))
  // Sink: sample exaggeration + rendered vs expected ground mid-way, then the finished flat state.
  await ev('poc.setTopo(false)')
  await sleep(1100)
  await shot('6-terrain-sinking')
  log('topo.mid', await ev('poc.stats()'))
  await sleep(2500)
  log('topo.sinkAnim', await ev('({ ...poc.anim })'))
  await settle(1500)
  await shot('7-terrain-flat'); log('topo.flat', await ev('poc.stats()')); log('topo.flat.fps', await measure(3000))
  await ev('poc.setTopo(true)')
  await sleep(1300)
  log('topo.growMid', await ev('poc.stats()'))
  await sleep(2500)
  log('topo.growAnim', await ev('({ ...poc.anim })'))
  await settle(1500)
  await shot('8-terrain-regrown'); log('topo.regrown', await ev('poc.stats()'))
}
if (want('low')) {
  // Low over the valley floor: the aircraft's own shadow on the ground.
  log('low.load', await nav('time=2026-06-21T09:30:00Z&r=1800&h=700&hold=1&at=20'))
  await shot('9-low-aircraft-shadow'); log('low.stats', await ev('poc.stats()'))
}
if (want('fly')) {
  // Realistic: flying (tiles stream in), lit + shadows, 15 s.
  log('fly.load', await nav(`${MORNING}`))
  log('fly.fps', await measure(15000)); await shot('10-flying')
}
const PEAKS = { hafelekar: [47.3122, 11.3862], patscherkofel: [47.2092, 11.4608] }
const probePeaks = () => ev(`Promise.all(${JSON.stringify(Object.values(PEAKS))}.map(([a, o]) => poc.probe(a, o)))`)
// Height readbacks right after an animation ends: does getHeight under the aircraft go null, and for how long?
async function groundSeries(n = 10, gapMs = 500) {
  const out = []
  for (let i = 0; i < n; i++) { out.push((await ev('poc.stats()')).groundM); await sleep(gapMs) }
  return out.map((x) => (x === null ? null : +x.toFixed(1)))
}
async function cycle(tag) {
  await ev('poc.setTopo(false)'); await sleep(1250)
  log(`${tag}.sinkMidPeaks`, await probePeaks())
  await sleep(2000); log(`${tag}.sinkAnim`, await ev('({ frames: poc.anim.frames, avgMs: poc.anim.sumMs / poc.anim.frames, worstMs: poc.anim.maxFrameMs })'))
  await ev('poc.setTopo(true)'); await sleep(1250)
  log(`${tag}.growMidPeaks`, await probePeaks())
  await sleep(1500); log(`${tag}.growAnim`, await ev('({ frames: poc.anim.frames, avgMs: poc.anim.sumMs / poc.anim.frames, worstMs: poc.anim.maxFrameMs })'))
  log(`${tag}.groundAfterGrow`, await groundSeries())
}
for (const eps of ['0', '1e-5']) {
  if (!want(`hitch${eps}`)) continue
  log(`hitch${eps}.load`, await nav(`${MORNING}&hold=1&eps=${eps}`))
  log(`hitch${eps}.peaksFull`, await probePeaks())
  await cycle(`hitch${eps}.c1`)
  await cycle(`hitch${eps}.c2`)
}
for (const nudge of ['0', '1']) {
  if (!want(`picker${nudge}`)) continue
  log(`picker${nudge}.load`, await nav(`${MORNING}&hold=1&eps=1e-5&nudge=${nudge}`))
  const tally = { nullAfter: 0, samplesAfter: 0, nullDuringAnim: 0, animFrames: 0 }
  for (let c = 0; c < 5; c++) {
    for (const on of [false, true]) {
      await ev(`poc.setTopo(${on})`)
      await sleep(3300) // 2.5 s animation + 0.5 s nudge delay + margin
      const a = await ev('({ ...poc.anim })')
      tally.nullDuringAnim += a.nullFrames
      tally.animFrames += a.frames
      const g = await groundSeries(8, 250)
      tally.samplesAfter += g.length
      tally.nullAfter += g.filter((x) => x === null).length
    }
  }
  log(`picker${nudge}.tally`, tally)
}
if (want('strip')) {
  // Mountains growing out of the flat map: start flat around the ground under the aircraft, then grow over 2.5 s.
  log('strip.load', await nav(`${MORNING}&hold=1&eps=1e-5&nudge=1&anim=2.5`))
  await ev('poc.setTopo(false)'); await sleep(3500); await settle(1500)
  await shot('14-grow-0-flat')
  await ev('poc.setTopo(true)')
  const t0 = Date.now()
  for (const [ms, name] of [[900, '14-grow-1'], [1350, '14-grow-2'], [1800, '14-grow-3'], [3200, '14-grow-4-full']]) {
    await sleep(Math.max(0, ms - (Date.now() - t0)))
    const f = await ev('poc.viewer.scene.verticalExaggeration')
    await shot(`${name}-f${f.toFixed(2)}`)
  }
}
if (want('strip6')) {
  // Same as strip, 6 s animation so the screenshot latency does not skip the middle; then the squash evidence.
  log('strip6.load', await nav(`${MORNING}&hold=1&eps=1e-5&nudge=1&anim=6&shadow=0`))
  await ev('poc.setTopo(false)'); await sleep(7000); await settle(2000)
  await shot('s-0-flat')
  await ev('poc.setTopo(true)')
  const t0 = Date.now()
  for (const ms of [2200, 3000, 3800, 7500]) {
    await sleep(Math.max(0, ms - (Date.now() - t0)))
    const f = await ev('poc.viewer.scene.verticalExaggeration')
    await shot(`s-grow-f${f.toFixed(2)}`)
  }
  log('strip6.squash.load', await nav(`${MORNING}&hold=1&eps=1e-5&nudge=1&anim=6&shadow=0&modelExag=1`))
  await ev('poc.setTopo(false)'); await sleep(3000)
  const f = await ev('poc.viewer.scene.verticalExaggeration')
  await shot(`s-squashed-f${f.toFixed(2)}`)
}
if (want('shadowstart')) {
  log('shadowstart.load', await nav(`${MORNING}&hold=1&eps=1e-5`))
  await shot('11-shadows-from-start'); log('shadowstart.stats', await ev('poc.stats()'))
}
if (want('ab')) {
  log('ab.load', await nav(`${MORNING}&hold=1&eps=1e-5&shadow=0`))
  const set = (js) => ev(`(${js}, poc.applyLight())`).then(() => sleep(2500))
  log('ab.lit', await measure())
  await set('poc.opt.shadow = true, poc.opt.globeCasts = true'); log('ab.shadowGlobeCasts', await measure())
  await set('poc.opt.globeCasts = false'); log('ab.shadowGlobeReceives', await measure())
  await set('poc.opt.globeCasts = true, poc.viewer.shadowMap.softShadows = false'); log('ab.hardShadows', await measure())
  await set('poc.viewer.shadowMap.softShadows = true, poc.viewer.shadowMap.size = 4096'); log('ab.size4096', await measure())
  await set('poc.viewer.shadowMap.size = 2048, poc.viewer.shadowMap.maximumDistance = 5000'); log('ab.maxDist5000', await measure())
  await set('poc.viewer.shadowMap.maximumDistance = 20000, poc.opt.light = false'); log('ab.noLight', await measure())
}
if (want('golden2')) {
  log('golden2.load', await nav('time=2026-06-21T18:40:00Z&hold=1&eps=1e-5'))
  await shot('12-golden-hour-tuned')
}
if (want('night2')) {
  log('night2.load', await nav('time=2026-06-21T21:30:00Z&hold=1&eps=1e-5'))
  await sleep(4000); await shot('13-night-tuned')
}
console.log('done')
ws.close()
chrome.kill()
process.exit(0)
