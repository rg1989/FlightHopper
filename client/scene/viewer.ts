// client/scene/viewer.ts
import { ImageryLayer, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { ClientConfig } from '../types.ts'
import { makeImagery } from './imagery.ts'
import { makeTerrain } from './terrain.ts'

/**
 * The one Cesium Viewer: configured terrain + imagery, no stock widgets. Credits go to a detached element, so no credit
 * bar or "Powered by" logo shows (a personal-use app); the app has its own fullscreen button, flight card and picking.
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
    fullscreenButton: false,
    creditContainer: document.createElement('div'), // never attached
    requestRenderMode: false,
  })
  viewer.scene.globe.depthTestAgainstTerrain = true
  return viewer
}
