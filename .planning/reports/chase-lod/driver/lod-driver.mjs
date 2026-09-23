// Chase LOD measurements: headless Chrome (Metal) over CDP against harness/lod.html, served by vite on :5190.
// usage: [HOST=http://localhost:5190] [CDP_PORT=9350] [CACHES=100,300] [AGLS=300,1500] [EXTRA='&sse=4'] [SHOTS=dir]
//        node lod-driver.mjs <runName> <scenario…>
// scenarios:
//   smoke        load the page once, wait idle, one screenshot, stats
//   s1           'lookback' at every AGLS × CACHES (default 300,1500 × 100): idle → 180° away (3 s) → idle → 180° back
//                (3 s) → idle → 360° (6 s) → idle → 360° (6 s) → idle. Per leg: harness counters, network by host.
//   s2           'fly': 90 m/s, ~250 m AGL (terrain-following), west along the Inn valley (FLY), camera behind,
//                20 s: per-second blur debt, loads, fps
//   profile      the S2 flight under the CPU profiler for 8 s: self and inclusive time per function
//   s2shots      the same flight in a fresh browser: a PNG every 200 ms for 8 s (SHOTS dir, default shots/<runName>),
//                grabbed in the page right after each render (CDP screenshots take ~1 s each on a loaded machine)
// Each (scenario, altitude, cache) runs in its own Chrome with a fresh profile: profile-<runName>-<tag>, deleted after.
// Results: results-<runName>.json next to this file (merged into, per key).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = process.argv[2]
const WANT = process.argv.slice(3)
if (!RUN || WANT.length === 0) { console.error('usage: node lod-driver.mjs <runName> <smoke|s1|s2|s2shots>…'); process.exit(2) }
const HOST = process.env.HOST ?? 'http://localhost:5190'
const PORT = Number(process.env.CDP_PORT ?? 9350) // other sessions use 9334–9345
const CACHES = (process.env.CACHES ?? '100').split(',').map(Number)
const AGLS = (process.env.AGLS ?? '300,1500').split(',').map(Number)
const EXTRA = process.env.EXTRA ?? '' // more URL params for every page, e.g. '&sse=4'
const SHOTS = process.env.SHOTS ?? join(HERE, 'shots', RUN)
const FLY = process.env.FLY ?? '&agl=250&speed=90&lat=47.265&lon=11.45&hdg=265' // S2: west along the Inn valley past Innsbruck
const [W, H] = [1280, 800]
const RESULTS = join(HERE, `results-${RUN}.json`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const load = () => loadavg().map((x) => +x.toFixed(1))

const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {}
function log(k, v) {
  results[k] = v
  console.log(k, JSON.stringify(v).slice(0, 600))
  writeFileSync(RESULTS, JSON.stringify(results, null, 2))
}

/** One headless Chrome with a fresh profile, a CDP session on its page, network tracking by leg. */
async function browser(tag) {
  const profile = join(HERE, `profile-${RUN}-${tag}`)
  rmSync(profile, { recursive: true, force: true })
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
    '--use-angle=metal', '--ignore-gpu-blocklist',
    // Capped at the display rate by default: an uncapped run takes the whole GPU and the user's own apps stutter.
    // UNCAPPED=1 only for short FPS comparisons.
    ...(process.env.UNCAPPED === '1' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
    '--enable-precise-memory-info', '--no-first-run', '--no-default-browser-check', 'about:blank',
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
  const net = new Map() // requestId → { leg, host, cache: null | 'memory' | 'disk', failed, status, bytes }
  const errors = []
  const b = { leg: 'load' }
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
    else if (m.method === 'Runtime.exceptionThrown') errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text)
    else if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) errors.push(p.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300))
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id
    pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  b.send = send
  b.errors = errors
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
  /** Requests of one leg by host: total, from the browser cache (memory or disk), failed, KB over the wire. */
  b.netLeg = (leg) => {
    const by = {}
    for (const r of net.values()) {
      if (r.leg !== leg) continue
      const h = (by[r.host] ??= { requests: 0, fromCache: 0, failed: 0, non2xx: 0, kb: 0 })
      h.requests++
      if (r.cache) h.fromCache++
      if (r.failed) h.failed++
      if (r.status !== null && (r.status < 200 || r.status >= 300)) h.non2xx++
      h.kb += r.bytes / 1024
    }
    for (const h of Object.values(by)) h.kb = Math.round(h.kb)
    return by
  }
  b.shot = async (file) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(data, 'base64'))
  }
  b.close = async () => { try { ws.close() } catch {} kill(); await sleep(800); rmSync(profile, { recursive: true, force: true }) }
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  return b
}

