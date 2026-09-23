// client/scenario/run.ts
// One scenario playing (.planning/scenarios-design.md §2, §4). ScenarioPlayer is the pure part: the clock and, each
// step, what the scenario shows at its time: the pose, the flight-data frame's numbers, the events, the captions and
// the ending. ScenarioRun adds what lives in the page: the play bar, the captions and the ending card in the app's
// overlay, the era imagery under the night lights, the audio (only when the package has it), and the keys (Space
// play/pause, ←/→ ±10 s, Shift ±60 s). The app (app.ts) draws the rest from the frame: the model, the chase camera, the
// sun at the scenario's instant and the frame around the aircraft. Dresser puts the scenario's type, livery, span,
// damage and gear on the chase model.
import { Color, ImageryLayer, Rectangle, UrlTemplateImageryProvider } from 'cesium'
import type { Viewer } from 'cesium'
import type { Livery } from '../scene/livery.ts'
import type { FlightData, ModelManifestEntry, RenderState } from '../types.ts'
import { mountCaptions, type CaptionView } from '../ui/captions.ts'
import { mountEnding } from '../ui/ending.ts'
import { clockText, mountPlaybar } from '../ui/playbar.ts'
import { mountStory } from '../ui/story.ts'
import { AudioSync } from './audio.ts'
import { ScenarioClock } from './clock.ts'
import { PoseTrack, type PoseData } from './pose.ts'
import { captionsAt, endingAt, eventStateAt, marks, storyAt, type EventState, type Story } from './timeline.ts'
import type { ImagerySpec, Line, Scenario, SpeakerDef } from './types.ts'

/** A move of the clock by more than this between two frames, other than by playing, is a seek: the camera snaps behind. */
export const JUMP_S = 2

/** What a scenario shows at one step. state is the pose track's one reused object: copy it to keep it. */
export interface ScenarioFrame {
  t: number
  state: RenderState
  data: FlightData // aglFt null: the app knows the ground under the aircraft
  tUtcMs: number
  event: EventState
  fade: number // 0…1: the ending's veil (and the sound's fade)
  card: boolean // the ending card is up
  lines: readonly Line[] // the captions on screen (none once dark)
  story: Story | null // the story message at t (none once the ending fades in)
  jumped: boolean // a seek since the last step
}

export interface PoseLike {
  stateAt(t: number): RenderState
  dataAt(t: number): PoseData
}

/** The clock's last second: the last data second, or the ending card's moment when it comes later. */
export function stopOf(s: Pick<Scenario, 'end' | 'ending'>): number {
  return s.ending === null ? s.end : Math.max(s.end, s.ending.darkAt + s.ending.cardAfterS)
}

/** The clock (paused at t, else at the start) and the frame at its time. No DOM, no viewer. */
export class ScenarioPlayer {
  readonly scenario: Scenario
  readonly clock: ScenarioClock
  readonly #pose: PoseLike
  #lastT: number

  constructor(scenario: Scenario, pose: PoseLike, t?: number) {
    this.scenario = scenario
    this.#pose = pose
    this.clock = new ScenarioClock(scenario.start, stopOf(scenario), t !== undefined && Number.isFinite(t) ? t : scenario.start)
    this.#lastT = this.clock.t
  }

  toggle(): void {
    if (this.clock.playing) this.clock.pause()
    else this.clock.play()
  }

  seek(t: number): void {
    this.clock.seek(t)
  }

  seekBy(s: number): void {
    this.clock.seek(this.clock.t + s)
  }

