// client/ui/osk.ts
// The TV's on-screen keyboard (?tv=1; remote.ts opens it with OK on a text field): the remote cannot type, so a glass
// panel of big keys at the bottom centre types for it. The field keeps the DOM focus all along (the top search box
// closes its list when its field loses it); the keyboard only draws, its text line echoing the field. Its highlighted
// key moves with the arrows (oskMove: ↑/↓ keep the column, ←/→ wrap round the row) and OK types it as typing would
// (typeInto: the value, then an input event), at the end of the text. Keys: 0–9, a–z, Space, ⌫, Clear, Done; Done or
// Back closes it, the field keeps its focus and its text. It lives in the top layer (a popover), over a modal dialog's
// fields too (Settings), and html[data-osk] tells the search box's list to stop above it (osk.css).
import type { Dir } from './remote.ts'
import './osk.css'

export type OskKind = 'char' | 'back' | 'clear' | 'done'

export interface OskKey {
  label: string
  kind: OskKind
  text: string // what a char key types
  row: number
  col: number // the first of the span columns it takes of OSK_COLS
  span: number
}

/** Where the highlight is: a row, and the column ↑/↓ keep (a wide key covers several). */
export interface OskAt {
  row: number
  col: number
}

export const OSK_COLS = 13

const key = (label: string, kind: OskKind = 'char', span = 1, text = kind === 'char' ? label : ''): Omit<OskKey, 'row' | 'col'> => ({ label, kind, text, span })
const chars = (s: string): Omit<OskKey, 'row' | 'col'>[] => [...s].map((c) => key(c))

/** The keys row by row, a TV app's alphabetical grid (four rows: low enough for a 960×540 view), OSK_COLS a row. */
export const OSK_KEYS: readonly (readonly OskKey[])[] = [
  [...chars('1234567890'), key('⌫', 'back', 3)],
  chars('abcdefghijklm'),
  chars('nopqrstuvwxyz'),
  [key('Space', 'char', 7, ' '), key('Clear', 'clear', 3), key('Done', 'done', 3)],
].map((keys, row) => {
  let col = 0
  return keys.map((k) => {
    const placed = { ...k, row, col }
    col += k.span
    return placed
  })
})

/** The key at the highlight: the one of its row covering its column. */
export function oskKey(at: OskAt): OskKey {
  const row = OSK_KEYS[at.row]
  return row.find((k) => at.col >= k.col && at.col < k.col + k.span) ?? row[row.length - 1]
}

/**
 * The highlight after an arrow: ↑/↓ a row (not past the first or last), in the same column; ←/→ the next key in the row,
 * round from its end to its start, the column then the edge of that key it came in by.
 */
export function oskMove(at: OskAt, dir: Dir): OskAt {
  if (dir === 'up' || dir === 'down') return { row: Math.min(OSK_KEYS.length - 1, Math.max(0, at.row + (dir === 'down' ? 1 : -1))), col: at.col }
  const row = OSK_KEYS[at.row]
  const i = row.indexOf(oskKey(at))
  const next = row[(i + (dir === 'right' ? 1 : row.length - 1)) % row.length]
  return { row: at.row, col: dir === 'right' ? next.col : next.col + next.span - 1 }
}

/** A field's text after a key: a char added at the end, ⌫ the last one off, Clear none; Done leaves it. */
export function oskEdit(value: string, k: OskKey): string {
  return k.kind === 'char' ? value + k.text : k.kind === 'back' ? value.slice(0, -1) : k.kind === 'clear' ? '' : value
}

export type TextField = HTMLInputElement | HTMLTextAreaElement

/** The caret to the end of the text, where the keys type. */
function caretToEnd(field: TextField): void {
  try {
    field.setSelectionRange(field.value.length, field.value.length)
  } catch {
    // a type without a caret (number, email)
  }
}

/** Sets a field's text the way typing it would (the caret at its end, an input event after), within its maxLength. */
export function typeInto(field: TextField, value: string): void {
  if (field.maxLength >= 0 && value.length > field.maxLength && value.length > field.value.length) return
  field.value = value
  caretToEnd(field)
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

export interface OskHandle {
  readonly field: TextField | null // the field it types into; null while closed
  open(field: TextField): void
  close(): void
  move(dir: Dir): void
  /** OK: types the highlighted key (Done closes). A held OK repeats only ⌫. */
  press(repeat: boolean): void
  destroy(): void
}

export function mountOsk(parent: HTMLElement): OskHandle {
  const panel = document.createElement('div')
  panel.className = 'fh-osk fh-glass'
  panel.popover = 'manual'
  panel.setAttribute('aria-hidden', 'true') // the field is what a screen reader follows; this only shows the remote's keys
  // The field's text, the caret after it, and its placeholder while it is empty.
  const line = document.createElement('div')
  line.className = 'fh-osk-line'
  const text = document.createElement('span')
  const caret = document.createElement('span')
  caret.className = 'fh-osk-caret'
  const hint = document.createElement('span')
  hint.className = 'fh-osk-hint'
  line.append(text, caret, hint)
  const grid = document.createElement('div')
  grid.className = 'fh-osk-keys'
  grid.style.setProperty('--fh-osk-cols', String(OSK_COLS))
  const cells = OSK_KEYS.map((row) => row.map((k) => {
    const c = document.createElement('span')
    c.className = `fh-osk-key${k.kind === 'char' && k.span === 1 ? '' : ' fh-osk-wide'}`
    c.dataset.kind = k.kind
    c.textContent = k.label
    c.style.gridArea = `${k.row + 1} / ${k.col + 1} / span 1 / span ${k.span}`
    grid.append(c)
    return c
  }))
  panel.append(line, grid)
  parent.append(panel)

  let field: TextField | null = null
  let at: OskAt = { row: 1, col: 0 }
  const html = document.documentElement

  function paint(): void {
    const k = oskKey(at)
    for (const row of cells) for (const c of row) c.classList.remove('fh-on')
    cells[k.row][OSK_KEYS[k.row].indexOf(k)].classList.add('fh-on')
    const v = field?.value ?? ''
    text.textContent = field instanceof HTMLInputElement && field.type === 'password' ? '•'.repeat(v.length) : v
    hint.textContent = v === '' ? (field?.placeholder ?? '') : ''
    line.scrollLeft = line.scrollWidth // a long text shows its end, where the keys type
  }
  const onInput = (): void => paint() // a physical keyboard types into it too

  function close(): void {
    if (field === null) return
    field.removeEventListener('input', onInput)
    field = null
    delete html.dataset.osk
    if (panel.matches(':popover-open')) panel.hidePopover()
  }

  return {
    get field() {
      return field
    },
    open(f) {
      close()
      field = f
      f.addEventListener('input', onInput)
      at = { row: 1, col: 0 }
      html.dataset.osk = ''
      panel.showPopover()
      caretToEnd(f)
      paint()
    },
    close,
    move(dir) {
      at = oskMove(at, dir)
      paint()
    },
    press(repeat) {
      if (field === null) return
      const k = oskKey(at)
      if (repeat && k.kind !== 'back') return
      if (k.kind === 'done') return close()
      typeInto(field, oskEdit(field.value, k))
      paint()
    },
    destroy() {
      close()
      panel.remove()
    },
  }
}