function hostOf(url) {
  try { const u = new URL(url); return u.protocol.startsWith('http') ? u.host : u.protocol.replace(':', '') } catch { return 'other' }
}

/** The harness counters to keep per leg (drops the per-frame snapshot's bulk). */
const LEG_STATS = `const s = __lod.stats(); return { tilesLoaded: s.tilesLoadedTotal, tileReloads: s.tileReloads, tilesFreed: s.tilesFreed,
  terrainReady: s.terrainReadyTotal, terrainReloads: s.terrainReloads, imageryRequests: s.imageryRequests, imageryRerequests: s.imageryRerequests,
  imageryDistinct: s.imageryDistinct, imageryFailed: s.imageryFailed, peakReplacementQueue: s.peakReplacementQueue, replacementQueue: s.replacementQueueCount,
  peakTilesToRender: s.peakTilesToRender, tilesToRender: s.tilesToRender, residentTiles: s.residentTiles, imageryCacheEntries: s.imageryCacheEntries,
  imageryPops: s.imageryPops, refines: s.refines, fps: s.fps, frameMs: s.frameMs, cpuMs: s.cpuMs, usedJSHeapMB: s.usedJSHeapMB, frames: s.frames, sinceResetS: s.sinceResetS }`

async function lookback(agl, cache) {
  const tag = `s1-agl${agl}-cache${cache}`
  const b = await browser(tag)
  try {
    const t0 = Date.now()
    await b.nav(`/harness/lod.html?freeze=1&agl=${agl}${cache === 100 ? '' : `&tileCache=${cache}`}${EXTRA}`)
    const first = await b.ev('return await __lod.waitIdle(180000)')
    await sleep(2000)
    const settle = await b.ev('return await __lod.waitIdle(60000)')
    const initial = { loadS: +((Date.now() - t0) / 1000).toFixed(1), first, settle, load: load(), ...(await b.ev(LEG_STATS)), aircraft: await b.ev('return __lod.stats().aircraft'), imagery: await b.ev('return __lod.stats().imagery'), net: b.netLeg('load') }
    await b.shot(join(HERE, 'shots', `${RUN}-${tag}-start.png`))
    const legs = { initial }
    for (const [name, deg, ms] of [['away180', 180, 3000], ['back180', 180, 3000], ['orbit360a', 360, 6000], ['orbit360b', 360, 6000]]) {
      b.leg = name
      await b.ev('__lod.resetCounters()')
      const tl = Date.now()
      await b.ev(`await __lod.orbitBy(${deg}, ${ms})`)
      const idle = await b.ev('return await __lod.waitIdle(90000)')
      await sleep(300) // late network events
      legs[name] = { orbitMs: ms, idleAfterOrbit: idle, legS: +((Date.now() - tl) / 1000).toFixed(1), load: load(), ...(await b.ev(LEG_STATS)), net: b.netLeg(name) }
      console.log(tag, name, `loads ${legs[name].tilesLoaded} reloads ${legs[name].tileReloads} freed ${legs[name].tilesFreed} imgReq ${legs[name].imageryRequests} reReq ${legs[name].imageryRerequests} idle ${idle.ms} ms fps ${legs[name].fps.p50}`)
    }
    legs.errors = b.errors.slice(0, 10)
    log(tag, legs)
  } finally { await b.close() }
}

async function fly() {
  const b = await browser('s2')
  try {
    await b.nav(`/harness/lod.html?hold=1${FLY}${EXTRA}`)
    const idle = await b.ev('return await __lod.waitIdle(180000)')
    await sleep(2000)
    await b.ev('await __lod.waitIdle(60000)')
    b.leg = 'fly'
    await b.ev('__lod.resetCounters(); __lod.go()')
    await sleep(20500)
    const timeline = (await b.ev('return __lod.timeline()')).slice(0, 20).map(({ sums, ...s }) => s)
    const stats = await b.ev(LEG_STATS)
    const after = await b.ev('return __lod.waitIdle(30000)')
    log('s2-fly', { url: `/harness/lod.html?hold=1${FLY}${EXTRA}`, initialIdle: idle, load: load(), stats, idleAfter: after, net: b.netLeg('fly'), timeline, aircraft: await b.ev('return __lod.stats().aircraft'), errors: b.errors.slice(0, 10) })
  } finally { await b.close() }
}

