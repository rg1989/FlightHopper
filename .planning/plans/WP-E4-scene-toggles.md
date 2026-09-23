# WP-E4 — Scene Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In chase mode, give the user two switches, "3-D terrain" and "Sun" (design D11). They keep their state across reloads, and the URL can force them for demos. This package builds the preference rules and the button group. The app (WP-E-A) connects them to `Topography` (E1) and `Sun` (E2), binds the keys T and L, stores the preferences and places the group. There is no shadows switch: cast shadows are dropped (D10). The PoC measured 65 → 46–52 fps with them and stripes on the aircraft, and the user judged the gain small (feedback of 2026-09-22).

**Architecture:** Two modules, one stylesheet and a harness page. No Cesium.
- `client/ui/scenePrefs.ts` is pure. The app passes `location.search`, the stored string and the storage, so the Node tests need no DOM.
  - `PREFS_KEY = 'fh.scene.v1'`. `DEFAULT_PREFS = { topo: true, light: true }`, frozen because it is shared.
  - `readScenePrefs(search, stored)` decides each field on its own: `?topo=0|1` / `?light=0|1`, else the stored JSON, else the default. In the URL only the exact values `0` and `1` count (the first occurrence, as `URLSearchParams.get` returns it). `?topo=false`, `?topo=` and similar are ignored. In the stored JSON only real booleans count. Corrupt JSON, `null`, a number, a string, an array or a missing field falls back field by field. It never throws.
  - `writeScenePrefs(prefs, storage)` stores `JSON.stringify({ topo, light })` under `PREFS_KEY`. Only the two fields are written, so a caller's extra properties never reach storage. `null` storage does nothing. Any error from `setItem` is swallowed: `QuotaExceededError`, a blocked storage, or Node 25's stub `localStorage`, which has no `setItem`.
- `client/ui/sceneToggles.ts`: `mountSceneToggles(root, { prefs, onChange })` appends one `div.fh-toggles` with `role="group"` and `aria-label="Terrain and sun"`. It holds two `<button type="button" class="fh-toggle">`: "3-D terrain" (title "Topography — T") and "Sun" (title "Sun lighting — L"), each with `aria-pressed`. The labels never change with the state (the APG toggle-button rule). Buttons are focusable, and Space and Enter activate them.
  - **Controlled.** A click calls `onChange` with a new `{ topo, light }` that has one field flipped. The group then shows nothing new until the app calls `update()`, so it never shows a state the app did not accept.
  - `update(prefs)` keeps two booleans, not the caller's object. It writes `aria-pressed` only on a button whose value changed, so a call every frame costs two comparisons and allocates nothing.
  - `destroy()` removes the group. The module adds no listener outside its two buttons and never touches storage: the keys and the persistence belong to the app.
- `client/ui/sceneToggles.css` uses the palette of `table.css` and `detail.css`: the panel `rgba(10, 14, 20, 0.82)`, the table's selection blue for "on", and the search box's `#4aa3ff` for the focus ring (`:focus-visible` only, so a mouse click shows no ring). An 8 px lamp before each label is filled when on and a ring when off, so the state does not rest on colour alone. `pointer-events: auto`, because the right-hand column is `pointer-events: none`. `width: max-content`, `flex: none` and `white-space: nowrap` keep it on one line at the column's right edge. It sets no position: E-A's `layout.css` places it and hides it in browse. On phones (≤ 640 px) the buttons get a 32 px minimum height instead of 26 px.
- `harness/scene-toggles.html` + `.ts` mount the group where the app's right-hand column starts (top right, 8 px in), over satellite, snow and night stand-ins. The page plays the app's part: `onChange` stores the preferences with `writeScenePrefs` and answers with `update()`. T and L do the same, without a modifier. The panel shows the URL, the value stored at load, what `readScenePrefs` makes of them, the value stored now, the buttons' `aria-pressed` and the last 8 `onChange` calls. "forget stored" removes the page's own `fh.scene.v1` entry.

Conventions consumers (E-A) rely on:
- **Start.** Read the stored string with both the `localStorage` getter and `getItem` inside `try`: either can throw `SecurityError` when storage is blocked (`harness/scene-toggles.ts` has the pattern). Then `prefs = readScenePrefs(location.search, stored)`.
- **One path for every change.** Clicks (`onChange`) and the keys T and L call the same `setPrefs(next)`: apply `next` to E1 and E2, `writeScenePrefs(next, storage)`, then `toggles.update(next)`.
- **Store on a user action only, never at load.** Opening a `?topo=0` link then leaves the stored choice alone. The first toggle after such a link stores the whole state shown, including the URL's value. ponytail: accepted, because demo links are rare. Upgrade: store only the field the user changed.
- **Placement.** Mount the group first in `.fh-right`, before `mountTable` (`client/app.ts:235`), so it sits at the top of the right-hand column. Add `.fh-ui[data-mode='browse'] .fh-toggles { display: none }` to `layout.css` (D9, D11).
- **Phones.** At ≤ 640 px the detail panel spans the top of the screen at `z-index: 11` (`detail.css:7`, `:185-190`), above the column (`z-index: 10`), so it covers the column's top. E-A must move the group there, for example with `margin-top: auto` so it sits just above the credits, and check 375×667 and 375×812 (research E, risks).

