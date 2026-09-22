// Placeholder owned by WP-00 until WP-F2 replaces it: proves the Vite + Cesium setup renders a globe.
import { EllipsoidTerrainProvider, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

const viewer = new Viewer('globe', {
  terrainProvider: new EllipsoidTerrainProvider(),
  baseLayer: false,
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
})
;(window as unknown as { viewer: Viewer }).viewer = viewer
