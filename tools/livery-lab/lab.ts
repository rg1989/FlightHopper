// tools/livery-lab/lab.ts
// The livery lab (livery-pipeline-design.md §8): one model in one livery, drawn by the app's own ChaseModel and paint
// shader, from the views reference photos are taken from, next to those photos, with the atlases the design drew.
// Dev only: `npx vite` in the repo, then /tools/livery-lab/?model=a21n&livery=WZZ
//   model   manifest id (default a320)          livery  livery code, or CODE~scheme for one of a design's schemes
//   views   comma list of VIEWS keys (default: every one; `refs` = only those the reference photos show)
//   gear    0 to draw it retracted              refs    0 to leave out the reference photos
//   w, h    tile size in px (default 800 × 450)
// When done it sets window.__lab = { done, tiles: [{ view, dataUrl }], errors } for tools/livery-shots.ts.
import { Cartesian3, Color, DirectionalLight, HeadingPitchRange, Math as CesiumMath, Matrix4, PerspectiveFrustum, Transforms, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { drawDesign, profileOf } from '../../client/livery/kit.ts'
import { regionCanvas, SIZES } from '../../client/livery/raster.ts'
import { ChaseModel, GLTF_TO_CESIUM } from '../../client/scene/model.ts'
import { liveryOf, LiveryShaders } from '../../client/scene/livery.ts'
import type { ModelManifest, ModelManifestEntry, ModelProfile, RenderState } from '../../client/types.ts'

interface View {
  label: string
  hdg: number // camera heading, degrees from north (the aircraft points north)
  pitch: number // degrees, negative looks down
  range: number // × the model's length (whole-aircraft views) or metres from the target (close-ups)
  target?: (p: ModelProfile) => [x: number, y: number, z: number] // paint-frame point to look at (default: the centre)
  close?: boolean
}

const mid = (p: ModelProfile): [number, number, number] => [0, (p.box[2] + p.box[3]) / 2 - 1, (p.box[0] + p.box[1]) / 2]
export const VIEWS: Record<string, View> = {
  left: { label: 'left side', hdg: 90, pitch: -2, range: 1 },
  right: { label: 'right side', hdg: 270, pitch: -2, range: 1 },
  'front-left': { label: '3/4 front left', hdg: 130, pitch: -7, range: 0.95 },
  'front-right': { label: '3/4 front right', hdg: 230, pitch: -7, range: 0.95 },
  'rear-left': { label: '3/4 rear left', hdg: 50, pitch: -7, range: 0.95 },
  'rear-right': { label: '3/4 rear right', hdg: 310, pitch: -7, range: 0.95 },
  below: { label: 'from below', hdg: 110, pitch: 38, range: 1 },
  top: { label: 'from above', hdg: 90, pitch: -60, range: 1 },
  tail: { label: 'tail, left', hdg: 80, pitch: -4, range: 0.42, target: (p) => [0, (p.finRoot[0] + p.finTip[0]) / 2, (p.finRoot[1] + p.finTip[2]) / 2] },
  nose: { label: 'forward fuselage, left', hdg: 100, pitch: -3, range: 0.45, target: (p) => [0, (p.box[2] + p.box[3]) / 2 - 1, p.cockpit - 4] },
  engine: { label: 'left engine', hdg: 125, pitch: -3, close: true, range: 11, target: (p) => (p.engines ? [(p.engines[0] + p.engines[1]) / 2, (p.engines[4] + p.engines[5]) / 2, (p.engines[2] + p.engines[3]) / 2] : mid(p)) },
  winglet: { label: 'left wingtip', hdg: 60, pitch: -2, close: true, range: 9, target: (p) => (p.winglet ? [(p.winglet[0] + p.winglet[1]) / 2, (p.winglet[4] + p.winglet[5]) / 2, (p.winglet[2] + p.winglet[3]) / 2] : [p.wing[3], p.wing[4], p.wing[1]]) },
}

/** A reference photo's free-text view (refs.json) as a VIEWS key, or null. */
export function viewOf(text: string): string | null {
  const t = text.toLowerCase()
  const lr = /right/.test(t) ? 'right' : /left/.test(t) ? 'left' : null
  if (/tail|fin/.test(t)) return 'tail'
  if (/engine|nacelle/.test(t)) return 'engine'
  if (/winglet|sharklet|wingtip|wing tip/.test(t)) return 'winglet'
  if (/below|belly|under/.test(t)) return 'below'
  if (/top|above/.test(t)) return 'top'
  if (/nose|forward fuselage|title/.test(t)) return 'nose'
  if (/rear|behind|aft/.test(t)) return lr ? `rear-${lr}` : 'rear-left'
  if (/front|3\/4|quarter/.test(t)) return lr ? `front-${lr}` : 'front-left'
  if (/side|profile/.test(t)) return lr ?? 'left'
  return lr
}

interface Ref { file: string; view: string; registration?: string; source?: string; author?: string; licence?: string }

const q = new URLSearchParams(location.search)
const status = document.getElementById('status')!
const sheet = document.getElementById('sheet')!
const say = (s: string): void => void (status.textContent = s)
// a frame, or 40 ms where a hidden page gets no animation frames (the Browser pane when it is not shown)
const frame = (): Promise<void> => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 40) })
const lab: { done: boolean; tiles: Array<{ view: string; dataUrl: string }>; errors: string[] } = { done: false, tiles: [], errors: [] }
;(window as unknown as { __lab: typeof lab }).__lab = lab
addEventListener('error', (e) => lab.errors.push(String(e.message)))

