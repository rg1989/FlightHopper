// client/ui/splash.ts
// The boot screen: brand, a spinner and what is happening ("Loading the globe…", "Connecting to live traffic…"), shown
// from the first script tick until the first aircraft arrive; then it fades out. A step that takes longer than SLOW_MS
// adds why it may be slow and, where the map is already usable, "Show the map now". offline() and fail() turn it into
// the outage emblem (outage.ts) with what happened and what to do: offline reloads by itself when the network is back,
// a start-up failure offers "Try again".
import { icon } from './icons.ts'
import { outageArt } from './outage.ts'
import './theme.css'
import './splash.css'

export const SLOW_MS = 7000

export interface SplashHandle {
  /** The step now under way; after SLOW_MS, `hint` says why it may be slow, and `skip` offers the map at once. */
  set(text: string, o?: { hint?: string; skip?: boolean }): void
  done(): void
  offline(): void
  fail(message: string): void
}

export function mountSplash(): SplashHandle {
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag)
    e.className = className
    if (text !== '') e.textContent = text
    return e
  }
  const el = h('div', 'fh-splash')
  el.setAttribute('role', 'status')
  const mark = h('div', 'fh-splash-mark')
  mark.append(icon('plane', 30))
  const name = h('div', 'fh-splash-name', 'FlightHopper')
  const spin = h('span', 'fh-spin fh-lg')
  const text = h('div', 'fh-splash-text', 'Loading the globe…')
  const slow = h('div', 'fh-splash-slow')
  slow.hidden = true
  const slowText = h('p', 'fh-splash-slow-t')
  const skip = h('button', 'fh-pill fh-pill-secondary', 'Show the map now')
  skip.type = 'button'
  slow.append(slowText, skip)
  el.append(mark, name, spin, text, slow)
  document.body.append(el)
  let over = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const api: SplashHandle = {
    set(t, o = {}) {
      if (over) return
      text.textContent = t
      slow.hidden = true
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        slowText.textContent = `Taking longer than usual.${o.hint ? ` ${o.hint}` : ''}`
        skip.hidden = !o.skip
        slow.hidden = false
      }, SLOW_MS)
    },
    done() {
      if (over) return
      over = true
      if (timer !== null) clearTimeout(timer)
      el.classList.add('fh-out')
      setTimeout(() => el.remove(), 450)
    },
    offline() {
      screen('wifiOff', 'You’re offline', 'FlightHopper needs the internet for live traffic, maps and weather. It starts by itself as soon as the network is back.', null)
    },
    fail(message) {
      screen('alert', 'FlightHopper couldn’t start', message, 'Try again')
    },
  }
  skip.addEventListener('click', () => api.done())
  /** The outage emblem, a title, what happened and, when there is one, a button that reloads the page. */
  function screen(iconName: 'wifiOff' | 'alert', title: string, body: string, action: string | null): void {
    over = true
    if (timer !== null) clearTimeout(timer)
    el.classList.add('fh-failed')
    el.dataset.tone = 'red'
    const box = h('div', 'fh-splash-fail')
    box.append(outageArt(iconName, 'red'), h('h1', 'fh-splash-fail-t', title), h('p', 'fh-splash-fail-b', body))
    if (action !== null) {
      const b = h('button', 'fh-pill', action)
      b.type = 'button'
      b.addEventListener('click', () => location.reload())
      box.append(b)
    }
    el.replaceChildren(box)
  }
  api.set('Loading the globe…', { hint: 'The map and terrain servers are slow to answer.' })
  return api
}