async function flyShots() {
  mkdirSync(SHOTS, { recursive: true })
  const b = await browser('s2shots')
  try {
    await b.nav(`/harness/lod.html?hold=1${FLY}${EXTRA}`)
    await b.ev('await __lod.waitIdle(180000)')
    await sleep(2000)
    await b.ev('await __lod.waitIdle(60000)')
    await b.shot(join(SHOTS, 'before-go.png'))
    b.leg = 'shots'
    await b.ev('__lod.resetCounters(); __lod.go(); __lod.capture(200, 40)')
    await sleep(8600)
    const frames = await b.ev('return __lod.captures()')
    for (let i = 0; i < frames.length; i++) {
      const file = `t${String(frames[i].tMs).padStart(5, '0')}ms.png`
      writeFileSync(join(SHOTS, file), Buffer.from(await b.ev(`return await __lod.shotData(${i})`), 'base64'))
      frames[i].file = file
    }
    const timeline = (await b.ev('return __lod.timeline()')).map(({ sums, ...s }) => s)
    log('s2-shots', { dir: SHOTS, load: load(), frames, timeline, stats: await b.ev(LEG_STATS) })
  } finally { await b.close() }
}

async function smoke() {
  const b = await browser('smoke')
  try {
    await b.nav(`/harness/lod.html?freeze=1${EXTRA}`)
    const idle = await b.ev('return await __lod.waitIdle(180000)')
    await b.shot(join(HERE, 'shots', `${RUN}-smoke.png`))
    log('smoke', { idle, load: load(), stats: await b.ev('return __lod.stats()'), net: b.netLeg('load'), errors: b.errors.slice(0, 10) })
  } finally { await b.close() }
}

/** Where the frame time goes while flying: self time per function over 8 s (Profiler, 0.5 ms sampling). */
async function profileFly() {
  const b = await browser('profile')
  try {
    await b.nav(`/harness/lod.html?hold=1${FLY}${EXTRA}`)
    await b.ev('await __lod.waitIdle(180000)')
    await b.ev('__lod.resetCounters(); __lod.go()')
    await sleep(2000)
    await b.send('Profiler.enable'); await b.send('Profiler.setSamplingInterval', { interval: 500 })
    await b.send('Profiler.start'); await sleep(8000)
    const { profile } = await b.send('Profiler.stop')
    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const parent = new Map(); for (const n of profile.nodes) for (const ch of n.children ?? []) parent.set(ch, n.id)
    const name = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-1)[0].split('?')[0]}:${n.callFrame.lineNumber + 1}`
    const self = new Map(), incl = new Map()
    for (let i = 0; i < profile.samples.length; i++) {
      const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000
      const n = byId.get(profile.samples[i])
      self.set(name(n), (self.get(name(n)) ?? 0) + dt)
      const seen = new Set(); let k = n.id
      while (k !== undefined) { const nm = name(byId.get(k)); if (!seen.has(nm)) { seen.add(nm); incl.set(nm, (incl.get(nm) ?? 0) + dt) } k = parent.get(k) }
    }
    const top = (m, k) => [...m.entries()].sort((a, c) => c[1] - a[1]).slice(0, k).map(([n, v]) => [Math.round(v), n])
    log('profile-fly', { load: load(), stats: await b.ev(LEG_STATS), selfTop: top(self, 30), inclusiveTop: top(incl, 50) })
  } finally { await b.close() }
}

mkdirSync(join(HERE, 'shots'), { recursive: true })
log(`meta.${WANT.join('+')}`, { startedAt: new Date().toISOString(), host: HOST, caches: CACHES, agls: AGLS, extra: EXTRA, load: load() })
if (WANT.includes('smoke')) await smoke()
if (WANT.includes('s1')) for (const cache of CACHES) for (const agl of AGLS) await lookback(agl, cache)
if (WANT.includes('s2')) await fly()
if (WANT.includes('s2shots')) await flyShots()
if (WANT.includes('profile')) await profileFly()
console.log('done')
process.exit(0)