  /** Advances the clock by dtS (real seconds) while playing and composes the frame at its new time. */
  step(dtS: number): ScenarioFrame {
    const s = this.scenario
    const jumped = Math.abs(this.clock.t - this.#lastT) > JUMP_S // seeks happen between frames
    this.clock.tick(dtS)
    const t = (this.#lastT = this.clock.t)
    const event = eventStateAt(s.events, t)
    const pose = this.#pose.dataAt(t)
    const { fade, card } = endingAt(s.ending, t)
    return {
      t,
      state: this.#pose.stateAt(t),
      data: { ...pose, aglFt: null, gear: event.gear ? 'down' : 'up', flaps: event.flaps, derived: new Set(pose.derived).add('aglFt') },
      tUtcMs: s.t0UtcMs + t * 1000,
      event,
      fade,
      card,
      lines: fade >= 1 ? [] : captionsAt(s.lines, t),
      story: fade > 0 ? null : storyAt(s.events, t),
      jumped,
    }
  }
}

/** Where a typed Space or arrow is the field's own (the scrubber, a search box), not the player's. */
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export interface KeyLike {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  repeat: boolean
  target: unknown
}

/**
 * What a keydown asks of the player: Space plays or pauses, ←/→ step 10 s, Shift+←/→ 60 s. null with Cmd, Ctrl or Alt
 * (the browser's), on auto-repeat, while typing in a field (the play bar's scrubber takes its own keys), and for Space on
 * a focused button (Space presses it).
 */
export function scenarioKey(e: KeyLike): { toggle: true } | { stepS: number } | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return null
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null
  if (t?.isContentEditable || TYPING.has(t?.tagName ?? '')) return null
  if (e.key === ' ') return t?.tagName === 'BUTTON' ? null : { toggle: true }
  const step = e.shiftKey ? 60 : 10
  return e.key === 'ArrowLeft' ? { stepS: -step } : e.key === 'ArrowRight' ? { stepS: step } : null
}

/** A transcript line as the captions show it; key i is its index in the transcript (stable from frame to frame). */
export function captionView(l: Line, i: number, speakers: Readonly<Record<string, SpeakerDef>>): CaptionView {
  return {
    key: `l${i}`,
    who: speakers[l.speaker]?.name ?? l.speaker,
    to: l.to === null ? null : (speakers[l.to]?.name ?? l.to),
    channel: l.channel,
    translated: l.q === 'T',
    unintelligible: l.q === 'U',
    text: l.text,
    original: l.original,
  }
}

/** The About panel's lines for a running scenario: its sources and its imagery. */
export function scenarioCredits(s: Pick<Scenario, 'title' | 'sources' | 'imagery'>): string[] {
  const lines = [`Scenario ${s.title}, sources: ${s.sources.map((r) => r.title).join('; ')}`]
  if (s.imagery.length > 0) lines.push(`Scenario imagery: ${s.imagery.map((i) => i.credit).join('; ')}`)
  return lines
}

/**
 * Where an era layer's pixels are black in every channel (below this, 0–1), they are no data and show the base imagery
 * through. Old aerial mosaics fill what was never photographed (the sea, beyond a strip's edge) with black, and Cesium
 * draws a failed tile's lower-zoom ancestor there, black parts and all.
 * ponytail: black only, and JPEG ringing leaves a dark seam along the edge of the photos. Upgrade: a no-data colour and
 * threshold per imagery entry in scenario.json, if a source fills with another colour.
 */
export const NO_DATA_BLACK = 0.02

/** A package's era imagery as a tile layer: only over its rectangle, only at its zoom levels. */
export function eraLayerOptions(spec: ImagerySpec): UrlTemplateImageryProvider.ConstructorOptions {
  const [west, south, east, north] = spec.rect
  return {
    url: spec.url,
    rectangle: Rectangle.fromDegrees(west, south, east, north),
    credit: spec.credit,
    ...(spec.minZoom === undefined ? {} : { minimumLevel: spec.minZoom }),
    ...(spec.maxZoom === undefined ? {} : { maximumLevel: spec.maxZoom }),
  }
}

/** The parts of ChaseModel (scene/model.ts) a scenario sets. */
export interface DressableModel {
  readonly entry: ModelManifestEntry
  use(entry: ModelManifestEntry): boolean
  paintLivery(livery: Livery): void
  setShape(halfSpanM: number | null): void
  setDamage(on: boolean): void
  setGear(on: boolean): void
}

/**
 * The scenario's aircraft on the chase model. apply() runs every frame: it asks for the scenario's type until it is
 * drawn (use() loads it asynchronously and switches when it is ready), paints and folds whatever model is drawn, again
 * after a switch (a switch keeps shape and damage but not the paint), and sets the damage and gear of this moment.
 */
export class Dresser {
  readonly #entry: ModelManifestEntry | null
  readonly #livery: Livery | null
  readonly #halfSpanM: number | null
  #dressed: ModelManifestEntry | null = null

  constructor(entry: ModelManifestEntry | null, livery: Livery | null, halfSpanM: number | null) {
    this.#entry = entry
    this.#livery = livery
    this.#halfSpanM = halfSpanM
  }