**Tech Stack:** DOM and CSS (no framework), `URLSearchParams`, `JSON`, Web Storage (`localStorage`), `node:test`. No Cesium API and no new dependencies. The `mountSceneToggles` tests run on a fake DOM of about 40 lines, as in `client/ui/legend.test.ts` and `client/ui/detail.test.ts`. As in `detail.test.ts`, `module.registerHooks` loads the `.css` import as an empty module in Node.

**Wave:** after WP-E0, in parallel with E1, E2, E3 and E5 (it depends only on E0's `ScenePrefs`). Consumed by E-A. **Estimated:** 45 min. **Validated:** 2026-09-22 in a scratch copy of the integrated B-A tree plus WP-E0 (Node 25.2.1, TypeScript 7.0.2, Vite 8.3.0, Cesium 1.145.0, not used here) on the user's MacBook Air M2:
- `node --test client/ui/scenePrefs.test.ts client/ui/sceneToggles.test.ts` passed 14/14 (7 + 7). `npx tsc --noEmit` is clean for the whole tree, including the harness. `npm test` passed 625/625 (611 on the E0 tree + 14).
  - An earlier full run, while other agents loaded the machine (load average 27), gave 624/625. The one failure was the known flake "budget: /api/view of a 250 nm circle with 5,000 aircraft" (median 76.3 ms against 50 ms). The untouched E0 tree failed it the same way at that moment (129.3 ms). Run alone at load 17, it passed (12.7 ms).
- **RED:** Steps 2 quote the real output: `ERR_MODULE_NOT_FOUND` from each test, and TS2307 (+ TS7006 for the toggles' `onChange` parameter) from `tsc`.
- **Mutations:** 22 hand-made faults, each caught by 1–4 failing tests:
  - `scenePrefs`: the stored value winning over the URL; the PoC's URL rule (anything but `0` is on); any truthy stored value counting; no `try` around `JSON.parse`; `saved.topo` without `?.` (the JSON `null`); the light default off; `DEFAULT_PREFS` not frozen; the key without its version; writing the whole object; no `try` around `setItem`.
  - `sceneToggles`: a click flipping its own `aria-pressed`; the two buttons swapped; `onChange` mutating and sending the mounted object; `update()` calling `onChange`; `update()` writing on every call; `update()` keeping the caller's object (two variants); no `aria-pressed` at mount; `type="submit"`; no `role="group"`; the module binding T itself; a no-op `destroy()`.
- **Replay:** the plan's code blocks were extracted into a fresh copy of the E0 tree. They are byte-identical to the sandbox. Each Step 2 failed as written, each Step 4 passed (7, then 7), and a full `tsc --noEmit` of the copy was clean.
- **Harness:** browser check pending (run by the orchestrator for gate GE). The page type-checks.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- This package creates only the seven files below and edits nothing. It reads `ScenePrefs` from `client/types.ts` (WP-E0). `layout.css` and `client/app.ts` belong to E-A.
- Erasable TypeScript only. Relative imports end in `.ts`.
- Unit tests need no real DOM, no browser storage and no network. `scenePrefs.test.ts` imports only the pure module. `sceneToggles.test.ts` loads the `.css` import as an empty module and never imports `client/scene/viewer.ts`.
- No per-frame allocations: `update()` compares two booleans and writes only what changed.
- No shadows switch (D10).
- Code blocks preceded by `File: \`path\`` contain that file's complete content.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/ui/scenePrefs.ts` | new: `PREFS_KEY`, `DEFAULT_PREFS`, `readScenePrefs`, `writeScenePrefs` |
| `client/ui/scenePrefs.test.ts` | new: URL > stored > defaults, URL values other than 0/1, corrupt and partial JSON, write and read back, storage errors |
| `client/ui/sceneToggles.ts` | new: `SceneTogglesOpts`, `SceneTogglesHandle`, `mountSceneToggles` |
| `client/ui/sceneToggles.css` | new: the group's look |
| `client/ui/sceneToggles.test.ts` | new: the group and its buttons on a fake DOM: labels, titles, `aria-pressed`, controlled clicks, `update()`, no outside listeners, `destroy()` |
| `harness/scene-toggles.html`, `harness/scene-toggles.ts` | new: manual check page |

## Sources (checked 2026-09-22)

This package uses no Cesium API. `lib.dom.d.ts` is TypeScript 7.0.2's (`node_modules/@typescript/typescript-darwin-arm64/lib/lib.dom.d.ts`).

| Fact | Source |
|---|---|
| The group: two buttons, "3-D terrain" and "Sun", at the top of the right column, chase only, `aria-pressed`, keys T and L, URL > `localStorage['fh.scene.v1']` > defaults (both on). No shadows. | design brief D9–D11; research E12–E14 |
| `URLSearchParams.get` returns the first value of a repeated parameter, and `null` when it is absent. | https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams/get; `lib.dom.d.ts:37537` |
| Reading `window.localStorage` throws `SecurityError` when the page may not store data (for example blocked cookies, or a `file:`/`data:` origin). | https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage (Exceptions); `lib.dom.d.ts:41703` |
| `Storage.setItem` throws `QuotaExceededError` when the storage is full. | https://developer.mozilla.org/en-US/docs/Web/API/Storage/setItem (Exceptions); `lib.dom.d.ts:35958` |
| Node 25.2.1 without `--localstorage-file` has a global `localStorage` with no `setItem`: `localStorage.setItem('a', 'b')` → `TypeError: localStorage.setItem is not a function`. | measured in the sandbox |
| A toggle button carries `aria-pressed`; its label must not change with the state; Space and Enter activate a focused button. | https://www.w3.org/WAI/ARIA/apg/patterns/button/ |
| A `<button>` without `type` is a submit button, hence `type = 'button'`. | https://html.spec.whatwg.org/multipage/form-elements.html#attr-button-type; `lib.dom.d.ts:17357` |
| The app builds `.fh-right` and mounts the table, then the credits, into it. | `client/app.ts:231`, `:235-236` |
| `.fh-right` is a flex column with its items at the right edge and `pointer-events: none`. On phones the table hides while chasing. | `client/ui/layout.css:13-25`, `:94-96` |
| On phones the detail panel spans the top of the screen above the column. | `client/ui/detail.css:7` (`z-index: 11`), `:185-190` |
| Keys typed into the table's search box never reach `window`, so E-A's T and L do not fire there. | `client/ui/table.ts:423-425` (`ev.stopPropagation()`) |
| The only app keys today are Escape and `b`, on `window`. | `client/app.ts:418-422` |

---

### Task 1: Scene preferences

**Files:**
- Create: `client/ui/scenePrefs.ts`
- Test: `client/ui/scenePrefs.test.ts`

**Interfaces:**
- Consumes: `ScenePrefs` from `client/types.ts` (WP-E0): `{ topo: boolean; light: boolean }`
- Produces:
  - `PREFS_KEY: string` (= `'fh.scene.v1'`)
  - `DEFAULT_PREFS: ScenePrefs` (= `{ topo: true, light: true }`, frozen)
  - `readScenePrefs(search: string, stored: string | null): ScenePrefs` (a new object on every call)
  - `writeScenePrefs(prefs: ScenePrefs, storage: Pick<Storage, 'setItem'> | null): void` (never throws)

- [ ] **Step 1: Write the failing test**

File: `client/ui/scenePrefs.test.ts`
```ts
// client/ui/scenePrefs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ScenePrefs } from '../types.ts'
import { DEFAULT_PREFS, PREFS_KEY, readScenePrefs, writeScenePrefs } from './scenePrefs.ts'

const OFF_ON: ScenePrefs = { topo: false, light: true }

test('nothing stored, nothing in the URL → both on; the key is fh.scene.v1', () => {
  assert.equal(PREFS_KEY, 'fh.scene.v1')
  assert.deepEqual(DEFAULT_PREFS, { topo: true, light: true })
  assert.deepEqual(readScenePrefs('', null), { topo: true, light: true })
  assert.deepEqual(readScenePrefs('?hex=4691c4&bench=1', null), { topo: true, light: true })
  const a = readScenePrefs('', null)
  a.topo = false // the caller owns what it gets back
  assert.deepEqual(readScenePrefs('', null), { topo: true, light: true })
  assert.throws(() => (DEFAULT_PREFS.topo = false), TypeError) // shared: frozen
  assert.deepEqual(DEFAULT_PREFS, { topo: true, light: true })
})

test('the stored JSON wins over the defaults', () => {
  assert.deepEqual(readScenePrefs('', '{"topo":false,"light":true}'), OFF_ON)
  assert.deepEqual(readScenePrefs('', '{"topo":true,"light":false}'), { topo: true, light: false })
  assert.deepEqual(readScenePrefs('', '{"topo":false,"light":false}'), { topo: false, light: false })
})

test('?topo=0|1 and ?light=0|1 win over the stored JSON, with or without the leading ?', () => {
  const stored = '{"topo":false,"light":false}'
  assert.deepEqual(readScenePrefs('?topo=1', stored), { topo: true, light: false })
  assert.deepEqual(readScenePrefs('?light=1', stored), { topo: false, light: true })
  assert.deepEqual(readScenePrefs('topo=1&light=1', stored), { topo: true, light: true })
  assert.deepEqual(readScenePrefs('?hex=4691c4&topo=0', null), OFF_ON)
  assert.deepEqual(readScenePrefs('?light=0&airport=LOWI', '{"topo":true,"light":true}'), { topo: true, light: false })
  assert.deepEqual(readScenePrefs('?topo=0&topo=1', null), OFF_ON) // the first one counts, as URLSearchParams.get
})

test('URL values other than 0 and 1 are ignored: the stored value or the default stands', () => {
  for (const v of ['', 'false', 'true', 'off', 'no', ' 0', '00', 'TRUE']) {
    assert.deepEqual(readScenePrefs(`?topo=${v}&light=${v}`, '{"topo":false,"light":true}'), OFF_ON, `?topo=${v}`)
    assert.deepEqual(readScenePrefs(`?topo=${v}`, null), { topo: true, light: true }, `?topo=${v}`)
  }
  assert.deepEqual(readScenePrefs('?TOPO=0&Light=0', null), { topo: true, light: true }) // names are case-sensitive
})

test('corrupt or partial stored JSON falls back per field, never throws', () => {
  for (const bad of ['', 'not json', '{"topo":', 'null', '42', '"topo"', 'true', '[false,false]', '{}']) {
    assert.deepEqual(readScenePrefs('', bad), { topo: true, light: true }, bad)
  }
  assert.deepEqual(readScenePrefs('', '{"topo":false}'), OFF_ON)
  assert.deepEqual(readScenePrefs('', '{"light":false}'), { topo: true, light: false })
  // Only real booleans count: 0, "false" or null from an older or hand-edited value are not "off".
  assert.deepEqual(readScenePrefs('', '{"topo":0,"light":"false"}'), { topo: true, light: true })
  assert.deepEqual(readScenePrefs('', '{"topo":null,"light":false,"shadow":true}'), { topo: true, light: false })
  assert.deepEqual(readScenePrefs('?topo=0', 'not json'), OFF_ON) // the URL still applies over a corrupt value
})

test('writeScenePrefs stores the two fields as JSON under fh.scene.v1, and readScenePrefs reads them back', () => {
  const store = new Map<string, string>()
  const storage = { setItem: (k: string, v: string): void => void store.set(k, v) }
  writeScenePrefs({ ...OFF_ON, extra: 1 } as ScenePrefs, storage)
  assert.deepEqual([...store.keys()], [PREFS_KEY])
  assert.equal(store.get(PREFS_KEY), '{"topo":false,"light":true}')
  for (const topo of [false, true]) {
    for (const light of [false, true]) {
      writeScenePrefs({ topo, light }, storage)
      assert.deepEqual(readScenePrefs('', store.get(PREFS_KEY) ?? null), { topo, light })
    }
  }
})

test('writeScenePrefs never throws: no storage, private mode, a full quota', () => {
  assert.doesNotThrow(() => writeScenePrefs(OFF_ON, null))
  let calls = 0
  const failing = (name: string) => ({
    setItem: (): void => {
      calls++
      throw new DOMException('refused', name)
    },
  })
  assert.doesNotThrow(() => writeScenePrefs(OFF_ON, failing('QuotaExceededError')))
  assert.doesNotThrow(() => writeScenePrefs(OFF_ON, failing('SecurityError')))
  assert.equal(calls, 2) // it did try
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/ui/scenePrefs.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/ui/scenePrefs.ts' imported from …/client/ui/scenePrefs.test.ts`, then `ℹ tests 1`, `ℹ fail 1`.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui/scenePrefs'`
Expected: `client/ui/scenePrefs.test.ts(5,75): error TS2307: Cannot find module './scenePrefs.ts' or its corresponding type declarations.`

- [ ] **Step 3: Write the implementation**

File: `client/ui/scenePrefs.ts`
```ts
// client/ui/scenePrefs.ts
/**
 * The user's scene toggles (design D11): the URL (?topo=0|1, ?light=0|1) wins over localStorage['fh.scene.v1'], which
 * wins over the defaults (both on). Pure: the app passes location.search, the stored string and the storage, so Node
 * tests need no DOM. Reading localStorage itself can throw (storage blocked), so the app guards that read.
 */
import type { ScenePrefs } from '../types.ts'

export const PREFS_KEY = 'fh.scene.v1'
export const DEFAULT_PREFS: ScenePrefs = Object.freeze({ topo: true, light: true })

/** Only a real boolean counts; anything else (missing, 0, "false", null) keeps the fallback. */
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
/** ?k=0 → false, ?k=1 → true, any other value or none → the fallback. */
const flag = (v: string | null, fallback: boolean): boolean => (v === '0' ? false : v === '1' ? true : fallback)

/** URL > stored JSON > defaults, field by field. Corrupt or partial JSON falls back per field; never throws. */
export function readScenePrefs(search: string, stored: string | null): ScenePrefs {
  let saved: { topo?: unknown; light?: unknown } | null = null
  try {
    saved = stored === null ? null : JSON.parse(stored) // a number, string or array has no such fields: defaults
  } catch {
    // corrupt: the defaults stand
  }
  const q = new URLSearchParams(search)
  return {
    topo: flag(q.get('topo'), bool(saved?.topo, DEFAULT_PREFS.topo)),
    light: flag(q.get('light'), bool(saved?.light, DEFAULT_PREFS.light)),
  }
}

/** Stores the two fields as JSON. Storage errors (private mode, quota, blocked) are swallowed: the toggles still work. */
export function writeScenePrefs(prefs: ScenePrefs, storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify({ topo: prefs.topo, light: prefs.light }))
  } catch {
    // not persisted; the page keeps the prefs in memory
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/ui/scenePrefs.test.ts`
Expected: PASS — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui/scenePrefs'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 5: Commit**

```bash
git add client/ui/scenePrefs.ts client/ui/scenePrefs.test.ts
git commit -m "feat(ui): scene prefs from the URL, localStorage and defaults" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Toggle group

**Files:**
- Create: `client/ui/sceneToggles.ts`, `client/ui/sceneToggles.css`
- Test: `client/ui/sceneToggles.test.ts`

**Interfaces:**
- Consumes: `ScenePrefs` (WP-E0)
- Produces:
  - `interface SceneTogglesOpts { prefs: ScenePrefs; onChange(next: ScenePrefs): void }`
  - `interface SceneTogglesHandle { update(prefs: ScenePrefs): void; destroy(): void }`
  - `mountSceneToggles(root: HTMLElement, opts: SceneTogglesOpts): SceneTogglesHandle`
  - CSS classes `.fh-toggles` (the group) and `.fh-toggle` (each button; state in `[aria-pressed]`)

- [ ] **Step 1: Write the failing test**

File: `client/ui/sceneToggles.test.ts`
```ts
// client/ui/sceneToggles.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { ScenePrefs } from '../types.ts'

// sceneToggles.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { mountSceneToggles } = await import('./sceneToggles.ts')

// Node has no DOM: just enough of one for mountSceneToggles, plus recorders for listeners outside the group.
class El {
  tag: string
  children: El[] = []
  parent: El | null = null
  className = ''
  textContent = ''
  title = ''
  type = ''
  attrs: Record<string, string> = {}
  attrWrites = 0
  listeners = new Map<string, (() => void)[]>()
  constructor(tag: string) {
    this.tag = tag
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
    this.attrWrites++
    this.attrs[k] = v
  }
  addEventListener(type: string, f: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f])
  }
  click(): void {
    for (const f of this.listeners.get('click') ?? []) f()
  }
}
const outside: string[] = [] // listeners added to window or document: keys belong to the app
Object.assign(globalThis, {
  document: { createElement: (tag: string) => new El(tag), addEventListener: (t: string) => outside.push(`document:${t}`) },
  window: { addEventListener: (t: string) => outside.push(`window:${t}`) },
})

