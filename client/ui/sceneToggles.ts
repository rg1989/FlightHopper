// client/ui/sceneToggles.ts
// The chase view's scene toggles (design D11): "3-D terrain" and "Sun", two real buttons with aria-pressed. A click asks
// the app for the toggled prefs through onChange and changes nothing itself; update() only re-renders. The app owns the
// keys (T, L), the stored prefs and where the group sits (layout.css shows it in chase only).
import type { ScenePrefs } from '../types.ts'
import './sceneToggles.css'

export interface SceneTogglesOpts {
  prefs: ScenePrefs
  onChange(next: ScenePrefs): void
}

export interface SceneTogglesHandle {
  el: HTMLElement // the group: the imagery badge sits at its end
  update(prefs: ScenePrefs): void
  destroy(): void
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'fh-toggle'
  b.textContent = label
  b.title = title
  b.addEventListener('click', onClick)
  return b
}

export function mountSceneToggles(root: HTMLElement, opts: SceneTogglesOpts): SceneTogglesHandle {
  // What the buttons show, as two booleans: update() may run every frame and allocates nothing.
  let topo = opts.prefs.topo
  let light = opts.prefs.light
  const el = document.createElement('div')
  el.className = 'fh-toggles'
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', 'Terrain and sun')
  const topoBtn = button('3-D terrain', 'Topography — T', () => opts.onChange({ topo: !topo, light }))
  const lightBtn = button('Sun', 'Sun lighting — L', () => opts.onChange({ topo, light: !light }))
  topoBtn.setAttribute('aria-pressed', String(topo))
  lightBtn.setAttribute('aria-pressed', String(light))
  el.append(topoBtn, lightBtn)
  root.append(el)

  return {
    el,
    update(prefs) {
      if (prefs.topo !== topo) topoBtn.setAttribute('aria-pressed', String((topo = prefs.topo)))
      if (prefs.light !== light) lightBtn.setAttribute('aria-pressed', String((light = prefs.light)))
    },
    destroy() {
      el.remove()
    },
  }
}
