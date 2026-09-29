// client/livery/raster.ts
// Draws a design's ops (kit.ts) into the atlases the paint shader samples (livery-pipeline-design.md §4): per region a
// canvas whose top half is the left side and bottom half the right side, both with the nose at the left, the region's
// side box mapped onto each half inside a margin. Shapes land identically on both halves; text and images are flipped
// on the right half so they read correctly from the right (unless mirror). Browser only (canvas, fonts, images).
import { drawDesign, imagesOf } from './kit.ts'
import type { Design, Fill, Op, RegionOps, Seg, Target } from './kit.ts'

export interface Atlas {
  data: Uint8Array // RGBA rows, top row first (the shader's t = 0)
  width: number
  height: number
}

export interface Atlases {
  skin: Atlas
  nacelle: Atlas | null
  tip: Atlas | null
}

/** Atlas sizes [width, height] per region at full detail: the skin's ~45 px/m on a narrowbody, ~30 px/m on a 787. */
export const SIZES = { skin: [2048, 1024], nacelle: [512, 512], tip: [256, 512] } as const

/** The sizes at a detail: 1 for the chased aircraft, 0.5 for traffic (a quarter of the memory). */
export function sizesAt(detail: number): { skin: [number, number]; nacelle: [number, number]; tip: [number, number] } {
  const k = (s: readonly [number, number]): [number, number] => [s[0] * detail, s[1] * detail]
  return { skin: k(SIZES.skin), nacelle: k(SIZES.nacelle), tip: k(SIZES.tip) }
}
/** Rows left above and below each half's box, so mipmaps do not bleed one side into the other. */
export const MARGIN = 8

const images = new Map<string, Promise<HTMLImageElement | null>>()

function loadImage(src: string): Promise<HTMLImageElement | null> {
  let p = images.get(src)
  if (p === undefined) {
    const img = new Image()
    img.decoding = 'async'
    img.src = src
    p = img.decode().then(
      () => img,
      () => {
        console.warn(`FlightHopper: livery image ${src} did not load; drawn without it`)
        return null
      },
    )
    images.set(src, p)
  }
  return p
}

const fonts = new Map<string, Promise<void>>()

function loadFonts(d: Design): Promise<unknown> {
  return Promise.all((d.fonts ?? []).map((f) => {
    const key = `${f.family}|${f.src}|${f.weight ?? ''}|${f.style ?? ''}`
    let p = fonts.get(key)
    if (p === undefined) {
      const face = new FontFace(f.family, `url(${f.src})`, { weight: f.weight ?? 'normal', style: f.style ?? 'normal' })
      p = face.load().then(
        (ff) => void document.fonts.add(ff),
        () => console.warn(`FlightHopper: livery font ${f.src} did not load`),
      )
      fonts.set(key, p)
    }
    return p
  }))
}

/** Draws design d on model m: the three atlases (null where the model has no nacelles or wingtip devices). */
export async function rasterize(d: Design, m: Target, detail = 1): Promise<Atlases> {
  const size = sizesAt(detail)
  const ops = drawDesign(d, m)
  const srcs = imagesOf(ops)
  const [loaded] = await Promise.all([Promise.all(srcs.map(loadImage)), loadFonts(d)])
  const img = new Map(srcs.map((s, i) => [s, loaded[i]]))
  return {
    skin: region(ops.skin, size.skin, img),
    nacelle: ops.nacelle && region(ops.nacelle, size.nacelle, img),
    tip: ops.tip && region(ops.tip, size.tip, img),
  }
}

/** A region's canvas, for the lab (tools/livery-lab) to show; region() reads it back. */
export function regionCanvas(r: RegionOps, [w, h]: readonly [number, number], img: Map<string, HTMLImageElement | null>): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  half(ctx, r.box, r.left, 0, w, h / 2, false, img)
  half(ctx, r.box, r.right, h / 2, w, h / 2, true, img)
  return c
}

function region(r: RegionOps, size: readonly [number, number], img: Map<string, HTMLImageElement | null>): Atlas {
  const c = regionCanvas(r, size, img)
  const px = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height)
  return { data: new Uint8Array(px.data.buffer), width: c.width, height: c.height }
}

const REF_PX = 200 // text is measured at this font size, then scaled to its cap height

/** A path in metres (drawn under the half's metric transform). */
function pathOf(d: Seg[]): Path2D {
  const p = new Path2D()
  for (const s of d) {
    if (s[0] === 'M') p.moveTo(s[1], s[2])
    else if (s[0] === 'L') p.lineTo(s[1], s[2])
    else if (s[0] === 'Q') p.quadraticCurveTo(s[1], s[2], s[3], s[4])
    else if (s[0] === 'C') p.bezierCurveTo(s[1], s[2], s[3], s[4], s[5], s[6])
    else p.closePath()
  }
  return p
}