function mount(prefs: ScenePrefs) {
  const root = new El('div')
  const changes: ScenePrefs[] = []
  const t = mountSceneToggles(root as unknown as HTMLElement, { prefs, onChange: (next) => changes.push(next) })
  const group = root.children[0]
  const [topo, light] = group.children
  const pressed = (): [string, string] => [topo.attrs['aria-pressed'], light.attrs['aria-pressed']]
  return { root, group, topo, light, t, changes, pressed }
}

test('one group of two real buttons: "3-D terrain" and "Sun", titles naming the keys', () => {
  const { root, group, topo, light } = mount({ topo: true, light: true })
  assert.equal(root.children.length, 1)
  assert.equal(group.className, 'fh-toggles')
  assert.equal(group.attrs.role, 'group')
  assert.equal(group.attrs['aria-label'], 'Terrain and sun')
  assert.equal(group.children.length, 2)
  for (const b of [topo, light]) {
    assert.equal(b.tag, 'button')
    assert.equal(b.type, 'button') // never a form submit; Enter and Space work as on any button
    assert.equal(b.className, 'fh-toggle')
  }
  assert.deepEqual([topo.textContent, topo.title], ['3-D terrain', 'Topography — T'])
  assert.deepEqual([light.textContent, light.title], ['Sun', 'Sun lighting — L'])
})

