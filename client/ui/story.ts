// client/ui/story.ts
// The scenario's story messages (events.csv `story` rows): one short line of narrative at a time, top-left where the
// flight card sits outside scenarios, fading in when its moment comes and out when it has passed. However fast the
// clock runs, a message stays at least MIN_MS on screen (unless the next replaces it), so it can be read at 16×.
import './story.css'

export interface StoryView {
  key: string
  clock: string // '18:24:35 JST'
  text: string
}

export const MIN_MS = 5000

export interface StoryHandle {
  update(s: StoryView | null): void
  destroy(): void
}

export function mountStory(root: HTMLElement, now: () => number = () => performance.now()): StoryHandle {
  const box = document.createElement('div')
  box.className = 'fh-story fh-out'
  box.setAttribute('role', 'status')
  box.setAttribute('aria-live', 'polite')
  const time = document.createElement('div')
  time.className = 'fh-story-t'
  const text = document.createElement('p')
  text.className = 'fh-story-x'
  box.append(time, text)
  root.append(box)

  let key: string | null = null // the message on screen (fading out included)
  let since = 0
  let out = true
  return {
    update(s) {
      if (s !== null && s.key !== key) {
        key = s.key
        since = now()
        time.textContent = s.clock
        text.textContent = s.text
        box.classList.remove('fh-out', 'fh-in')
        void box.offsetWidth // restarts the entry animation when one message replaces another
        box.classList.add('fh-in')
        out = false
      } else if (s === null && !out && now() - since >= MIN_MS) {
        box.classList.add('fh-out')
        out = true
        key = null
      }
    },
    destroy() {
      box.remove()
    },
  }
}
