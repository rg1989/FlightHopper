// client/ui/legend.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { altitudeColor } from '../scene/altitudeColor.ts'
import { LEGEND_TICKS_FT, legendGradient, mountLegend, tickLabel } from './legend.ts'

// Node has no DOM: just enough of one for mountLegend (createElement, append, remove, style, textContent, attributes).
class El {
  children: El[] = []
  parent: El | null = null
  style: Record<string, string> = {}
  attrs: Record<string, string> = {}
  className = ''
  textContent = ''
  tagName: string
  constructor(tagName: string) {
    this.tagName = tagName
  }
  append(...cs: El[]): void {
    for (const c of cs) {
      c.parent = this
      this.children.push(c)
    }
  }
  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  find(cls: string): El | undefined {
    if (this.className === cls) return this
    for (const c of this.children) {
      const f = c.find(cls)
      if (f) return f
    }
    return undefined
  }
}
Object.assign(globalThis, { document: { createElement: (tag: string) => new El(tag) } })
const mount = (): { root: El; legend: { destroy(): void } } => {
  const root = new El('div')
  return { root, legend: mountLegend(root as unknown as HTMLElement) }
}

test('ticks: 0, 1 000, 2 000, 4 000, 6 000, 8 000, 10 000, 20 000, 30 000, 40 000+ ft', () => {
  assert.deepEqual([...LEGEND_TICKS_FT], [0, 1_000, 2_000, 4_000, 6_000, 8_000, 10_000, 20_000, 30_000, 40_000])
  assert.deepEqual(
    LEGEND_TICKS_FT.map(tickLabel),
    ['0', '1k', '2k', '4k', '6k', '8k', '10k', '20k', '30k', '40k+'],
  )
})

test('gradient: evenly spaced ticks, each tick in its altitude colour, sampled in between', () => {
  const g = legendGradient()
  assert.ok(g.startsWith(`linear-gradient(to right, ${altitudeColor(0, false)} 0.00%`), g.slice(0, 80))
  assert.ok(g.endsWith(`${altitudeColor(40_000, false)} 100.00%)`))
  const n = LEGEND_TICKS_FT.length - 1
  LEGEND_TICKS_FT.forEach((ft, i) => assert.ok(g.includes(`${altitudeColor(ft, false)} ${((i / n) * 100).toFixed(2)}%`), `${ft} ft at tick ${i}`))
  assert.ok(g.includes(`${altitudeColor(15_000, false)} ${((6.5 / n) * 100).toFixed(2)}%`), 'half-way between 10 000 and 20 000')
  assert.ok(g.split('%').length - 1 > 60, 'enough stops for the HSL path')
})

test('mountLegend: a vertical scale (0 at the bottom), the tick labels at their heights, the ground swatch, a caption', () => {
  const { root } = mount()
  assert.equal(root.children.length, 2)
  const el = root.children[0]
  assert.match(el.attrs['aria-label'], /altitude/i)
  const gnd = el.find('fh-legend-gnd') as El
  assert.equal(gnd.style.background, altitudeColor(null, true))
  assert.equal((el.find('fh-legend-unit') as El).textContent, 'On the ground')
  assert.equal((el.find('fh-legend-bar') as El).style.background, legendGradient('to top'))
  const ticks = (el.find('fh-legend-ticks') as El).children
  assert.deepEqual(ticks.map((t) => t.textContent), LEGEND_TICKS_FT.map((ft) => `${tickLabel(ft)} ft`))
  assert.deepEqual(ticks.map((t) => t.style.bottom), LEGEND_TICKS_FT.map((_, i) => `${((i / 9) * 100).toFixed(2)}%`))
  assert.equal(el.style.pointerEvents, 'none', 'never blocks the map under it')
})

test('destroy removes the legend; twice is harmless', () => {
  const { root, legend } = mount()
  legend.destroy()
  assert.equal(root.children.length, 0)
  legend.destroy()
  assert.equal(root.children.length, 0)
})