test('aria-pressed shows the prefs it was mounted with', () => {
  assert.deepEqual(mount({ topo: true, light: true }).pressed(), ['true', 'true'])
  assert.deepEqual(mount({ topo: false, light: true }).pressed(), ['false', 'true'])
  assert.deepEqual(mount({ topo: true, light: false }).pressed(), ['true', 'false'])
  assert.deepEqual(mount({ topo: false, light: false }).pressed(), ['false', 'false'])
})

test('a click asks for the toggled copy and changes nothing itself: the app answers with update()', () => {
  const prefs = { topo: true, light: true }
  const { topo, light, changes, pressed } = mount(prefs)
  topo.click()
  assert.deepEqual(changes, [{ topo: false, light: true }])
  assert.notEqual(changes[0], prefs)
  assert.deepEqual(prefs, { topo: true, light: true }) // the caller's object is not touched
  assert.deepEqual(pressed(), ['true', 'true']) // not until update()
  light.click()
  assert.deepEqual(changes[1], { topo: true, light: false }) // still from the mounted prefs
})

test('update() only re-renders: no onChange, and the next click toggles from the new prefs', () => {
  const { topo, light, t, changes, pressed } = mount({ topo: true, light: true })
  t.update({ topo: false, light: true })
  assert.deepEqual(pressed(), ['false', 'true'])
  assert.equal(changes.length, 0)
  topo.click()
  assert.deepEqual(changes, [{ topo: true, light: true }])
  const p = { topo: false, light: false }
  t.update(p)
  assert.deepEqual(pressed(), ['false', 'false'])
  p.topo = true // a caller reusing its object later does not change what the group holds
  light.click()
  assert.deepEqual(changes[1], { topo: false, light: true })
})

