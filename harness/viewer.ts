// harness/viewer.ts
// WP-V1 harness: /harness/viewer.html?terrain=reearth&imagery=eox builds the viewer from readConfig and flies to KSFO.
// Query params override VITE_TERRAIN / VITE_IMAGERY. The token only ever comes from .env.local, never from the URL.
import { Cartesian3, Math as CesiumMath, type Viewer } from 'cesium'
import { readConfig } from '../client/config.ts'
import { createViewer } from '../client/scene/viewer.ts'

const status = document.getElementById('status')!
const q = new URLSearchParams(location.search)

try {
  const cfg = readConfig({
    VITE_TERRAIN: q.get('terrain') ?? import.meta.env.VITE_TERRAIN,
    VITE_IMAGERY: q.get('imagery') ?? import.meta.env.VITE_IMAGERY,
    VITE_CESIUM_ION_TOKEN: import.meta.env.VITE_CESIUM_ION_TOKEN,
    VITE_API_BASE: import.meta.env.VITE_API_BASE,
  })
  const viewer = await createViewer('globe', cfg)
  ;(window as unknown as { harness: { viewer: Viewer } }).harness = { viewer }
  // East of KSFO over the bay, looking up runways 28L/28R (true heading 298°).
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(-122.335, 37.598, 600),
    orientation: { heading: CesiumMath.toRadians(298), pitch: CesiumMath.toRadians(-12), roll: 0 },
    duration: 0,
  })
  const shown = { terrain: cfg.terrain, imagery: cfg.imagery, ionToken: cfg.ionToken ? 'set' : null, apiBase: cfg.apiBase }
  viewer.scene.postRender.addEventListener(() => {
    status.textContent = `${JSON.stringify(shown)}\ntilesLoaded: ${viewer.scene.globe.tilesLoaded}`
  })
} catch (err) {
  status.textContent = `error: ${(err as Error).message}`
  status.style.color = '#ff8080'
}
