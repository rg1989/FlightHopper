// client/scene/viewer.ts
import { ImageryLayer, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { ClientConfig } from '../types.ts'
import { fadeOffOnDestroy, imageryFade, installImageryFade } from './imageryFade.ts'
import { makeImagery } from './imagery.ts'
import { makeTerrain } from './terrain.ts'
import { TileCache } from './tileCache.ts'

/**
 * Scene options (the app passes none: the defaults). tileCache: globe.tileCacheSize, 'auto' (default: tileCache.ts sizes it
 * from the tiles a frame touches, so orbiting back finds the ground still loaded) or a fixed number of tiles (100 is
 * Cesium's default). fade: the base imagery cross-fades to each sharper tile (imageryFade.ts), default on.
 */
export interface ViewerOpts {
  tileCache?: 'auto' | number
  fade?: boolean
}

/**
 * The one Cesium Viewer: configured terrain + imagery, no stock widgets. Credits go to a detached element, so no credit
 * bar or "Powered by" logo shows (a personal-use app); the app has its own fullscreen button, flight card and picking.
 * depthTestAgainstTerrain hides aircraft and runway planes behind hills. Sharper imagery dissolves in over imageryFade's
 * FADE_MS instead of popping (opts.fade). The adaptive TileCache listens to scene.postRender, so it dies with the viewer.
 */
export async function createViewer(el: HTMLElement | string, cfg: ClientConfig, opts: ViewerOpts = {}): Promise<Viewer> {
  const [terrainProvider, imagery] = await Promise.all([makeTerrain(cfg), makeImagery(cfg)])
  installImageryFade() // false on a Cesium without the privates it needs: no fade, the globe pops as before
  imageryFade.enabled = opts.fade ?? true
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
  fadeOffOnDestroy(viewer) // Viewer.destroy frees no globe tiles, so the running fades are ended first
  // Never both: a TileCache would overwrite a fixed size on its next change.
  if (typeof opts.tileCache === 'number') viewer.scene.globe.tileCacheSize = opts.tileCache
  else new TileCache(viewer)
  return viewer
}
