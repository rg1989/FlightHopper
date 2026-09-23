// Gate GE driver: headless Chrome (Metal) over CDP against the running app (default http://localhost:5173, i.e. `make`).
// usage: [HOST=http://localhost:5173] [CDP_PORT=9334] node gate.mjs <outDir> <scenario…>
// scenarios: topo lag clear diag profile toggles (harness pages) · app-ridge app-ground app-grow app-ksfo app-browse-night app-keys
//            app-phone ge-8-lowi-morning ge-9-lowi-golden ge-10-lowi-night (the app; most need the LOWI replay, see WP-E-A Task 5)
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const OUT = process.argv[2]
const WANT = process.argv.slice(3)
mkdirSync(OUT, { recursive: true })
const HOST = process.env.HOST ?? 'http://localhost:5173'
const PORT = Number(process.env.CDP_PORT ?? 9334) // other sessions' headless Chromes may hold 9334
const [W, H] = WANT.some((s) => s.startsWith('app')) ? [1440, 900] : [1280, 800]
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/profile`, `--window-size=${W},${H}`,
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
const net = new Map() // requestId → { url, status }
const errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Network.requestWillBeSent') net.set(m.params.requestId, { url: m.params.request.url, method: m.params.request.method, status: null })
  if (m.method === 'Network.responseReceived') { const r = net.get(m.params.requestId); if (r) { r.status = m.params.response.status; r.bytes = m.params.response.encodedDataLength } }
  if (m.method === 'Network.loadingFinished') { const r = net.get(m.params.requestId); if (r) r.bytes = m.params.encodedDataLength }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id
  pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
  ws.send(JSON.stringify({ id: i, method, params }))
})
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, timeout: 600000 })
  if (r.exceptionDetails) throw new Error(`${expr.slice(0, 100)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'))
}
const results = {}
const log = (k, v) => { results[k] = v; console.log(k, JSON.stringify(v)); writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2)) }
async function nav(path) {
  net.clear(); errors.length = 0
  await send('Page.navigate', { url: HOST + path })
  await sleep(1500)
}
/** Waits for window[obj].stats().tilesLoaded (harness) or viewer tilesLoaded (app), 3 polls in a row. */
async function settle(check, extraMs = 3000, maxMs = 120000) {
  const t0 = Date.now(); let ok = 0
  while (Date.now() - t0 < maxMs) {
    const v = await ev(`try { return ${check} } catch { return false }`).catch(() => false)
    ok = v ? ok + 1 : 0
    if (ok >= 3) break
    await sleep(500)
  }
  await sleep(extraMs)
  return +((Date.now() - t0) / 1000).toFixed(1)
}
const netSummary = (re) => [...net.values()].filter((r) => re.test(r.url))
async function wheel(times, deltaY) {
  for (let i = 0; i < times; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: W / 2, y: H / 2, deltaX: 0, deltaY })
    await sleep(40)
  }
}
async function key(k) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k })
}

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
const want = (k) => WANT.includes(k)
const HT = 'window.harness && harness.stats().tilesLoaded'

