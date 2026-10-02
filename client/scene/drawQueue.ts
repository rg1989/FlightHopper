// client/scene/drawQueue.ts
// Main-thread drawing jobs, in order, at most ~6 ms of them a frame (and always one, however slow): a burst, such as a
// palette change redrawing every radar tile in view or the map's ink tiles arriving together from the cache when the
// weather goes on, fills in over a few frames instead of stalling one. A job whose live() is false by its turn rejects
// undrawn.
// ponytail: the oldest job goes first, and a tile that has left the view by its turn is still drawn (live() is the layer's
// to answer, and Cesium cancels no imagery request once it is in flight). Upgrade: newest first, or live() asking the tile.
const DRAW_MS = 6
const queue: (() => void)[] = []

/** draw() run in its turn, unless live() is false by then: it rejects undrawn. */
export function queueDraw<T>(draw: () => T, live: () => boolean = () => true): Promise<T> {
  return new Promise((resolve, reject) => {
    const job = (): void => {
      try {
        if (!live()) throw new Error('dropped')
        resolve(draw())
      } catch (e) {
        reject(e)
      }
    }
    if (queue.push(job) === 1) requestAnimationFrame(pump)
  })
}

function pump(): void {
  const end = performance.now() + DRAW_MS
  // The first job however long it takes, then more while the frame's time lasts. A job that queued another asked for a
  // frame of its own: that one may find the queue empty.
  for (let job = queue.shift(); job !== undefined; job = performance.now() < end ? queue.shift() : undefined) job()
  if (queue.length > 0) requestAnimationFrame(pump)
}
