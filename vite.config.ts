import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// Cesium needs its Workers/Assets/Widgets/ThirdParty served as static files at CESIUM_BASE_URL.
const cesiumSource = 'node_modules/cesium/Build/Cesium'
const cesiumBaseUrl = 'cesiumStatic'

export default defineConfig({
  define: { CESIUM_BASE_URL: JSON.stringify(`/${cesiumBaseUrl}`) },
  plugins: [
    viteStaticCopy({
      targets: ['ThirdParty', 'Workers', 'Assets', 'Widgets'].map((d) => ({ src: `${cesiumSource}/${d}`, dest: cesiumBaseUrl, rename: { stripBase: 4 } })),
    }),
  ],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
})