// ---------- E1 harness: topography ----------
if (want('topo')) {
  log('topo.load', { loadS: (await nav('/harness/topography.html'), await settle(HT, 4000)) })
  const re = netSummary(/terrain\.reearth\.land/)
  log('topo.net', { requests: re.length, withNormalsQuery: re.filter((r) => r.url.includes('extensions=octvertexnormals')).length,
    non200: re.filter((r) => r.status !== 200 && r.status !== null).map((r) => [r.status, r.url.slice(0, 120)]), options: re.filter((r) => r.method === 'OPTIONS').length,
    hasVertexNormals: await ev('return harness.viewer.terrainProvider.hasVertexNormals') })
  await shot('e1-1-full')
  log('topo.statsFull', await ev('return harness.stats()'))
  await ev('harness.setTopo(false)'); await sleep(1250)
  log('topo.midSink', await ev('return harness.stats()')); await shot('e1-2-sinking')
  await sleep(2500); await settle(HT, 1500); await shot('e1-3-flat'); log('topo.flat', await ev('return harness.stats()'))
  await ev('harness.setTopo(true)'); await sleep(3500); await settle(HT, 1000)
  const per = []
  for (let i = 0; i < 10; i++) {
    await ev(`harness.setTopo(${i % 2 === 1})`); await sleep(4000)
    const s = await ev('return harness.stats()'); per.push({ worstMs: +s.lastToggle.worstMs.toFixed(1), avgMs: +s.lastToggle.avgMs.toFixed(1), frames: s.lastToggle.frames })
  }
  await sleep(1500)
  const s = await ev('return harness.stats()')
  log('topo.toggles', { per, undefinedSettled: s.undefinedSettled, undefinedNearChange: s.undefinedNearChange, f: s.f, on: s.on })
  log('topo.errors', errors.slice(0, 10))
}
if (want('lag')) {
  log('lag.load', { loadS: (await nav('/harness/topography.html?hold=1&at=135'), await settle(HT, 4000)) })
  await sleep(2500) // trueGroundM (1 Hz)
  // Per-frame log through a sink and a grow: raw and corrected error against the true ground at this factor.
  const r = await ev(`
    const rows = []; let run = true
    const f = () => { const s = harness.stats(); if (s.expectedGroundM !== null && s.groundM !== null) rows.push([s.animating ? 1 : 0, s.groundM - s.expectedGroundM, (s.rawGroundM ?? NaN) - s.expectedGroundM, s.f]); if (run) requestAnimationFrame(f) }
    requestAnimationFrame(f)
    await new Promise((r) => setTimeout(r, 1500)); harness.setTopo(false); await new Promise((r) => setTimeout(r, 3500)); harness.setTopo(true); await new Promise((r) => setTimeout(r, 3500)); run = false
    const rest = rows.filter((x) => !x[0]).map((x) => Math.abs(x[1])), anim = rows.filter((x) => x[0])
    return { frames: rows.length, animFrames: anim.length, restMaxAbs: Math.max(...rest), animMaxAbsCorrected: Math.max(...anim.map((x) => Math.abs(x[1]))), animMaxAbsRaw: Math.max(...anim.map((x) => Math.abs(x[2])).filter(Number.isFinite)) }`)
  log('lag.result', r)
}
if (want('diag')) {
  // (1) Frame spikes while flying with NO toggles vs with toggles. (2) undefined readings per animation frame, runs.
  log('diag.load', { loadS: (await nav('/harness/topography.html'), await settle(HT, 5000)) })
  const measure = (withToggles) => ev(`
    const iv = []; let last = null, run = true, nulls = 0, frames = 0, run0 = 0, maxRun = 0
    const f = (t) => { if (last !== null) iv.push(t - last); last = t
      const s = harness.stats(); if (s.animating) { frames++; if (s.rawGroundM === null) { nulls++; run0++; maxRun = Math.max(maxRun, run0) } else run0 = 0 }
      if (run) requestAnimationFrame(f) }
    requestAnimationFrame(f)
    const lt = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(Math.round(e.duration)) }); po.observe({ type: 'longtask' })
    for (let i = 0; i < 10; i++) { if (${withToggles}) harness.setTopo(i % 2 === 1); await new Promise((r) => setTimeout(r, 4000)) }
    run = false; po.disconnect()
    const d = iv.toSorted((a, b) => a - b)
    return { frames: iv.length, p50: +d[Math.floor(d.length / 2)].toFixed(1), p99: +d[Math.floor(d.length * 0.99)].toFixed(1), worst: +d.at(-1).toFixed(1), over50: d.filter((x) => x > 50).length, longTasks: lt,
      animFrames: frames, animNulls: nulls, maxConsecutiveNulls: maxRun }`)
  log('diag.noToggles', await measure(false))
  log('diag.toggles', await measure(true))
  log('diag.noToggles2', await measure(false))
}
if (want('profile')) {
  // Which JS makes the long tasks while flying (no toggles)? Self time per function, and the stacks inside samples of long tasks.
  const page = WANT.includes('profile-app') ? '/?hex=000e01' : '/harness/topography.html'
  log('profile.load', { loadS: (await nav(page), await settle(WANT.includes('profile-app') ? 'window.viewer && viewer.scene.globe.tilesLoaded' : HT, 4000)) })
  await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 })
  await ev(`window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]) }).observe({ type: 'longtask' })`)
  const tStart = await ev('return performance.now()')
  await send('Profiler.start'); await sleep(25000)
  const { profile } = await send('Profiler.stop')
  const lts = await ev('return window.__lt')
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const name = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1}`
  const self = new Map(), inLong = new Map()
  // sample times: profile.startTime (µs, same clock as performance.now in ms*1000? use deltas relative to first sample)
  let t = profile.startTime
  const t0perf = tStart // ms, approx start
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i]
    const n = byId.get(profile.samples[i]); const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000
    self.set(name(n), (self.get(name(n)) ?? 0) + dt)
    const tms = t0perf + (t - profile.startTime) / 1000
    if (lts.some(([s, d]) => d > 100 && tms >= s && tms <= s + d)) {
      // attribute to every frame on the stack (inclusive) inside long tasks
      const seen = new Set(); let k = n.id
      while (k !== undefined) { const nm = name(byId.get(k)); if (!seen.has(nm)) { seen.add(nm); inLong.set(nm, (inLong.get(nm) ?? 0) + dt) } k = parent.get(k) }
    }
  }
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([n, v]) => [Math.round(v), n])
  log('profile.longTasks', lts)
  log('profile.selfTop', top(self, 25))
  log('profile.inLongTasksInclusiveTop', top(inLong, 45))
}
if (want('clear')) {
  log('clear.load', { loadS: (await nav('/harness/topography.html?at=135'), await settle(HT, 3000)) })
  await wheel(14, -120) // closer: Cesium wheel up
  await sleep(1500)
  const b0 = await ev('return harness.stats()')
  for (let i = 0; i < 10; i++) { await ev(`harness.setTopo(${i % 2 === 1})`); await sleep(3200) }
  const s = await ev('return harness.stats()')
  await shot('e1-4-close-chase')
  log('clear.result', { below15Before: b0.below15, below15: s.below15, minClearanceM: s.minClearanceM, clearanceUnknown: s.clearanceUnknown, undefinedSettled: s.undefinedSettled })
}

// ---------- E2 harness: sun ----------
if (want('sun')) {
  const SH = 'window.harness && harness.stats().tilesLoaded'
  for (const [name, t] of [['e2-1-morning', '2026-06-21T06:30:00Z'], ['e2-2-golden', '2026-06-21T18:40:00Z'], ['e2-3-night', '2026-06-21T21:30:00Z']]) {
    await nav(`/harness/sun.html?sun=${t}`); const loadS = await settle(SH, name.includes('night') ? 6000 : 3000)
    await shot(name)
    const gibs = netSummary(/gibs\.earthdata/)
    log(name, { loadS, stats: await ev('return harness.stats()'), gibs: gibs.length, gibsNon200: gibs.filter((r) => r.status !== 200).length, gibsMaxZ: Math.max(0, ...gibs.map((r) => +(r.url.match(/Level8\/(\d+)\//)?.[1] ?? -1))), reearthWithoutQuery: netSummary(/terrain\.reearth\.land/).filter((r) => !r.url.includes('extensions=octvertexnormals')).length, errors: errors.slice(0, 5) })
    if (name.includes('night')) { await key('l'); await sleep(2000); await shot('e2-4-night-sun-off'); log('e2-4-sunoff', await ev('return harness.stats()')); await key('l') }
  }
  await nav('/harness/sun.html?sun=2026-09-22T16:30:00Z'); await settle(SH, 3000)
  const r = await ev(`
    const iv = []; let last = null, run = true
    const f = (t) => { if (last !== null) iv.push(t - last); last = t; if (run) requestAnimationFrame(f) }
    requestAnimationFrame(f)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }))
    await new Promise((r) => setTimeout(r, 9000)); run = false
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }))
    const d = iv.toSorted((a, b) => a - b)
    return { frames: iv.length, p50: d[Math.floor(d.length / 2)], worst: d.at(-1), stats: harness.stats() }`)
  await shot('e2-5-after-dusk-lapse')
  log('e2-dusk', r)
}

// ---------- E4 harness: toggles ----------
if (want('toggles')) {
  await nav('/harness/scene-toggles.html'); await sleep(1500)
  await shot('e4-1-toggles')
  log('e4', { text: await ev('return document.body.innerText.slice(0, 600)'), errors })
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true })
  await sleep(800); await shot('e4-2-375x812')
  log('e4.phone', await ev(`const b = [...document.querySelectorAll('button')].map((x) => { const r = x.getBoundingClientRect(); return [x.textContent, Math.round(r.top), Math.round(r.height), Math.round(r.right)] }); return { buttons: b, scrollW: document.documentElement.scrollWidth, innerW: innerWidth }`))
  await send('Emulation.clearDeviceMetricsOverride')
}

// ---------- the app (E-A gate GE) ----------
const APP_READY = 'window.viewer && viewer.scene.globe.tilesLoaded'
if (want('app-ridge')) {
  log('app.load', { loadS: (await nav('/?hex=000e01&bench=1'), await settle(APP_READY, 2000)) })
  log('app.first', await ev(`const v = viewer; return { f: v.scene.verticalExaggeration, lighting: v.scene.globe.enableLighting, shadows: v.shadows, toggles: [...document.querySelectorAll('.fh-toggles button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]), clock: Cesium_toIso() }
    function Cesium_toIso() { const c = v.clock.currentTime; return c.dayNumber + ':' + Math.round(c.secondsOfDay) }`))
  await shot('ge-1-chase-ridge')
  const r = await ev(`
    const v = window.viewer, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    while (!v.scene.globe.tilesLoaded) await sleep(250)
    performance.clearMarks('fh:no-ground'); performance.clearMarks('fh:ground-unknown')
    const iv = []; let last = null, run = true
    const tick = (t) => { if (last !== null) iv.push([t, t - last]); last = t; if (run) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    const lt = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(Math.round(e.duration)) }); po.observe({ type: 'longtask' })
    const worst = [], toggles = []
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now(); toggles.push(t0)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))
      await sleep(3500)
      worst.push(+Math.max(...iv.filter(([t]) => t > t0 && t < t0 + 3000).map(([, d]) => d)).toFixed(1))
    }
    await sleep(5000); run = false; po.disconnect()
    const d = iv.map(([, x]) => x).toSorted((a, b) => a - b), q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))]
    const marks = performance.getEntriesByName('fh:no-ground').map((m) => m.startTime)
    const inAnim = marks.filter((m) => toggles.some((t0) => m >= t0 && m <= t0 + 3100)).length // 2.5 s animation + 0.5 s nudge
    let maxRun = 0, run0 = 0, prev = -1e9
    for (const m of marks) { run0 = m - prev < 40 ? run0 + 1 : 1; maxRun = Math.max(maxRun, run0); prev = m }
    return { fpsP50: +(1000 / q(0.5)).toFixed(1), fpsP5: +(1000 / q(0.95)).toFixed(1), longTasks: lt, worstAnimFrameMs: worst,
      noGround: marks.length, groundUnknown: performance.getEntriesByName('fh:ground-unknown').length, groundUnknownSettled: performance.getEntriesByName('fh:ground-unknown').map((m) => m.startTime).filter((m) => !toggles.some((t0) => m >= t0 && m <= t0 + 3100)).length, noGroundInAnimOrNudge: inAnim, noGroundSettled: marks.length - inAnim, noGroundMaxConsecutive: maxRun, frames: iv.length, f: v.scene.verticalExaggeration, relH: v.scene.verticalExaggerationRelativeHeight,
      shadows: v.shadows, bench: document.querySelector('.fh-bench pre')?.textContent ?? null }`)
  log('app.toggles', r)
  await shot('ge-2-after-toggles')
  log('app.errors', errors.slice(0, 10))
}
if (want('app-ground')) {
  // Server with REPLAY_SPEED=5: SYN601 is on the runway from ~105 s. Chase it, flatten, grow.
  const t0 = Date.now() - Number(process.env.SERVER_AGE_MS ?? 0)
  log('ground.load', { loadS: (await nav('/?hex=000e01'), await settle(APP_READY, 2000)) })
  await sleep(Math.max(0, 112000 - (Date.now() - t0))) // REPLAY_SPEED=5: touchdown ~102 s, stop ~119 s after server start
  await shot('ge-3-on-runway')
  const q = `const v = viewer; return { f: v.scene.verticalExaggeration, relH: v.scene.verticalExaggerationRelativeHeight, hud: document.querySelector('.fh-hud')?.textContent }`
  log('ground.before', await ev(q))
  await key('t'); await sleep(1250); await shot('ge-4-runway-sinking'); await sleep(2500); await shot('ge-5-runway-flat'); log('ground.flat', await ev(q))
  await key('t'); await sleep(1250); await shot('ge-6-runway-growing'); await sleep(2500); await shot('ge-7-runway-grown'); log('ground.grown', await ev(q))
  log('ground.errors', errors.slice(0, 10))
}
for (const [name, t] of [['ge-8-lowi-morning', '2026-09-22T06:00:00Z'], ['ge-9-lowi-golden', '2026-09-22T16:45:00Z'], ['ge-10-lowi-night', '2026-09-22T20:30:00Z']]) {
  if (!want(name)) continue
  log(`${name}.load`, { loadS: (await nav(`/?hex=000e01&sun=${t}`), await settle(APP_READY, name.includes('night') ? 6000 : 3000)) })
  await shot(name)
  const gibs = netSummary(/gibs\.earthdata/)
  log(name, { gibs: gibs.length, gibsBad: gibs.filter((r) => r.status !== 200).length, lighting: await ev('return viewer.scene.globe.enableLighting'), errors: errors.slice(0, 5) })
}
if (want('app-grow')) {
  log('grow.load', { loadS: (await nav('/?hex=000e01&topo=0'), await settle(APP_READY, 3000)) })
  log('grow.start', await ev('return { f: viewer.scene.verticalExaggeration, relH: viewer.scene.verticalExaggerationRelativeHeight }'))
  await shot('ge-11-grow-0-flat')
  await key('t')
  const t0 = Date.now()
  for (const ms of [800, 1600, 2500]) { await sleep(Math.max(0, ms - (Date.now() - t0))); const f = await ev('return viewer.scene.verticalExaggeration'); await shot(`ge-12-grow-${ms}ms-f${f.toFixed(2)}`) }
}
if (want('app-ksfo')) {
  log('ksfo.load', { loadS: (await nav('/?hex=000a01&airport=KSFO'), await settle(APP_READY, 3000)) })
  await shot('ge-13-ksfo-day')
  log('ksfo', await ev(`const c = viewer.clock.currentTime; return { dayNumber: c.dayNumber, secondsOfDay: Math.round(c.secondsOfDay), iso: new Date((c.dayNumber - 2440587.5) * 864e5 + c.secondsOfDay * 1000 - 37000).toISOString(), lighting: viewer.scene.globe.enableLighting }`))
}
if (want('app-browse-night')) {
  log('browse.load', { loadS: (await nav('/?airport=LOWI&sun=2026-09-22T20:30:00Z'), await settle(APP_READY, 3000)) })
  await shot('ge-14-browse-night')
  log('browse', { lighting: await ev('return viewer.scene.globe.enableLighting'), togglesVisible: await ev(`const e = document.querySelector('.fh-toggles'); return e ? getComputedStyle(e).display !== 'none' : null`), gibs: netSummary(/gibs\.earthdata/).length })
}
if (want('app-phone')) {
  for (const [w, h] of [[375, 812]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true })
    log('phone.load', { loadS: (await nav('/?hex=000a01&airport=KSFO'), await settle(APP_READY, 4000)) })
    await shot(`ge-16-phone-${w}x${h}`)
    log(`phone.${w}x${h}`, await ev(`const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom), getComputedStyle(e).display] }
      return { toggles: r('.fh-toggles'), detail: r('.fh-detail'), hud: r('.fh-hud'), scrollW: document.documentElement.scrollWidth, innerW: innerWidth }`))
  }
  await send('Emulation.clearDeviceMetricsOverride')
}
if (want('app-keys')) {
  log('keys.load', { loadS: (await nav('/?hex=000e01'), await settle(APP_READY, 2000)) })
  await ev(`localStorage.removeItem('fh.scene.v1')`)
  // Typing t and l into the table's search box must not toggle anything.
  const typed = await ev(`
    const inp = document.querySelector('.fh-right input'); if (!inp) return 'no input'
    inp.focus(); for (const k of ['t', 'l']) { inp.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); }
    return { f: viewer.scene.verticalExaggeration, lighting: viewer.scene.globe.enableLighting }`)
  log('keys.inInput', typed)
  await ev('document.activeElement?.blur()')
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', metaKey: true }))`); log('keys.cmdL', await ev('return viewer.scene.globe.enableLighting'))
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l' }))`); await sleep(500)
  log('keys.L', { lighting: await ev('return viewer.scene.globe.enableLighting'), stored: await ev(`return localStorage.getItem('fh.scene.v1')`), pressed: await ev(`return [...document.querySelectorAll('.fh-toggles button')].map((b) => b.getAttribute('aria-pressed'))`) })
  await shot('ge-15-sun-off')
  await nav('/?hex=000e01'); await settle(APP_READY, 1000)
  log('keys.reload', { lighting: await ev('return viewer.scene.globe.enableLighting'), stored: await ev(`return localStorage.getItem('fh.scene.v1')`) })
  await nav('/?hex=000e01&topo=0'); await settle(APP_READY, 1000)
  log('keys.topo0', { f: await ev('return viewer.scene.verticalExaggeration'), stored: await ev(`return localStorage.getItem('fh.scene.v1')`) })
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l' }))`) // restore the sun (stores topo false too: see E4 ponytail)
  await ev(`localStorage.removeItem('fh.scene.v1')`)
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); await sleep(1500)
  log('keys.browse', { lighting: await ev('return viewer.scene.globe.enableLighting'), togglesDisplay: await ev(`const e = document.querySelector('.fh-toggles'); return e ? getComputedStyle(e).display : null`) })
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))`); log('keys.TinBrowse', await ev('return viewer.scene.verticalExaggeration'))
  for (const [w, h] of (process.env.PHONES ? JSON.parse(process.env.PHONES) : [[375, 667], [375, 812]])) {
    await nav('/?hex=000e01'); await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true }); await settle(APP_READY, 2500)
    await shot(`ge-16-phone-${w}x${h}`)
    log(`phone.${w}x${h}`, await ev(`const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom), getComputedStyle(e).display] }
      return { toggles: r('.fh-toggles'), detail: r('.fh-detail'), hud: r('.fh-hud'), scrollW: document.documentElement.scrollWidth, innerW: innerWidth }`))
  }
  await send('Emulation.clearDeviceMetricsOverride')
  log('keys.errors', errors.slice(0, 10))
}
console.log('done')
ws.close(); chrome.kill(); process.exit(0)
