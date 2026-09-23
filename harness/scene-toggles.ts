// harness/scene-toggles.ts
// WP-E4 harness: /harness/scene-toggles.html mounts the scene toggles where the app's right-hand column starts, over
// imagery-like backgrounds, and plays the app's part: onChange stores the prefs and answers with update(). T and L do
// the same as a click (a stand-in: the app's key handler and its filter are E-A's). The panel shows the URL, the stored
// value and what readScenePrefs makes of them, so a reload, ?topo=0 over a stored value and a blocked storage can be
// checked. "forget stored" removes this page's own fh.scene.v1 entry, to start again from the defaults.
import type { ScenePrefs } from '../client/types.ts'
import { PREFS_KEY, readScenePrefs, writeScenePrefs } from '../client/ui/scenePrefs.ts'
import { mountSceneToggles } from '../client/ui/sceneToggles.ts'

// Both the localStorage getter and its reads can throw when storage is blocked; the app guards them the same way.
let storage: Storage | null = null
try {
  storage = window.localStorage
} catch {
  storage = null
}
const stored = (): string | null => {
  try {
    return storage?.getItem(PREFS_KEY) ?? null
  } catch {
    return null
  }
}

const dock = document.getElementById('dock')!
const stats = document.getElementById('stats')!
const controls = document.getElementById('controls')!
const atLoad = stored()
let prefs: ScenePrefs = readScenePrefs(location.search, atLoad)
const log: string[] = []

const toggles = mountSceneToggles(dock, { prefs, onChange: (next) => apply(next, 'click') })

function apply(next: ScenePrefs, via: string): void {
  prefs = next
  writeScenePrefs(prefs, storage)
  toggles.update(prefs)
  log.unshift(`${new Date().toISOString().slice(11, 23)} ${via} → onChange ${JSON.stringify(next)}`)
  log.length = Math.min(log.length, 8)
  console.log('[scene-toggles]', via, next)
  report()
}

function report(): void {
  const shown = [...dock.querySelectorAll('button')].map((b) => `${b.textContent} ${b.getAttribute('aria-pressed')}`).join(', ')
  stats.textContent = [
    `URL: ${location.search || '(no query)'}`,
    `stored at load: ${atLoad ?? '(nothing)'}`,
    `readScenePrefs: ${JSON.stringify(readScenePrefs(location.search, atLoad))}`,
    `stored now: ${stored() ?? '(nothing)'}${storage === null ? ' (localStorage blocked)' : ''}`,
    `aria-pressed: ${shown}`,
    ...log,
  ].join('\n')
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
  const k = e.key.toLowerCase()
  if (k === 't') apply({ ...prefs, topo: !prefs.topo }, 'key T')
  else if (k === 'l') apply({ ...prefs, light: !prefs.light }, 'key L')
})

function button(label: string, onClick: () => void): void {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.addEventListener('click', onClick)
  controls.append(b)
}
for (const bg of ['satellite', 'snow', 'night']) button(`bg: ${bg}`, () => (document.body.dataset.bg = bg))
button('forget stored', () => {
  try {
    storage?.removeItem(PREFS_KEY)
  } catch {
    // blocked: nothing was stored
  }
  report()
})

report()
;(window as unknown as { harness: object }).harness = { toggles, apply, readScenePrefs, PREFS_KEY }
