// Prints a compact summary of a results-<run>.json: node summarize.mjs <runName>
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const r = JSON.parse(readFileSync(join(HERE, `results-${process.argv[2]}.json`), 'utf8'))
const sum = (t, k) => t.reduce((a, s) => a + s[k], 0)
for (const [k, v] of Object.entries(r)) {
  if (k.startsWith('s1-')) {
    const row = (name, l) => `${name.padEnd(10)} loads ${String(l.tilesLoaded).padStart(4)} reloads ${String(l.tileReloads).padStart(4)} freed ${String(l.tilesFreed).padStart(4)} img ${String(l.imageryRequests).padStart(4)} reImg ${String(l.imageryRerequests).padStart(4)} peakQ ${String(l.peakReplacementQueue).padStart(4)} idle ${l.idleAfterOrbit ? `${l.idleAfterOrbit.ms}ms` : `${l.loadS}s`} fps ${l.fps.p50}/${l.fps.p5} cpu ${l.cpuMs.p50} heap ${l.usedJSHeapMB} load ${l.load[0]} net ${Object.entries(l.net).filter(([h]) => !h.startsWith('localhost')).map(([h, n]) => `${h.split('.')[0]}:${n.requests}/${n.fromCache}c`).join(' ')}`
    console.log(k)
    for (const [name, l] of Object.entries(v)) if (name !== 'errors') console.log('  ' + row(name, l))
    if (v.errors?.length) console.log('  errors', v.errors.slice(0, 3))
  } else if (k === 's2-fly') {
    const t = v.timeline
    console.log(k, JSON.stringify({ fps: v.stats.fps, cpu: v.stats.cpuMs, loads: v.stats.tilesLoaded, freed: v.stats.tilesFreed, reloads: v.stats.tileReloads, pops: sum(t, 'imageryPops'), popLevels: sum(t, 'imageryPopLevels'), refines: sum(t, 'refines'),
      blurMax: Math.max(...t.map((s) => s.blurTilesMax)), blurAvg: +(sum(t, 'blurTilesAvg') / t.length).toFixed(1), gapMax: Math.max(...t.map((s) => s.maxGap)), waitingMaxAvg: Math.max(...t.map((s) => s.waitingAvg)),
      secondsWithBlur: t.filter((s) => s.blurTilesMax > 0).length, heap: v.stats.usedJSHeapMB, load: v.load, aircraft: v.aircraft, errors: v.errors.length }))
  } else if (k === 's2-shots') {
    console.log(k, v.frames.map((f) => `${f.tMs}:${f.blurTiles}/${f.waiting}`).join(' '))
  }
}