/** A colour or a gradient in metres (made under the metric transform, so it is laid out in metres too). */
function paintOf(ctx: CanvasRenderingContext2D, f: Fill): string | CanvasGradient {
  if (typeof f === 'string') return f
  const g = 'linear' in f ? ctx.createLinearGradient(...f.linear) : ctx.createRadialGradient(f.radial[0], f.radial[1], 0, f.radial[0], f.radial[1], f.radial[2])
  for (const [at, c] of f.stops) g.addColorStop(at, c)
  return g
}

/**
 * One side into rows [top, top + h): z → x with the nose at the left, y → rows (up at the top). Shapes are drawn in
 * metres under a metric transform (so stroke widths and gradients are in metres too); text and images get their own.
 */
function half(ctx: CanvasRenderingContext2D, box: RegionOps['box'], ops: Op[], top: number, w: number, h: number, right: boolean, img: Map<string, HTMLImageElement | null>): void {
  const [zMin, zMax, yMin, yMax] = box
  const sx = w / (zMax - zMin)
  const sy = (h - 2 * MARGIN) / (yMax - yMin)
  const X = (z: number): number => (zMax - z) * sx
  const Y = (y: number): number => top + MARGIN + (yMax - y) * sy
  const metric = (): void => ctx.setTransform(-sx, 0, 0, -sy, zMax * sx, top + MARGIN + yMax * sy)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, top, w, h)
  ctx.clip()
  for (const op of ops) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    if (op.k === 'fill') {
      metric()
      ctx.fillStyle = paintOf(ctx, op.color)
      ctx.fillRect(zMin - 1000, yMin - 1000, zMax - zMin + 2000, yMax - yMin + 2000)
    } else if (op.k === 'path') {
      metric()
      ctx.fillStyle = paintOf(ctx, op.color)
      ctx.fill(pathOf(op.d))
    } else if (op.k === 'stroke') {
      metric()
      ctx.strokeStyle = paintOf(ctx, op.color)
      ctx.lineWidth = op.widthM
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke(pathOf(op.d))
    } else if (op.k === 'clip') {
      ctx.save()
      metric()
      ctx.clip(pathOf(op.d))
    } else if (op.k === 'unclip') {
      ctx.restore()
    } else if (op.k === 'text') {
      ctx.font = `${op.italic ? 'italic ' : ''}${op.weight} ${REF_PX}px ${op.font}`
      ctx.letterSpacing = `${op.tracking * REF_PX}px`
      const cap = ctx.measureText('H').actualBoundingBoxAscent || REF_PX * 0.72
      const k = op.capM / cap // metres per font pixel
      const len = ctx.measureText(op.text).width * k
      const fore = op.align === 'fore' ? op.z : op.align === 'centre' ? op.z + len / 2 : op.z + len
      const flip = right && !op.mirror ? -1 : 1
      // the reading start: the fore end seen from the left, the aft end seen from the right (flipped in the atlas)
      ctx.setTransform(flip * sx * k, 0, 0, sy * k, X(flip === 1 ? fore : fore - len), Y(op.y))
      ctx.fillStyle = op.color
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(op.text, 0, 0)
    } else if (op.k === 'image') {
      const im = img.get(op.src)
      if (!im) continue
      const aspect = im.naturalWidth > 0 && im.naturalHeight > 0 ? im.naturalWidth / im.naturalHeight : 4
      const bw = op.w ?? (op.h ?? 1) * aspect
      const bh = op.h ?? bw / aspect
      const flip = right && !op.mirror ? -1 : 1
      ctx.globalAlpha = op.opacity ?? 1
      ctx.setTransform(flip * sx, 0, 0, sy, X(flip === 1 ? op.z + bw / 2 : op.z - bw / 2), Y(op.y + bh / 2))
      ctx.drawImage(im, 0, 0, bw, bh)
    } else if (op.k === 'wrap') {
      const im = img.get(op.src)
      if (!im) continue
      const [zNose, zTail, yBottom, yTop] = op.box
      const ih = im.naturalHeight / 2
      ctx.drawImage(im, 0, right ? ih : 0, im.naturalWidth, ih, X(zNose), Y(yTop), X(zTail) - X(zNose), Y(yBottom) - Y(yTop))
    }
  }
  ctx.restore()
}
