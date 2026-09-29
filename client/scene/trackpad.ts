// client/scene/trackpad.ts
// Two fingers on a trackpad: moving, they drag the view; pinching, they zoom. Chrome, Edge and Firefox send both as wheel
// events, a pinch with ctrlKey set. Cesium reads a plain wheel as zoom and drops ctrl + wheel, so attachTrackpad takes
// both before Cesium's handlers see them; a mouse wheel's notches still go on to Cesium's zoom.

/** A mouse wheel's notch on macOS in Chrome and Safari; faster spins give whole multiples (Mapbox GL tells wheels by it). */
const NOTCH_PX = 4.000244140625

type WheelLike = Pick<WheelEvent, 'ctrlKey' | 'deltaMode' | 'deltaX' | 'deltaY'>

/**
 * 'pinch': a trackpad pinch (or Ctrl + wheel). 'wheel': a mouse wheel's notch, in lines or pages (Firefox) or a whole
 * multiple of NOTCH_PX straight up or down. 'scroll': anything else, fingers moving on a trackpad or a Magic Mouse.
 * ponytail: knows notches as macOS reports them; a Windows or Linux wheel's ±100 px notch reads as a scroll (it pans).
 * Upgrade: Mapbox GL's timing test (scroll_zoom.js) for the rest.
 */
export function wheelKind(e: WheelLike): 'pinch' | 'wheel' | 'scroll' {
  if (e.ctrlKey) return 'pinch'
  if (e.deltaMode !== 0 || (e.deltaX === 0 && e.deltaY !== 0 && e.deltaY % NOTCH_PX === 0)) return 'wheel'
  return 'scroll'
}

/** How far a pinch event spread the fingers (new / old distance): Chromium sends deltaY = −100·ln of it. */
export const pinchRatio = (e: WheelLike): number => Math.exp(-e.deltaY / 100)

export interface Trackpad {
  /** The fingers moved: the view's content follows by (dxPx, dyPx) (right, down), the way a page scrolls. */
  drag(dxPx: number, dyPx: number): void
  /** The fingers spread by ratio (new / old distance) around (xPx, yPx), CSS px from the canvas's top-left. */
  pinch(ratio: number, xPx: number, yPx: number): void
}

/**
 * Sends a trackpad's drags and pinches over canvas to `on`, not to Cesium's handlers (camera controller or
 * ScreenSpaceEventHandler), and never lets them scroll or zoom the page. Returns the detach; a no-op without a DOM canvas.
 */
export function attachTrackpad(canvas: HTMLCanvasElement, on: Trackpad): () => void {
  // The canvas's parent, capturing: its listener runs before any on the canvas, and stopPropagation keeps them out.
  const host = (canvas as Partial<HTMLCanvasElement>).parentElement
  if (!host) return () => {}
  const onWheel = (e: WheelEvent): void => {
    if (e.target !== canvas) return
    const kind = wheelKind(e)
    if (kind === 'wheel') return
    e.preventDefault()
    e.stopPropagation()
    if (kind === 'scroll') on.drag(-e.deltaX, -e.deltaY)
    else {
      const r = canvas.getBoundingClientRect()
      on.pinch(pinchRatio(e), e.clientX - r.left, e.clientY - r.top)
    }
  }
  host.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => host.removeEventListener('wheel', onWheel, { capture: true })
}
