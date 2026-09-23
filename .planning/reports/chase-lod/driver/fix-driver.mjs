// Measures the integrated fix (adaptive tile cache + imagery fade) against the old behaviour, over CDP on harness/lod.html.
// usage: node fix-driver.mjs <run> <step…>     steps:
//   s1:OLD:300 s1:NEW:300 …   look-back legs (as lod-driver s1) + capture right after back180 + GPU estimate at the end
//   fly:0 fly:1               S2 flight 20 s, auto cache, ?fade=0|1: per-second blur debt + fade stats, then idle refs
//   topo:100 topo:auto        after one 360° orbit: frame times over a flatten and a grow (toggleTopo)
//   fps                       one capped warm-up flight on a kept profile, then ONE uncapped Chrome: OLD,NEW,OLD,NEW 20 s
//   sheet:<name>:<json>       renders sheet html (file) to <name>.png in a capped Chrome
// OLD = ?tileCache=100&fade=0, NEW = defaults (auto + fade). One Chrome at a time; capped unless the fps step.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = process.argv[2]
const WANT = process.argv.slice(3)
const HOST = 'http://localhost:5190'
const PORT = 9350
const FLY = '&agl=250&speed=90&lat=47.265&lon=11.45&hdg=265'
const CFG = { OLD: '&tileCache=100&fade=0', NEW: '' }
const [W, H] = [1280, 800]
const RESULTS = join(HERE, `results-${RUN}.json`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const load = () => loadavg().map((x) => +x.toFixed(1))
const SPACING_MS = Number(process.env.SPACING_MS ?? 15000) // between browsers: the terrain server answered 429 earlier

function log(k, v) {
  const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {}
  results[k] = v
  console.log(k, JSON.stringify(v).slice(0, 800))
  writeFileSync(RESULTS, JSON.stringify(results, null, 2))
}

function hostOf(url) {
  try { const u = new URL(url); return u.protocol.startsWith('http') ? u.host : u.protocol.replace(':', '') } catch { return 'other' }
}

async function browser(tag, { uncapped = false, keep = false, size = [W, H], from = null } = {}) {
  const profile = join(HERE, `profile-${RUN}-${tag}`)
  if (!keep) rmSync(profile, { recursive: true, force: true })
  if (from) cpSync(from, profile, { recursive: true }) // a warmed HTTP cache: the terrain server answers 429 to cold repeats
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${size[0]},${size[1]}`,
    '--use-angle=metal', '--ignore-gpu-blocklist',
    ...(uncapped ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
    '--enable-precise-memory-info', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', 'about:blank',
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
  const net = new Map()
  const errors = []
  const b = { leg: 'load', errors, net }
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    const p = m.params
    if (m.method === 'Network.requestWillBeSent') {
      if (!net.has(p.requestId)) net.set(p.requestId, { leg: b.leg, host: hostOf(p.request.url), cache: null, failed: false, status: null, bytes: 0 })
    } else if (m.method === 'Network.requestServedFromCache') { const r = net.get(p.requestId); if (r) r.cache = 'memory' }
    else if (m.method === 'Network.responseReceived') {
      const r = net.get(p.requestId)
      if (r) { r.status = p.response.status; if (p.response.fromDiskCache) r.cache ??= 'disk'; if (p.response.fromServiceWorker) r.cache ??= 'sw' }
    } else if (m.method === 'Network.loadingFinished') { const r = net.get(p.requestId); if (r) r.bytes = p.encodedDataLength }
    else if (m.method === 'Network.loadingFailed') { const r = net.get(p.requestId); if (r) r.failed = true }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`.slice(0, 300))
    else if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) errors.push(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description).join(' ')}`.slice(0, 300))
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id
    pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  b.send = send
  b.ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, timeout: 600000 })
    if (r.exceptionDetails) throw new Error(`${expr.slice(0, 100)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  b.nav = async (path) => {
    await send('Page.navigate', { url: path.startsWith('file:') ? path : HOST + path })
    if (path.startsWith('file:')) { await sleep(1500); return }
    for (let i = 0; i < 600; i++) { if (await b.ev('return !!(window.__lod && window.__lod.ready)').catch(() => false)) return; await sleep(200) }
    throw new Error(`${path}: window.__lod never became ready; errors: ${errors.slice(0, 5).join(' | ')}`)
  }
  b.netLeg = (leg) => {
    const by = {}
    for (const r of net.values()) {
      if (leg && r.leg !== leg) continue
      const h = (by[r.host] ??= { requests: 0, fromCache: 0, failed: 0, non2xx: 0, s429: 0, kb: 0 })
      h.requests++
      if (r.cache) h.fromCache++
      if (r.failed) h.failed++
      if (r.status === 429) h.s429++
      if (r.status !== null && (r.status < 200 || r.status >= 300)) h.non2xx++
      h.kb += r.bytes / 1024
    }
    for (const h of Object.values(by)) h.kb = Math.round(h.kb)
    return by
  }
  b.count429 = () => [...net.values()].filter((r) => r.status === 429).length
  b.close = async () => {
    try { ws.close() } catch {}
    kill()
    for (let i = 0; i < 50 && chrome.exitCode === null && chrome.signalCode === null; i++) await sleep(100)
    await sleep(800)
    if (!keep) rmSync(profile, { recursive: true, force: true })
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  return b
}

const LEG_STATS = `const s = __lod.stats(); return { tilesLoaded: s.tilesLoadedTotal, tileReloads: s.tileReloads, tilesFreed: s.tilesFreed,
  terrainReady: s.terrainReadyTotal, terrainReloads: s.terrainReloads, imageryRequests: s.imageryRequests, imageryRerequests: s.imageryRerequests,
  imageryDistinct: s.imageryDistinct, imageryFailed: s.imageryFailed, peakReplacementQueue: s.peakReplacementQueue, replacementQueue: s.replacementQueueCount,
  peakTilesToRender: s.peakTilesToRender, tilesToRender: s.tilesToRender, residentTiles: s.residentTiles, imageryCacheEntries: s.imageryCacheEntries,
  imageryPops: s.imageryPops, imageryPopLevels: s.imageryPopLevels, refines: s.refines, fps: s.fps, frameMs: s.frameMs, cpuMs: s.cpuMs,
  usedJSHeapMB: s.usedJSHeapMB, frames: s.frames, sinceResetS: s.sinceResetS, tileCacheSize: s.tileCacheSize, fade: s.fade }`

/** The globe's GPU memory, walking the tile LRU: distinct imagery textures and terrain vertex/index buffers. */
const GPU = `const surf = __lod.viewer.scene.globe._surface; const tex = new Set(), bufs = new Set(); let tiles = 0, withData = 0
  const addVA = (va) => { if (!va) return; for (const a of va._attributes ?? []) if (a.vertexBuffer) bufs.add(a.vertexBuffer); if (va._indexBuffer) bufs.add(va._indexBuffer) }
  for (let t = surf._tileReplacementQueue.head; t; t = t.replacementNext) { tiles++; const d = t.data; if (!d) continue; withData++
    for (const ti of d.imagery ?? []) for (const im of [ti.readyImagery, ti.loadingImagery]) { if (im?.texture) tex.add(im.texture); if (im?.textureWebMercator && im.textureWebMercator !== im.texture) tex.add(im.textureWebMercator) }
    addVA(d.vertexArray); addVA(d.fill?.vertexArray) }
  let texBytes = 0; for (const x of tex) texBytes += x.sizeInBytes ?? 349525
  let bufBytes = 0; for (const x of bufs) bufBytes += x.sizeInBytes ?? 0
  const MB = (x) => +(x / 1048576).toFixed(1)
  return { lruTiles: tiles, tilesWithData: withData, textures: tex.size, texMB_est: MB(tex.size * 349525), texMB_actual: MB(texBytes), buffers: bufs.size, bufMB: MB(bufBytes), totalMB: MB(texBytes + bufBytes),
    tileCacheSize: __lod.viewer.scene.globe.tileCacheSize, heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) }`

async function saveCaptures(b, dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const frames = await b.ev('return __lod.captures()')
  for (let i = 0; i < frames.length; i++) {
    const file = `t${String(frames[i].tMs).padStart(5, '0')}ms.png`
    writeFileSync(join(dir, file), Buffer.from(await b.ev(`return await __lod.shotData(${i})`), 'base64'))
    frames[i].file = file
  }
  return frames.map(({ tMs, file, fading, pops, blurTiles, waiting, drawn, loads }) => ({ tMs, file, fading, pops, blurTiles, waiting, drawn, loads }))
}

const warmDir = (agl) => join(HERE, `profile-${RUN}-warm-s1-agl${agl}`)
async function s1(cfg, agl, mode) {
  const warmup = mode === 'warmup'
  const tag = warmup ? `warm-s1-agl${agl}` : `s1-${cfg}-agl${agl}`
  const b = await browser(tag, warmup ? { keep: true } : { from: mode === 'warm' ? warmDir(agl) : null })
  try {
    const t0 = Date.now()
    await b.nav(`/harness/lod.html?freeze=1&agl=${agl}${CFG[cfg]}`)
    const first = await b.ev('return await __lod.waitIdle(180000)')
    await sleep(2000)
    const settle = await b.ev('return await __lod.waitIdle(60000)')
    const legs = { initial: { loadS: +((Date.now() - t0) / 1000).toFixed(1), first, settle, load: load(), ...(await b.ev(LEG_STATS)), net: b.netLeg('load') } }
    let capture = null
    for (const [name, deg, ms] of [['away180', 180, 3000], ['back180', 180, 3000], ['orbit360a', 360, 6000], ['orbit360b', 360, 6000]]) {
      b.leg = name
      await b.ev('__lod.resetCounters()')
      const tl = Date.now()
      // back180: capture from the very frame the orbit ends (same task), every 150 ms for 1.5 s
      await b.ev(`await __lod.orbitBy(${deg}, ${ms})`)
      const idle = await b.ev('return await __lod.waitIdle(90000)')
      await sleep(300)
      legs[name] = { orbitMs: ms, idleAfterOrbit: idle, legS: +((Date.now() - tl) / 1000).toFixed(1), load: load(), ...(await b.ev(LEG_STATS)), net: b.netLeg(name) }
      const l = legs[name]
      console.log(tag, name, `loads ${l.tilesLoaded} reloads ${l.tileReloads} freed ${l.tilesFreed} imgReq ${l.imageryRequests} reReq ${l.imageryRerequests} cache ${l.tileCacheSize} idle ${idle.ms} ms`)
    }
    // snap: look away instantly, let that view load (and, with a small cache, evict this one), then snap back and grab
    // the frames from the very first one after the snap (same task), every 150 ms for 1.5 s
    b.leg = 'snapAway'
    await b.ev('__lod.resetCounters(); const o = __lod.chase.orbit; __lod.setOrbit(o.headingOffsetDeg + 180, o.pitchDeg, o.rangeM)')
    const awayIdle = await b.ev('return await __lod.waitIdle(90000)')
    await sleep(1000)
    legs.snapAway = { idle: awayIdle, ...(await b.ev(LEG_STATS)), net: b.netLeg('snapAway') }
    b.leg = 'snapBack'
    await b.ev('__lod.resetCounters(); const o = __lod.chase.orbit; __lod.setOrbit(o.headingOffsetDeg + 180, o.pitchDeg, o.rangeM); __lod.capture(150, 11)')
    await sleep(1900)
    if (!warmup) capture = await saveCaptures(b, join(HERE, 'shots', `${RUN}-lookback-${cfg}-agl${agl}`))
    const backIdle = await b.ev('return await __lod.waitIdle(90000)')
    await sleep(300)
    legs.snapBack = { idle: backIdle, ...(await b.ev(LEG_STATS)), net: b.netLeg('snapBack') }
    console.log(tag, 'snapBack', `loads ${legs.snapBack.tilesLoaded} reloads ${legs.snapBack.tileReloads} imgReq ${legs.snapBack.imageryRequests} reReq ${legs.snapBack.imageryRerequests} idle ${backIdle.ms} ms`)
    await sleep(1500)
    legs.gpuEnd = await b.ev(GPU)
    legs.captureBack = capture
    legs.http429 = b.count429()
    legs.errors = b.errors.slice(0, 10)
    log(warmup ? `warmup-s1-agl${agl}` : `${tag}${mode === 'warm' ? '' : '-cold'}`, legs)
  } finally { await b.close() }
}

const FADE = 'return __lod.stats().fade'

async function fly(fade) {
  const b = await browser(`fly${fade}`)
  try {
    await b.nav(`/harness/lod.html?hold=1${FLY}&fade=${fade}`)
    const first = await b.ev('return await __lod.waitIdle(180000)')
    await sleep(2000)
    await b.ev('await __lod.waitIdle(60000)')
    await b.ev('__lod.resetCounters(); __lod.go()')
    b.leg = 'fly'
    const perSecondFade = []
    let maxActive = 0, maxRefs = 0
    for (let s = 1; s <= 20; s++) {
      for (let k = 0; k < 4; k++) { await sleep(250); const f = await b.ev(FADE); maxActive = Math.max(maxActive, f.active); maxRefs = Math.max(maxRefs, f.refsHeld) }
      const f = await b.ev(FADE)
      perSecondFade.push({ s, active: f.active, refsHeld: f.refsHeld, started: f.started, finished: f.finished, retargeted: f.retargeted, expired: f.expired, cancelled: f.cancelled, orphaned: f.orphaned, skippedOffscreen: f.skippedOffscreen, skippedRefined: f.skippedRefined, skippedCap: f.skippedCap, skippedLayer: f.skippedLayer })
    }
    const timeline = (await b.ev('return __lod.timeline()')).slice(0, 20).map(({ sums, ...s }) => s)
    const stats = await b.ev(LEG_STATS)
    const t0 = Date.now()
    const idle = await b.ev('return await __lod.waitIdle(60000)')
    let idleFade
    for (let i = 0; i < 100; i++) { idleFade = await b.ev(FADE); if (idleFade.active === 0 && idleFade.refsHeld === 0) break; await sleep(100) }
    log(`fly-fade${fade}`, { load: load(), initialIdle: first, stats, maxActive, maxRefs, timeline, perSecondFade, after: { idle, settleMs: Date.now() - t0, fade: idleFade },
      gpuEnd: await b.ev(GPU), net: b.netLeg('fly'), http429: b.count429(), errors: b.errors.slice(0, 10), errorCount: b.errors.length })
  } finally { await b.close() }
}

async function topo(cache) {
  const b = await browser(`topo${cache}`, { from: existsSync(warmDir(300)) ? warmDir(300) : null })
  try {
    await b.nav(`/harness/lod.html?freeze=1&agl=300&tileCache=${cache}`)
    await b.ev('await __lod.waitIdle(180000)')
    await sleep(1500)
    await b.ev('await __lod.waitIdle(60000)')
    await b.ev('await __lod.orbitBy(360, 6000)')
    const idle = await b.ev('return await __lod.waitIdle(90000)')
    await sleep(1000)
    await b.ev('__lod.resetCounters()')
    await sleep(2500)
    const still = await b.ev('const s = __lod.stats(); return { frameMs: s.frameMs, cpuMs: s.cpuMs, frames: s.frames }')
    const before = await b.ev('const s = __lod.stats(); return { queue: s.replacementQueueCount, tileCacheSize: s.tileCacheSize, tilesToRender: s.tilesToRender }')
    const flatten = await b.ev('return await __lod.toggleTopo()')
    await b.ev('await __lod.waitIdle(60000)')
    await sleep(1000)
    const mid = await b.ev('const s = __lod.stats(); return { queue: s.replacementQueueCount, tileCacheSize: s.tileCacheSize }')
    const grow = await b.ev('return await __lod.toggleTopo()')
    await b.ev('await __lod.waitIdle(60000)')
    log(`topo-cache${cache}`, { load: load(), idleAfterOrbit: idle, still, before, flatten, mid, grow, gpuEnd: await b.ev(GPU), http429: b.count429(), errors: b.errors.slice(0, 10) })
  } finally { await b.close() }
}

/** Street-map show then hide after one 360° orbit (app.ts does it on every chase ↔ browse switch; Cesium walks every loaded tile). */
async function mapToggle(cache) {
  const b = await browser(`map${cache}`, { from: existsSync(warmDir(300)) ? warmDir(300) : null })
  try {
    await b.nav(`/harness/lod.html?freeze=1&agl=300&tileCache=${cache}`)
    await b.ev('await __lod.waitIdle(180000)')
    await sleep(1500)
    await b.ev('await __lod.waitIdle(60000)')
    await b.ev('await __lod.orbitBy(360, 6000)')
    await b.ev('await __lod.waitIdle(90000)')
    await sleep(1000)
    await b.ev('__lod.resetCounters()')
    await sleep(2500)
    const still = await b.ev('const s = __lod.stats(); return { frameMs: s.frameMs, cpuMs: s.cpuMs, queue: s.replacementQueueCount, tileCacheSize: s.tileCacheSize }')
    const show = await b.ev('return await __lod.toggleMap()')
    await b.ev('await __lod.waitIdle(60000)')
    await sleep(1000)
    const hide = await b.ev('return await __lod.toggleMap()')
    await b.ev('await __lod.waitIdle(60000)')
    log(`map-cache${cache}`, { load: load(), still, show, hide, http429: b.count429(), errors: b.errors.slice(0, 10) })
  } finally { await b.close() }
}

/** Memory after GC: at the first idle, and after two 360° orbits (warm profile, no server load). */
async function mem(cfg) {
  const b = await browser(`mem${cfg}`, { from: warmDir(300) })
  try {
    await b.nav(`/harness/lod.html?freeze=1&agl=300${CFG[cfg]}`)
    await b.ev('await __lod.waitIdle(180000)')
    await sleep(1500)
    await b.ev('await __lod.waitIdle(60000)')
    await b.send('HeapProfiler.enable')
    await b.send('HeapProfiler.collectGarbage')
    const atLoad = await b.ev(GPU)
    await b.ev('await __lod.orbitBy(360, 6000)')
    await b.ev('await __lod.waitIdle(90000)')
    await b.ev('await __lod.orbitBy(360, 6000)')
    await b.ev('await __lod.waitIdle(90000)')
    await sleep(1000)
    await b.send('HeapProfiler.collectGarbage')
    const afterOrbits = await b.ev(GPU)
    log(`mem-${cfg}`, { load: load(), atLoad, afterOrbits, http429: b.count429() })
  } finally { await b.close() }
}

async function fps() {
  // Warm the HTTP cache capped (same profile), so the uncapped browser spends its time flying, not loading.
  const w = await browser('fps', { keep: true })
  try {
    await w.nav(`/harness/lod.html?hold=1${FLY}`)
    await w.ev('await __lod.waitIdle(180000)')
    await w.ev('__lod.go()')
    await sleep(21000)
    await w.ev('await __lod.waitIdle(30000)')
  } finally { await w.close() }
  await sleep(3000)
  const tU = Date.now()
  const b = await browser('fps', { keep: true, uncapped: true })
  const runs = []
  try {
    for (const cfg of ['OLD', 'NEW', 'OLD', 'NEW']) {
      const tn = Date.now()
      await b.nav(`/harness/lod.html?hold=1${FLY}${CFG[cfg]}`)
      const idle = await b.ev('return await __lod.waitIdle(60000)')
      const loadS = +((Date.now() - tn) / 1000).toFixed(1)
      const la = load()
      await b.ev('__lod.resetCounters(); __lod.go()')
      await sleep(20000)
      const s = await b.ev('const s = __lod.stats(); return { fps: s.fps, frameMs: s.frameMs, cpuMs: s.cpuMs, frames: s.frames, tileCacheSize: s.tileCacheSize, loads: s.tilesLoadedTotal, heap: s.usedJSHeapMB, fade: s.fade.enabled }')
      runs.push({ cfg, loadS, idle, loadBefore: la, loadAfter: load(), ...s })
      console.log(cfg, JSON.stringify(runs.at(-1)))
    }
  } finally { await b.close() }
  const uncappedS = +((Date.now() - tU) / 1000).toFixed(1)
  rmSync(join(HERE, `profile-${RUN}-fps`), { recursive: true, force: true })
  log('fps-uncapped', { uncappedS, runs, http429: b.count429() })
}

/** A sheet: an HTML file of the PNGs, screenshotted full-size in the same kind of headless Chrome. */
async function sheet(name, htmlFile, width, height) {
  const b = await browser(`sheet-${name}`, { size: [width, height] })
  try {
    await b.nav(`file://${htmlFile}`)
    await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await sleep(800)
    const { data } = await b.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } })
    writeFileSync(join(HERE, `${name}.png`), Buffer.from(data, 'base64'))
    console.log('sheet', name)
  } finally { await b.close() }
}

mkdirSync(join(HERE, 'shots'), { recursive: true })
let firstStep = true
for (const w of WANT) {
  if (!firstStep && !w.startsWith('sheet')) await sleep(SPACING_MS)
  firstStep = false
  const [kind, a, c, d] = w.split(':')
  const t0 = Date.now()
  try {
    if (kind === 's1') await s1(a, Number(c), d)
    else if (kind === 'fly') await fly(Number(a))
    else if (kind === 'topo') await topo(a)
    else if (kind === 'map') await mapToggle(a)
    else if (kind === 'fps') await fps()
    else if (kind === 'mem') await mem(a)
    else if (kind === 'sheet') await sheet(a, c, ...d.split('x').map(Number))
    else console.error('unknown step', w)
  } catch (e) { console.error(w, 'FAILED', e.message); log(`error-${w}`, String(e.message)) }
  console.log(`step ${w} took ${((Date.now() - t0) / 1000).toFixed(0)} s, load ${load()}`)
}
console.log('done')
process.exit(0)
