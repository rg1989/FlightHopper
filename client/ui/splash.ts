// client/ui/splash.ts
// The boot screen: brand, a spinner and what is happening ("Loading the globe…", "Connecting to live traffic…"), shown
// from the first script tick until the first aircraft arrive; then it fades out. fail() turns it into the error screen.
import { icon } from './icons.ts'
import './theme.css'
import './splash.css'

export interface SplashHandle {
  set(text: string): void
  done(): void
  fail(message: string): void
}

export function mountSplash(): SplashHandle {
  const el = document.createElement('div')
  el.className = 'fh-splash'
  el.setAttribute('role', 'status')
  const mark = document.createElement('div')
  mark.className = 'fh-splash-mark'
  mark.append(icon('plane', 30))
  const name = document.createElement('div')
  name.className = 'fh-splash-name'
  name.textContent = 'FlightHopper'
  const spin = document.createElement('span')
  spin.className = 'fh-spin fh-lg'
  const text = document.createElement('div')
  text.className = 'fh-splash-text'
  text.textContent = 'Loading the globe…'
  el.append(mark, name, spin, text)
  document.body.append(el)
  let over = false

  return {
    set(t) {
      if (!over) text.textContent = t
    },
    done() {
      if (over) return
      over = true
      el.classList.add('fh-out')
      setTimeout(() => el.remove(), 450)
    },
    fail(message) {
      over = true
      el.classList.add('fh-failed')
      spin.remove()
      text.textContent = message
    },
  }
}
