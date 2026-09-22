// client/scene/viewer.ts
import { ImageryLayer, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { ClientConfig } from '../types.ts'
import { makeImagery } from './imagery.ts'
import { makeTerrain } from './terrain.ts'

/**
 * The one Cesium Viewer: configured terrain + imagery, no stock widgets except fullscreen and the credits.
 * The app has its own HUD and picking, so infoBox and selectionIndicator are off too.
 * depthTestAgainstTerrain hides aircraft and runway planes behind hills.
 */
export async function createViewer(el: HTMLElement | string, cfg: ClientConfig): Promise<Viewer> {
  const [terrainProvider, imagery] = await Promise.all([makeTerrain(cfg), makeImagery(cfg)])
  const viewer = new Viewer(el, {
    terrainProvider,
    baseLayer: imagery ? new ImageryLayer(imagery) : false,
    timeline: false,
    animation: false,
    geocoder: false,
    baseLayerPicker: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    homeButton: false,
    infoBox: false,
    selectionIndicator: false,
    requestRenderMode: false,
  })
  viewer.scene.globe.depthTestAgainstTerrain = true
  return viewer
}