  /** True when the drawn model switched this call: the Sun re-attaches its light to it. */
  apply(model: DressableModel, damage: boolean, gear: boolean): boolean {
    const switched = this.#entry !== null && model.use(this.#entry)
    if (model.entry !== this.#dressed) {
      this.#dressed = model.entry
      if (this.#livery !== null) model.paintLivery(this.#livery)
      model.setShape(this.#halfSpanM)
    }
    model.setDamage(damage)
    model.setGear(gear)
    return switched
  }

  /** Back to the live chase's model: no fold, no damage, no separate gear. Its next paint(code) repaints it. */
  static undress(model: DressableModel): void {
    model.setShape(null)
    model.setDamage(false)
    model.setGear(false)
  }
}

export interface ScenarioRunOpts {
  viewer: Viewer
  ui: HTMLElement // the app's overlay (.fh-ui): the play bar, captions and ending go in it
  scenario: Scenario
  t?: number // start here, paused (a reload's ?t=); else at the start
  play?: boolean // start playing (the Scenarios panel's Play)
  under: ImageryLayer | null // the era imagery goes right under this layer (the night lights), over the base
  onExit(): void // the play bar's exit, the ending card's Close
}

/** A scenario playing in the page. frame() once a frame; destroy() removes everything it added. */
export class ScenarioRun {
  readonly player: ScenarioPlayer
  readonly #viewer: Viewer
  readonly #layers: ImageryLayer[] = []
  readonly #views = new Map<Line, CaptionView>()
  readonly #bar: ReturnType<typeof mountPlaybar>
  readonly #captions: ReturnType<typeof mountCaptions>
  readonly #story: ReturnType<typeof mountStory>
  readonly #ending: ReturnType<typeof mountEnding>
  readonly #audioEl: HTMLAudioElement | null = null
  readonly #audio: AudioSync | null = null
  readonly #onKey: (e: KeyboardEvent) => void

  static start(o: ScenarioRunOpts): ScenarioRun {
    return new ScenarioRun(o)
  }

  private constructor(o: ScenarioRunOpts) {
    const s = o.scenario
    this.#viewer = o.viewer
    const pose = new PoseTrack(s.track, { hex: `scn-${s.id}`, callsign: s.aircraft.callsign, typeCode: null })
    this.player = new ScenarioPlayer(s, pose, o.t)
    if (o.play) this.player.clock.play()
    s.lines.forEach((l, i) => this.#views.set(l, captionView(l, i, s.speakers)))
    const clock = this.player.clock
    this.#captions = mountCaptions(o.ui)
    this.#story = mountStory(o.ui)
    this.#ending = mountEnding(o.ui, { onClose: () => o.onExit() })
    this.#bar = mountPlaybar(o.ui, {
      start: s.start, stop: clock.stop, end: s.end, marks: marks(s.events), clockLabel: s.clockLabel, title: s.title,
      onToggle: () => this.player.toggle(),
      onSeek: (t) => this.player.seek(t),
      onRate: () => void clock.nextRate(),
      onExit: () => o.onExit(),
    })
    // Over the base imagery, under the night lights: in the order the package lists them, the first lowest.
    const layers = o.viewer.imageryLayers
    for (const spec of s.imagery) {
      const provider = new UrlTemplateImageryProvider(eraLayerOptions(spec))
      // Old photos cover only part of their rectangle: the tiles beyond them answer 404, which is expected. A listener
      // keeps Cesium from logging each one (the browser still lists the requests).
      provider.errorEvent.addEventListener(() => {})
      const layer = new ImageryLayer(provider, { colorToAlpha: Color.BLACK, colorToAlphaThreshold: NO_DATA_BLACK })
      layers.add(layer, o.under === null || !layers.contains(o.under) ? undefined : layers.indexOf(o.under))
      this.#layers.push(layer)
    }
    if (s.audio !== null && s.present.audio) {
      this.#audioEl = new Audio(`${s.base}${s.audio.file}`)
      this.#audioEl.preload = 'auto'
      this.#audio = new AudioSync(this.#audioEl, s.audio.clips)
    }
    this.#onKey = (e) => {
      const k = scenarioKey(e)
      if (k === null) return
      e.preventDefault() // no page scroll, no click on the focused element
      if ('toggle' in k) this.player.toggle()
      else this.player.seekBy(k.stepS)
    }
    window.addEventListener('keydown', this.#onKey)
  }

  get scenario(): Scenario {
    return this.player.scenario
  }

  frame(dtS: number): ScenarioFrame {
    const f = this.player.step(dtS)
    const clock = this.player.clock
    this.#bar.update({ t: f.t, playing: clock.playing, rate: clock.rate, clock: clockText(f.t), phase: f.event.phase })
    this.#captions.update(f.lines.map((l) => this.#views.get(l)!))
    this.#story.update(f.story === null ? null : { key: f.story.key, clock: `${clockText(f.story.t)} ${this.scenario.clockLabel}`, text: f.story.text })
    this.#ending.update(f.fade, f.card ? this.scenario.ending!.card : null)
    this.#audio?.update(f.t, clock.playing, clock.rate, 1 - f.fade)
    // The era imagery takes the base's brightness, which the Sun lowers at dusk.
    const layers = this.#viewer.imageryLayers
    const i = this.#layers.length === 0 ? -1 : layers.indexOf(this.#layers[0])
    const base = i > 0 ? layers.get(i - 1) : null
    if (base !== null) for (const l of this.#layers) l.brightness = base.brightness
    return f
  }

  destroy(): void {
    window.removeEventListener('keydown', this.#onKey)
    this.#bar.destroy()
    this.#captions.destroy()
    this.#story.destroy()
    this.#ending.destroy()
    const layers = this.#viewer.imageryLayers
    for (const l of this.#layers) if (!layers.isDestroyed() && layers.contains(l)) layers.remove(l, true)
    this.#layers.length = 0
    if (this.#audioEl !== null) {
      this.#audioEl.pause()
      this.#audioEl.removeAttribute('src')
      this.#audioEl.load() // lets go of the file
    }
  }
}
