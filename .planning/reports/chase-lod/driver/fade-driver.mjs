// Imagery cross-fade checks (imageryFade.ts) in headless Chrome over CDP against harness/lod.html on :5190.
// usage: [HOST] [CDP_PORT=9350] node fade-driver.mjs <run> <scenario…>
// scenarios:
//   fly1 / fly0    S2 flight (FLY) with ?fade=1 / ?fade=0: fade stats every second for 20 s, then idle; active and refsHeld after
//   orbit          ?freeze=1&fade=1: idle → orbit 180° (3 s) → idle → back 180° → idle: skippedOffscreen etc.
//   swap           S2 flight with fades running: __lod.swapBaseLayer() mid-flight, then idle: refs, errors, EOX drawn
//   shots1/shots0  S2 flight: 30 frames every 100 ms from go()+2 s → shots/fade1, shots/fade0
//   jump1/jump0    freeze=1: after idle, jump the orbit 120° and grab 30 frames every 100 ms with a still camera → shots/jump1, jump0
// One Chrome at a time (capped at the display rate), fresh profile each, deleted after. Results: results-<run>.json.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = process.argv[2]
const WANT = process.argv.slice(3)
if (!RUN || WANT.length === 0) { console.error('usage: node fade-driver.mjs <run> <scenario…>'); process.exit(2) }
const HOST = process.env.HOST ?? 'http://localhost:5190'
const PORT = Number(process.env.CDP_PORT ?? 9350)
const FLY = process.env.FLY ?? '&agl=250&speed=90&lat=47.265&lon=11.45&hdg=265'
const [W, H] = [1280, 800]
const RESULTS = join(HERE, `results-${RUN}.json`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const load = () => loadavg().map((x) => +x.toFixed(1))
const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {}
function log(k, v) {
  results[k] = v
  console.log(k, JSON.stringify(v).slice(0, 1500))
  writeFileSync(RESULTS, JSON.stringify(results, null, 2))
}

async function browser(tag) {
  const profile = join(HERE, `profile-${RUN}-${tag}`)
  rmSync(profile, { recursive: true, force: true })
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
    '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' })
  const kill = () => { try { chrome.kill('SIGKILL') } catch {} }
  process.on('exit', kill)
  let targets = []
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.some((t) => t.type === 'page')) break } catch {}
    await sleep(200)
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  const errors = [] // exceptions, console.error/warn, browser log warnings/errors (WebGL), except network
  const network = { errors: 0, samples: [] }
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    const p = m.params
    if (m.method === 'Runtime.exceptionThrown') errors.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`.slice(0, 400))
    else if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning' || p.type === 'warn')) errors.push(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description).join(' ')}`.slice(0, 400))
    else if (m.method === 'Log.entryAdded' && (p.entry.level === 'error' || p.entry.level === 'warning')) {
      if (p.entry.source === 'network') { network.errors++; if (network.samples.length < 3) network.samples.push(`${p.entry.text} ${p.entry.url ?? ''}`.slice(0, 200)) }
      else errors.push(`log.${p.entry.source}.${p.entry.level}: ${p.entry.text}`.slice(0, 400))
    }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id
    pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const b = { send, errors, network }
  b.ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, timeout: 600000 })
    if (r.exceptionDetails) throw new Error(`${expr.slice(0, 100)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  b.nav = async (path) => {
    await send('Page.navigate', { url: HOST + path })
    for (let i = 0; i < 600; i++) { if (await b.ev('return !!(window.__lod && window.__lod.ready)').catch(() => false)) return; await sleep(200) }
    throw new Error(`${path}: window.__lod never became ready; errors: ${errors.slice(0, 5).join(' | ')}`)
  }
  b.shot = async (file) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(data, 'base64'))
  }
  b.close = async () => {
    try { ws.close() } catch {}
    kill()
    for (let i = 0; i < 50 && chrome.exitCode === null && chrome.signalCode === null; i++) await sleep(100)
    await sleep(800) // its helper processes
    rmSync(profile, { recursive: true, force: true })
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
  return b
}

const FADE = 'return __lod.stats().fade'
const FRAME = `const s = __lod.stats(); return { fps: s.fps, frameMs: s.frameMs, cpuMs: s.cpuMs, tilesToRender: s.tilesToRender, tilesLoaded: s.tilesLoaded, imageryPops: s.imageryPops, imagery: s.imagery }`

/** Waits until the view is idle and no fade is active (or the time runs out); returns the fade stats and how long it took. */
async function settle(b, ms = 60000) {
  const t0 = Date.now()
  const idle = await b.ev(`return await __lod.waitIdle(${ms})`)
  let f
  for (let i = 0; i < 100; i++) { f = await b.ev(FADE); if (f.active === 0 && f.refsHeld === 0) break; await sleep(100) }
  return { idle, settleMs: Date.now() - t0, fade: f }
}

async function fly(fade) {
  const b = await browser(`fly${fade}`)
  try {
    await b.nav(`/harness/lod.html?hold=1${FLY}&fade=${fade}`)
    const first = await b.ev('return await __lod.waitIdle(180000)')
    await sleep(2000)
    await b.ev('await __lod.waitIdle(60000)')
    const atLoad = await b.ev(FADE) // the initial load's fades, before the reset
    await b.ev('__lod.resetCounters(); __lod.go()')
    const perSecond = []
    let maxActive = 0
    for (let s = 1; s <= 20; s++) {
      // sample active several times a second: it moves fast
      for (let k = 0; k < 4; k++) { await sleep(250); maxActive = Math.max(maxActive, (await b.ev(FADE)).active) }
      const f = await b.ev(FADE)
      perSecond.push({ s, active: f.active, refsHeld: f.refsHeld, started: f.started, finished: f.finished, expired: f.expired, cancelled: f.cancelled, skippedOffscreen: f.skippedOffscreen, skippedRefined: f.skippedRefined, skippedCap: f.skippedCap })
    }
    const during = { ...(await b.ev(FRAME)), fade: await b.ev(FADE), maxActive }
    const counters = await b.ev('const s = __lod.stats(); return { tilesLoadedTotal: s.tilesLoadedTotal, imageryRequests: s.imageryRequests, imageryPops: s.imageryPops, imageryPopLevels: s.imageryPopLevels, refines: s.refines, frames: s.frames }')
    const timeline = (await b.ev('return __lod.timeline()')).slice(0, 20).map(({ t, frames, blurTilesAvg, tilesDone, imageryRequests, imageryPops, frameMsMax, drawnAvg }) => ({ t, frames, blurTilesAvg, tilesDone, imageryRequests, imageryPops, frameMsMax, drawnAvg }))
    const after = await settle(b)
    log(`fly-fade${fade}`, { load: load(), initialIdle: first, atLoad, during, counters, timeline, after, perSecond, errors: b.errors.slice(0, 20), errorCount: b.errors.length, network: b.network })
  } finally { await b.close() }
}

async function orbit() {
  const b = await browser('orbit')
  try {
    await b.nav('/harness/lod.html?freeze=1&agl=300&fade=1')
    await b.ev('await __lod.waitIdle(180000)')
    await sleep(1500)
    const initial = await settle(b)
    const legs = {}
    for (const [name, deg] of [['away180', 180], ['back180', 180]]) {
      await b.ev('__lod.resetCounters()')
      await b.ev(`await __lod.orbitBy(${deg}, 3000)`)
      const mid = await b.ev(FADE)
      const s = await settle(b)
      legs[name] = { atOrbitEnd: mid, ...s, frame: await b.ev(FRAME) }
    }
    log('orbit-fade1', { load: load(), initial, legs, errors: b.errors.slice(0, 20), errorCount: b.errors.length, network: b.network })
  } finally { await b.close() }
}

const BASE_DRAWN = `const v = __lod.viewer; const base = v.imageryLayers.get(0); let tiles = 0, withBase = 0, readyBase = 0, otherLayer = 0
  for (const t of v.scene.globe._surface._tilesToRender) { tiles++; const tis = t.data?.imagery ?? []
    const mine = tis.filter((x) => (x.readyImagery ?? x.loadingImagery)?.imageryLayer === base); if (mine.length) withBase++
    if (mine.some((x) => x.readyImagery)) readyBase++
    if (tis.some((x) => { const l = (x.readyImagery ?? x.loadingImagery)?.imageryLayer; return l && l !== base && l.isBaseLayer() })) otherLayer++ }
  return { layers: v.imageryLayers.length, baseIsEox: /eox/.test(base.imageryProvider.url ?? ''), tiles, withBase, readyBase, otherLayer }`

async function swap() {
  const b = await browser('swap')
  try {
    await b.nav(`/harness/lod.html?hold=1${FLY}&fade=1`)
    await b.ev('await __lod.waitIdle(180000)')
    await sleep(1500)
    await b.ev('await __lod.waitIdle(60000)')
    await b.ev('__lod.resetCounters(); __lod.go()')
    let f = null
    const t0 = Date.now()
    while (Date.now() - t0 < 20000) { f = await b.ev(FADE); if (f.active >= 5) break; await sleep(50) }
    const res = await b.ev('return __lod.swapBaseLayer()')
    await sleep(100)
    const justAfter = await b.ev(FADE)
    await sleep(5000)
    const flying = await b.ev(FADE)
    const after = await settle(b, 90000)
    await sleep(1500)
    const drawn = await b.ev(BASE_DRAWN)
    mkdirSync(join(HERE, 'shots', 'swap'), { recursive: true })
    await b.shot(join(HERE, 'shots', 'swap', 'after-swap-idle.png'))
    log('swap-fade1', { load: load(), activeAtSwap: f.active, swapReturn: res, justAfter, flying5s: flying, after, drawn, stats: await b.ev(FRAME), errors: b.errors.slice(0, 20), errorCount: b.errors.length, network: b.network })
  } finally { await b.close() }
}

async function saveCaptures(b, dir) {
  mkdirSync(dir, { recursive: true })
  const frames = await b.ev('return __lod.captures()')
  for (let i = 0; i < frames.length; i++) {
    const file = `t${String(frames[i].tMs).padStart(5, '0')}ms.png`
    writeFileSync(join(dir, file), Buffer.from(await b.ev(`return await __lod.shotData(${i})`), 'base64'))
    frames[i].file = file
  }
  return frames.map(({ tMs, file, fading, pops, blurTiles, drawn }) => ({ tMs, file, fading, pops, blurTiles, drawn }))
}

async function shots(fade) {
  const b = await browser(`shots${fade}`)
  const dir = join(HERE, 'shots', `fade${fade}`)
  rmSync(dir, { recursive: true, force: true })
  try {
    await b.nav(`/harness/lod.html?hold=1${FLY}&fade=${fade}`)
    await b.ev('await __lod.waitIdle(180000)')
    await sleep(2000)
    await b.ev('await __lod.waitIdle(60000)')
    await b.ev('__lod.resetCounters(); __lod.go()')
    await sleep(2000)
    await b.ev('__lod.capture(100, 30)')
    await sleep(3500)
    const frames = await saveCaptures(b, dir)
    log(`shots-fade${fade}`, { dir, load: load(), fade: await b.ev(FADE), frames, errors: b.errors.slice(0, 10) })
  } finally { await b.close() }
}

async function jump(fade) {
  const b = await browser(`jump${fade}`)
  const dir = join(HERE, 'shots', `jump${fade}`)
  rmSync(dir, { recursive: true, force: true })
  try {
    await b.nav(`/harness/lod.html?freeze=1&agl=300&fade=${fade}`)
    await b.ev('await __lod.waitIdle(180000)')
    await sleep(1500)
    await b.ev('await __lod.waitIdle(60000)')
    await b.ev('__lod.resetCounters(); const o = __lod.chase.orbit; __lod.setOrbit(o.headingOffsetDeg + 120, o.pitchDeg, o.rangeM); __lod.capture(100, 30)')
    await sleep(3500)
    const frames = await saveCaptures(b, dir)
    log(`jump-fade${fade}`, { dir, load: load(), fade: await b.ev(FADE), frames, errors: b.errors.slice(0, 10) })
  } finally { await b.close() }
}

/** Still camera: load at SSE 8, idle, then SSE 2 so the whole view refines in place; 40 frames every 100 ms → shots/sse<fade>. */
async function sse(fade) {
  const tag = process.env.TAG ?? '' // e.g. TAG=dusk EXTRA='&sun=…'
  const b = await browser(`sse${fade}${tag}`)
  const dir = join(HERE, 'shots', `sse${fade}${tag}`)
  rmSync(dir, { recursive: true, force: true })
  try {
    await b.nav(`/harness/lod.html?freeze=1&agl=300&sse=8&fade=${fade}${process.env.EXTRA ?? ''}`)
    await b.ev('await __lod.waitIdle(180000)')
    await sleep(2500)
    await b.ev('await __lod.waitIdle(60000)')
    await b.ev('__lod.resetCounters(); __lod.viewer.scene.globe.maximumScreenSpaceError = 2; __lod.capture(100, 40)')
    await sleep(4500)
    const frames = await saveCaptures(b, dir)
    const after = await settle(b)
    log(`sse-fade${fade}${tag}`, { brightness: await b.ev('return { day: __lod.viewer.imageryLayers.get(0).brightness, night: __lod.viewer.imageryLayers.get(1).alpha, nightShown: __lod.viewer.imageryLayers.get(1).show }'), dir, load: load(), fade: after.fade, idle: after.idle, stats: await b.ev(FRAME), frames, errors: b.errors.slice(0, 10), errorCount: b.errors.length })
  } finally { await b.close() }
}

/** The off-screen skip path: Cesium loads culled tiles only with preloadSiblings (QuadtreePrimitive.js:1236-1240). */
async function orbitSiblings() {
  const b = await browser('orbitsib')
  try {
    await b.nav('/harness/lod.html?freeze=1&agl=300&fade=1')
    await b.ev('await __lod.waitIdle(180000)')
    await b.ev('__lod.viewer.scene.globe.preloadSiblings = true')
    await sleep(1500)
    const initial = await settle(b)
    await b.ev('__lod.resetCounters()')
    await b.ev('await __lod.orbitBy(180, 3000)')
    const mid = await b.ev(FADE)
    const s = await settle(b)
    log('orbitsib-fade1', { load: load(), initial: initial.fade, atOrbitEnd: mid, ...s, frame: await b.ev(FRAME), errors: b.errors.slice(0, 20), errorCount: b.errors.length, network: b.network })
  } finally { await b.close() }
}

mkdirSync(join(HERE, 'shots'), { recursive: true })
log(`meta.${WANT.join('+')}`, { startedAt: new Date().toISOString(), host: HOST, load: load() })
for (const w of WANT) {
  if (w === 'fly1') await fly(1)
  else if (w === 'fly0') await fly(0)
  else if (w === 'orbit') await orbit()
  else if (w === 'swap') await swap()
  else if (w === 'shots1') await shots(1)
  else if (w === 'shots0') await shots(0)
  else if (w === 'jump1') await jump(1)
  else if (w === 'jump0') await jump(0)
  else if (w === 'orbitsib') await orbitSiblings()
  else if (w === 'sse1') await sse(1)
  else if (w === 'sse0') await sse(0)
  else console.error('unknown scenario', w)
}
console.log('done')
process.exit(0)