test('update() with unchanged prefs writes nothing (cheap to call every frame)', () => {
  const { topo, light, t } = mount({ topo: true, light: false })
  const writes = (): number => topo.attrWrites + light.attrWrites
  const before = writes()
  for (let i = 0; i < 100; i++) t.update({ topo: true, light: false })
  assert.equal(writes(), before)
  t.update({ topo: true, light: true })
  assert.equal(writes(), before + 1) // only the button that changed
})

test('keys and storage belong to the app: no listeners outside the group', () => {
  outside.length = 0
  const { topo, t } = mount({ topo: true, light: true })
  topo.click()
  t.update({ topo: false, light: true })
  assert.deepEqual(outside, [])
})

test('destroy removes the group; twice is harmless', () => {
  const { root, t } = mount({ topo: true, light: true })
  t.destroy()
  assert.equal(root.children.length, 0)
  t.destroy()
  assert.equal(root.children.length, 0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/ui/sceneToggles.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/ui/sceneToggles.ts' imported from …/client/ui/sceneToggles.test.ts`, then `ℹ tests 1`, `ℹ fail 1`.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui/sceneToggles'`
Expected:
```
client/ui/sceneToggles.test.ts(11,44): error TS2307: Cannot find module './sceneToggles.ts' or its corresponding type declarations.
client/ui/sceneToggles.test.ts(59,83): error TS7006: Parameter 'next' implicitly has an 'any' type.
```

- [ ] **Step 3: Write the implementation**

File: `client/ui/sceneToggles.ts`
```ts
// client/ui/sceneToggles.ts
// The chase view's scene toggles (design D11): "3-D terrain" and "Sun", two real buttons with aria-pressed. A click asks
// the app for the toggled prefs through onChange and changes nothing itself; update() only re-renders. The app owns the
// keys (T, L), the stored prefs and where the group sits (layout.css shows it in chase only).
import type { ScenePrefs } from '../types.ts'
import './sceneToggles.css'

export interface SceneTogglesOpts {
  prefs: ScenePrefs
  onChange(next: ScenePrefs): void
}

export interface SceneTogglesHandle {
  update(prefs: ScenePrefs): void
  destroy(): void
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'fh-toggle'
  b.textContent = label
  b.title = title
  b.addEventListener('click', onClick)
  return b
}

export function mountSceneToggles(root: HTMLElement, opts: SceneTogglesOpts): SceneTogglesHandle {
  // What the buttons show, as two booleans: update() may run every frame and allocates nothing.
  let topo = opts.prefs.topo
  let light = opts.prefs.light
  const el = document.createElement('div')
  el.className = 'fh-toggles'
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', 'Terrain and sun')
  const topoBtn = button('3-D terrain', 'Topography — T', () => opts.onChange({ topo: !topo, light }))
  const lightBtn = button('Sun', 'Sun lighting — L', () => opts.onChange({ topo, light: !light }))
  topoBtn.setAttribute('aria-pressed', String(topo))
  lightBtn.setAttribute('aria-pressed', String(light))
  el.append(topoBtn, lightBtn)
  root.append(el)

  return {
    update(prefs) {
      if (prefs.topo !== topo) topoBtn.setAttribute('aria-pressed', String((topo = prefs.topo)))
      if (prefs.light !== light) lightBtn.setAttribute('aria-pressed', String((light = prefs.light)))
    },
    destroy() {
      el.remove()
    },
  }
}
```

File: `client/ui/sceneToggles.css`
```css
/* client/ui/sceneToggles.css */
/* The chase view's scene toggles: two small buttons in one dark translucent box, in the palette of the table and the
   detail panel (table.css, detail.css). The group places nothing itself: the app puts it at the top of the right-hand
   column and hides it in browse (layout.css). It takes the pointer, unlike the column around it. */
.fh-toggles {
  display: flex;
  flex: none;
  gap: 4px;
  width: max-content;
  padding: 3px;
  border-radius: 6px;
  background: rgba(10, 14, 20, 0.82);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
  font: 12px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  pointer-events: auto;
}

.fh-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: #9aa6b2;
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}

.fh-toggle:hover {
  background: rgba(255, 255, 255, 0.14);
}

.fh-toggle:focus-visible {
  outline: 2px solid #4aa3ff;
  outline-offset: 1px;
}

/* A lamp before the label: filled when on, a ring when off, so the state does not rest on colour alone. */
.fh-toggle::before {
  content: '';
  flex: none;
  width: 8px;
  height: 8px;
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.fh-toggle[aria-pressed='true'] {
  border-color: rgba(74, 163, 255, 0.7);
  background: rgba(33, 136, 255, 0.35);
  color: #fff;
}

.fh-toggle[aria-pressed='true']::before {
  background: currentColor;
}

/* Phones: taller buttons for a finger. The labels never wrap, so the width stays that of the two labels. */
@media (max-width: 640px) {
  .fh-toggle {
    min-height: 32px;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/ui/sceneToggles.test.ts`
Expected: PASS — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui/sceneToggles'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 5: Commit**

```bash
git add client/ui/sceneToggles.ts client/ui/sceneToggles.css client/ui/sceneToggles.test.ts
git commit -m "feat(ui): scene toggle group (3-D terrain, Sun) with aria-pressed" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Harness page

**Files:**
- Create: `harness/scene-toggles.html`, `harness/scene-toggles.ts`

**Interfaces:**
- Consumes: `PREFS_KEY`, `readScenePrefs`, `writeScenePrefs` (Task 1), `mountSceneToggles` (Task 2), `ScenePrefs` (WP-E0)
- Produces: `/harness/scene-toggles.html` (`?topo=0|1`, `?light=0|1`) and `window.harness = { toggles, apply, readScenePrefs, PREFS_KEY }` for the console

- [ ] **Step 1: Write the page**

File: `harness/scene-toggles.html`
```html
<!-- harness/scene-toggles.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: scene toggles</title>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
      /* Stand-ins for what the group sits on in chase: satellite imagery by day, snow, and the dimmed scene at night. */
      body[data-bg='satellite'] { background: repeating-linear-gradient(35deg, #3f5f2a 0 40px, #6b7d4a 40px 90px, #a88b5b 90px 120px, #2f4a24 120px 170px); }
      body[data-bg='snow'] { background: linear-gradient(160deg, #fff 0%, #e9eef3 40%, #cfd8e0 70%, #fff 100%); }
      body[data-bg='night'] { background: radial-gradient(circle at 30% 70%, #3a3320 0 4px, transparent 5px) 0 0 / 60px 60px, #0c1016; }
      /* Where the app's right-hand column starts (layout.css .fh-right: top 8px, right 8px, items at the right edge). */
      #dock { position: absolute; top: 8px; right: 8px; display: flex; flex-direction: column; align-items: flex-end; pointer-events: none; }
      #controls { position: absolute; left: 8px; bottom: 8px; z-index: 20; display: flex; flex-wrap: wrap; gap: 4px;
        max-width: calc(100% - 16px); font: 12px system-ui, sans-serif; }
      #controls button { font: inherit; padding: 3px 8px; }
      #stats { position: absolute; left: 8px; top: 8px; max-width: min(56ch, calc(100% - 210px)); padding: 6px 8px; border-radius: 4px;
        background: rgba(255, 255, 255, 0.9); color: #111; font: 11px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
    </style>
  </head>
  <body data-bg="satellite">
    <div id="dock"></div>
    <div id="stats"></div>
    <div id="controls"></div>
    <script type="module" src="./scene-toggles.ts"></script>
  </body>
</html>
```

File: `harness/scene-toggles.ts`
```ts
// harness/scene-toggles.ts
// WP-E4 harness: /harness/scene-toggles.html mounts the scene toggles where the app's right-hand column starts, over
// imagery-like backgrounds, and plays the app's part: onChange stores the prefs and answers with update(). T and L do
// the same as a click (a stand-in: the app's key handler and its filter are E-A's). The panel shows the URL, the stored
// value and what readScenePrefs makes of them, so a reload, ?topo=0 over a stored value and a blocked storage can be
// checked. "forget stored" removes this page's own fh.scene.v1 entry, to start again from the defaults.
import type { ScenePrefs } from '../client/types.ts'
import { PREFS_KEY, readScenePrefs, writeScenePrefs } from '../client/ui/scenePrefs.ts'
import { mountSceneToggles } from '../client/ui/sceneToggles.ts'

// Both the localStorage getter and its reads can throw when storage is blocked; the app guards them the same way.
let storage: Storage | null = null
try {
  storage = window.localStorage
} catch {
  storage = null
}
const stored = (): string | null => {
  try {
    return storage?.getItem(PREFS_KEY) ?? null
  } catch {
    return null
  }
}

const dock = document.getElementById('dock')!
const stats = document.getElementById('stats')!
const controls = document.getElementById('controls')!
const atLoad = stored()
let prefs: ScenePrefs = readScenePrefs(location.search, atLoad)
const log: string[] = []

const toggles = mountSceneToggles(dock, { prefs, onChange: (next) => apply(next, 'click') })

function apply(next: ScenePrefs, via: string): void {
  prefs = next
  writeScenePrefs(prefs, storage)
  toggles.update(prefs)
  log.unshift(`${new Date().toISOString().slice(11, 23)} ${via} → onChange ${JSON.stringify(next)}`)
  log.length = Math.min(log.length, 8)
  console.log('[scene-toggles]', via, next)
  report()
}

function report(): void {
  const shown = [...dock.querySelectorAll('button')].map((b) => `${b.textContent} ${b.getAttribute('aria-pressed')}`).join(', ')
  stats.textContent = [
    `URL: ${location.search || '(no query)'}`,
    `stored at load: ${atLoad ?? '(nothing)'}`,
    `readScenePrefs: ${JSON.stringify(readScenePrefs(location.search, atLoad))}`,
    `stored now: ${stored() ?? '(nothing)'}${storage === null ? ' (localStorage blocked)' : ''}`,
    `aria-pressed: ${shown}`,
    ...log,
  ].join('\n')
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
  const k = e.key.toLowerCase()
  if (k === 't') apply({ ...prefs, topo: !prefs.topo }, 'key T')
  else if (k === 'l') apply({ ...prefs, light: !prefs.light }, 'key L')
})

function button(label: string, onClick: () => void): void {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.addEventListener('click', onClick)
  controls.append(b)
}
for (const bg of ['satellite', 'snow', 'night']) button(`bg: ${bg}`, () => (document.body.dataset.bg = bg))
button('forget stored', () => {
  try {
    storage?.removeItem(PREFS_KEY)
  } catch {
    // blocked: nothing was stored
  }
  report()
})

report()
;(window as unknown as { harness: object }).harness = { toggles, apply, readScenePrefs, PREFS_KEY }
```

- [ ] **Step 2: Type-check the page**

Run: `npx tsc --noEmit 2>&1 | grep -E 'harness/scene-toggles'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Look at it**

Run `npx vite --port 5421 --strictPort` and open `http://localhost:5421/harness/scene-toggles.html`. Expected:
- At the top right, one dark box with "3-D terrain" and "Sun", both on: blue, with filled lamps. The panel reads `stored at load: (nothing)` (on a first visit, or after "forget stored") and `readScenePrefs: {"topo":true,"light":true}`.
- Click "Sun": a log line `… click → onChange {"topo":true,"light":false}`. "Sun" turns grey with a ring lamp, and the panel reads `stored now: {"topo":true,"light":false}` and `aria-pressed: 3-D terrain true, Sun false`.
- Reload: `stored at load: {"topo":true,"light":false}`, and "Sun" is still off.
- Open `?topo=0`: "3-D terrain" is off although the stored value says `"topo":true`, and `stored now` does not change until a click.
- Tab reaches "3-D terrain", then "Sun", with a blue focus ring. Space and Enter toggle the focused button (log `click`). T and L toggle from anywhere (log `key T`, `key L`). Cmd/Ctrl+L still reaches the browser.
- A mouse click shows no focus ring.
- `bg: snow` and `bg: night`: both labels and both states stay readable.
- At 375×812: the group stays on one line at the top right, each button is at least 32 px tall, and the page does not scroll sideways.
- "forget stored": `stored now: (nothing)`.
- The console has no errors.

Stop the server.

- [ ] **Step 4: Commit**

```bash
git add harness/scene-toggles.html harness/scene-toggles.ts
git commit -m "test(harness): scene toggles page with stored prefs and onChange log" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/ui/scenePrefs.test.ts client/ui/sceneToggles.test.ts`
Expected: `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui/scene(Prefs|Toggles)|harness/scene-toggles'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing, then `ℹ tests 625`, `ℹ fail 0` (611 on the E0 tree + 14). Two timing tests can fail under full-suite load and pass when run alone: "sortRows and filterRows stay cheap at 12,000 rows" (`client/ui/table.test.ts`) and "budget: /api/view of a 250 nm circle with 5,000 aircraft" (`server/main.browse.test.ts`). They are known flakes, not regressions. Any other failure must be fixed.

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

## Notes for later work

- **Deviations from the design brief:** none in the signatures (§5's E4 row and D11). Added: the named types `SceneTogglesOpts` and `SceneTogglesHandle`, and `DEFAULT_PREFS` is frozen. The group's label "Terrain and sun" is this plan's choice (D11 asks for a group role and a label). Research E's recipe had a third "Shadows" button and a `shadow` field: both are gone with D10.
- **For E-A:** see "Conventions consumers (E-A) rely on" above. The two points most likely to be missed are the guarded `localStorage` read and the phone layout, where the detail panel covers the top of the right-hand column.
- **ponytail:** the keys are named only in the buttons' titles. Upgrade: `aria-keyshortcuts="T"` and `"L"` on the buttons, once E-A binds the keys.
- **ponytail:** the first toggle after a `?topo=` or `?light=` link stores the URL's value too (see Conventions). Upgrade: `writeScenePrefs` of only the changed field, merged into the stored JSON.