function figure(parent: HTMLElement, el: HTMLElement, caption: string): HTMLElement {
  const f = document.createElement('figure')
  const c = document.createElement('figcaption')
  c.textContent = caption
  f.append(el, c)
  parent.append(f)
  return f
}

async function main(): Promise<void> {
  const man: ModelManifest = await (await fetch('/models/manifest.json')).json()
  const m: ModelManifestEntry | undefined = man.models.find((e) => e.id === (q.get('model') ?? 'a320'))
  if (!m?.paint) throw new Error(`no painted model "${q.get('model')}"`)
  const code = q.get('livery')
  const livery = liveryOf(code)
  const profile = profileOf(m)!
  document.getElementById('title')!.textContent = `${livery.design.name} on ${m.id}`
  document.title = `Livery lab: ${code ?? 'white'} on ${m.id}`
  const [W, H] = [Number(q.get('w') ?? 800), Number(q.get('h') ?? 450)]

  // reference photos (data/livery-refs/<CODE>/refs.json, git-ignored)
  let refs: Ref[] = []
  if (code && q.get('refs') !== '0') {
    try {
      const r = await fetch(`/data/livery-refs/${code}/refs.json`)
      if (r.ok) refs = await r.json()
    } catch { /* none */ }
  }
  const wanted = q.get('views') === 'refs' ? [...new Set(refs.map((r) => viewOf(r.view)).filter((v): v is string => v !== null))]
    : (q.get('views')?.split(',') ?? Object.keys(VIEWS)).filter((v) => v in VIEWS)

  // one viewer, no globe, a pale sky; rendered by hand, one view at a time
  const stage = document.getElementById('stage')!
  stage.style.width = `${W}px`
  stage.style.height = `${H}px`
  const viewer = new Viewer(stage, {
    globe: false, baseLayer: false, timeline: false, animation: false, geocoder: false, baseLayerPicker: false, sceneModePicker: false,
    navigationHelpButton: false, homeButton: false, infoBox: false, selectionIndicator: false, fullscreenButton: false,
    creditContainer: document.createElement('div'), useDefaultRenderLoop: false, contextOptions: { webgl: { preserveDrawingBuffer: true } },
  })
  const scene = viewer.scene
  if (scene.skyBox) scene.skyBox.show = false
  scene.backgroundColor = Color.fromCssColorString(q.get('bg') ?? '#a9c8e8')
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
  if (scene.sun) scene.sun.show = false
  if (scene.moon) scene.moon.show = false
  const light = new DirectionalLight({ direction: new Cartesian3(0, 0, -1), intensity: 2.2 })
  scene.light = light
  const cam = viewer.camera
  ;(cam.frustum as PerspectiveFrustum).fov = CesiumMath.toRadians(28)

  const state: RenderState = {
    hex: 'lab', lat: 0, lon: 0, hM: 1000, headingDeg: 0, pitchDeg: 0, rollDeg: 0, gsKt: 0, trackDeg: 0, altBaroFt: null, vsFpm: 0, mode: 'interp',
    altSource: 'geom', onGround: false, ageS: 0, quality: 'adsb2', callsign: null, typeCode: null,
  } satisfies RenderState
  const cm = await ChaseModel.load(viewer, m)
  if (livery.code !== null) cm.paint(livery.code)
  else cm.paint(null)
  cm.snapGear(q.get('gear') !== '0')
  cm.update(state)
  say('loading the model and drawing the livery…')
  for (let i = 0; i < 600 && !cm.model.ready; i++) {
    scene.render()
    await frame()
  }
  await LiveryShaders.idle()
  for (let i = 0; i < 90; i++) { // the atlases' textures and the gear load over the next frames
    cm.update(state)
    scene.render()
    await frame()
  }

  const world = (pt: [number, number, number]): Cartesian3 => {
    const mesh = m.paint!.noseMinusZ ? new Cartesian3(-pt[0], pt[1], -pt[2]) : new Cartesian3(pt[0], pt[1], pt[2])
    const inModel = Matrix4.multiplyByPoint(GLTF_TO_CESIUM, mesh, new Cartesian3())
    return Matrix4.multiplyByPoint(cm.model.modelMatrix, inModel, new Cartesian3())
  }
  const L = profile.box[1] - profile.box[0]
  const shoot = async (key: string): Promise<string> => {
    const v = VIEWS[key]
    const target = world((v.target ?? mid)(profile))
    const range = v.close ? v.range : v.range * L * 2.1
    cam.lookAt(target, new HeadingPitchRange(CesiumMath.toRadians(v.hdg), CesiumMath.toRadians(v.pitch), range))
    // the sun behind the photographer and 40° up, as in most spotter photos
    const up = Cartesian3.normalize(target, new Cartesian3())
    const dir = Cartesian3.normalize(Cartesian3.subtract(Cartesian3.multiplyByScalar(cam.directionWC, Math.cos(0.7), new Cartesian3()), Cartesian3.multiplyByScalar(up, Math.sin(0.7), new Cartesian3()), new Cartesian3()), new Cartesian3())
    light.direction = dir
    for (let i = 0; i < 3; i++) {
      scene.render()
      await frame()
    }
    cam.lookAtTransform(Matrix4.IDENTITY)
    return scene.canvas.toDataURL('image/png')
  }

  // the sheet: every reference photo beside the same view of the model, then the other views, then the atlases
  const shots = new Map<string, string>()
  for (const key of wanted) {
    say(`rendering ${key}…`)
    const url = await shoot(key)
    shots.set(key, url)
    lab.tiles.push({ view: key, dataUrl: url })
  }
  if (refs.length) {
    const h2 = document.createElement('h2')
    h2.textContent = `Reference photos (data/livery-refs/${code}) beside the model`
    sheet.append(h2)
    const row = document.createElement('div')
    row.className = 'row'
    sheet.append(row)
    for (const r of refs) {
      const key = viewOf(r.view)
      const pair = document.createElement('div')
      pair.className = 'pair'
      const img = document.createElement('img')
      img.src = `/data/livery-refs/${code}/${r.file}`
      pair.append(img)
      if (key && shots.has(key)) {
        const mine = document.createElement('img')
        mine.src = shots.get(key)!
        pair.append(mine)
      }
      figure(row, pair, `${r.view}${r.registration ? ` · ${r.registration}` : ''}${r.author ? ` · © ${r.author}` : ''} → ${key ?? '(no matching view)'}`)
    }
  }
  const h2 = document.createElement('h2')
  h2.textContent = 'Views'
  sheet.append(h2)
  const row = document.createElement('div')
  row.className = 'row'
  sheet.append(row)
  for (const [key, url] of shots) {
    const img = document.createElement('img')
    img.src = url
    figure(row, img, VIEWS[key].label)
  }

  // the atlases, as drawn (images are cached by the raster module)
  const ops = drawDesign(livery.design, { id: m.id, profile, paint: m.paint }, livery.variant ?? null)
  const imgs = new Map<string, HTMLImageElement | null>()
  for (const r of [ops.skin, ops.nacelle, ops.tip, ops.belly]) {
    for (const op of r ? [...r.left, ...r.right] : []) {
      if ((op.k === 'image' || op.k === 'wrap') && !imgs.has(op.src)) {
        const im = new Image()
        im.src = op.src
        imgs.set(op.src, await im.decode().then(() => im, () => null))
      }
    }
  }
  const h3 = document.createElement('h2')
  h3.textContent = 'Atlases (top half: left side; bottom half: right side; nose at the left)'
  sheet.append(h3)
  const arow = document.createElement('div')
  arow.className = 'row'
  sheet.append(arow)
  figure(arow, regionCanvas(ops.skin, SIZES.skin, imgs), `skin ${SIZES.skin.join('×')} over box ${profile.box.join(', ')}`).classList.add('atlas')
  if (ops.nacelle) figure(arow, regionCanvas(ops.nacelle, SIZES.nacelle, imgs), 'nacelle').classList.add('atlas')
  if (ops.tip) figure(arow, regionCanvas(ops.tip, SIZES.tip, imgs), 'wingtip device').classList.add('atlas')
  if (ops.belly) figure(arow, regionCanvas(ops.belly, SIZES.belly, imgs, true), 'belly, from below (nose left, left wing up)').classList.add('atlas')
  say(`done: ${wanted.length} views${refs.length ? `, ${refs.length} reference photos` : ''}`)
  lab.done = true
}

main().catch((err: unknown) => {
  lab.errors.push(String(err))
  say(`failed: ${String(err)}`)
  lab.done = true
})
