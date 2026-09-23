// Builds sheet-lookback.html and sheet-refine.html from results-fix.json captures (frames are 1280x800 PNGs).
import { readFileSync, writeFileSync } from 'node:fs'
const HERE = new URL('.', import.meta.url).pathname
const r = JSON.parse(readFileSync(HERE + 'results-fix.json', 'utf8'))
const TW = 352, TH = 220
function page(title, rows, note) {
  const n = Math.max(...rows.map((x) => x.frames.length))
  const w = 150 + n * (TW + 6) + 10
  const h = 70 + rows.length * (TH + 44) + 40
  const cells = rows.map((row) => `<div class="row"><div class="lab">${row.label}</div>${row.frames.map((f) =>
    `<figure><img src="file://${row.dir}/${f.file}" width="${TW}" height="${TH}"><figcaption>${f.cap}</figcaption></figure>`).join('')}</div>`).join('')
  return { w, h, html: `<!doctype html><html><head><style>
    body{margin:0;padding:10px;background:#111;color:#eee;font:14px ui-monospace,Menlo,monospace}
    h1{font-size:18px;margin:0 0 4px} p{margin:0 0 10px;color:#bbb} .row{display:flex;align-items:flex-start;margin-bottom:8px}
    .lab{width:144px;flex:none;font-size:16px;font-weight:bold;padding-top:90px;white-space:pre-line} figure{margin:0 6px 0 0}
    img{display:block} figcaption{font-size:13px;color:#ddd;padding-top:2px}
  </style></head><body><h1>${title}</h1><p>${note}</p>${cells}</body></html>` }
}
const lb = (cfg) => {
  const v = r[`s1-${cfg}-agl300`]
  return { label: cfg === 'OLD' ? 'OLD\ncache 100\nno fade' : 'NEW\nauto cache\n+ fade', dir: `${HERE}shots/fix-lookback-${cfg}-agl300`,
    frames: v.captureBack.map((f) => ({ file: f.file, cap: `t ${(f.tMs / 1000).toFixed(2)} s  waiting ${f.waiting}  loads ${f.loads}` })) }
}
const a = page('Look-back: the first 1.5 s after snapping the chase camera back 180° (agl 300 m, Patscherkofel, frames every 150 ms)',
  [lb('OLD'), lb('NEW')], 'The away view was loaded and idle first. "waiting" = tiles drawn coarse while their children load; "loads" = tiles loaded since the snap (all reloads in OLD). Warm HTTP cache in both.')
writeFileSync(HERE + 'sheet-lookback.html', a.html)
const rf = (fade) => {
  const v = r[`sse-fade${fade}fix`]
  return { label: fade ? 'fade=1' : 'fade=0', dir: v.dir,
    frames: v.frames.filter((f) => f.tMs <= 1050).map((f) => ({ file: f.file, cap: `t ${(f.tMs / 1000).toFixed(1)} s  pops ${f.pops}  fading ${f.fading}` })) }
}
const b = page('Refinement, still camera: loaded at SSE 8, then SSE 2 at t = 0 (agl 300 m, frames every 100 ms, auto cache)',
  [rf(0), rf(1)], '"pops" = drawn tiles whose imagery level rose (cumulative); "fading" = cross-fades in progress (600 ms smoothstep). Cold HTTP cache in both.')
writeFileSync(HERE + 'sheet-refine.html', b.html)
console.log(`lookback ${a.w}x${a.h} refine ${b.w}x${b.h}`)
