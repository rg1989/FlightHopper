## 1. Rail buttons and panels

**How they are declared.** `mountRail(root, items, onOpen?)` returns a `RailHandle` (client/ui/rail.ts:42). Each item is a `RailItem` (rail.ts:10-19):
```ts
{ id: string; icon: IconName; label: string /*tooltip+aria*/; short: string /*phone tab label*/; group?: number;
  panel?: { title: string; wide?: boolean; mount(body: HTMLElement, head: HTMLElement): void }; action?(): void }
```
- `RailHandle` (rail.ts:21-30) offers `openId`, `open(id|null)`, `close(): boolean`, `button(id)`, `setBadge`, `setBusy`, `setDot('live'|'replay'|'trouble'|'wait'|null)` and `destroy()`.
- A change of `group` adds a thin divider between buttons (rail.ts:66-70).
- Each panel's `mount` runs once, synchronously, inside `mountRail` (rail.ts:81-90). Its `head` argument is a per-panel slot in the panel header for extra controls.
- Because of that, app.ts declares the handles with `let x!: Handle` and assigns them inside the mount closures (client/app.ts:342-357).
- The current item list is at app.ts:347-359:
  - group 0: `status`
  - group 1: `aircraft` (wide), `scene`, `legend`
  - group 2: `info` and `fullscreen`. `fullscreen` is an `action`, not a panel, and appears only when `document.fullscreenEnabled` is true.
- `onOpen` refreshes the table when the list opens (app.ts:360-362).
- A Scenarios entry would be one more `RailItem` with a `panel`, for example in group 2 before `info`.

**One panel at a time.**
- A button click toggles its own panel: `open(openId === id ? null : id)` (rail.ts:78).
- `open()` hides the previous body and header extras, sets `aria-expanded`, the title, the header icon, `.fh-wide` and `panel.dataset.id`, then calls `onOpen` (rail.ts:124-148). The X button calls `open(null)` (rail.ts:92).
- Esc goes through a ladder: first `rail.close()`, then `setChase(false)`, then `select(null)` (app.ts:771-777).
- Scenario mode must change this ladder. Leaving chase is not allowed in a scenario, so Esc should close the panel and then exit the scenario.
- The flight card's Map pill calls `onChase(false)` (flightCard.ts:121). It must be hidden or re-routed in scenario mode.

**Phones.** `SHEET_MEDIA = '(max-width: 640px)'` (rail.ts:33).
- **Tab bar.** The rail becomes a full-width bottom bar, `height: var(--fh-tabbar-h)` with the safe-area inset (rail.css:220-233). Each tab is `flex:1`, 52 px tall, with its `short` label under the icon (rail.css:239-260). The tab-bar height is `calc(61px + env(safe-area-inset-bottom))` (theme.css:39-42).
- **Sheets.** A panel becomes a sheet at `bottom: var(--fh-tabbar-h)`, opaque `#0d1119`, with an 18 px top radius and a grab handle (rail.css:290-323).
- **Swipe to close.** A drag down on the header of more than 70 px closes the sheet. Clicks on buttons and inputs in the header are ignored (rail.ts:95-118).
- **Touch screens.** On coarse pointers, rail buttons are 44 px and the panel moves to 72 px from the right (rail.css:184-193). Phones on their side get 38 px buttons (rail.css:196-204). Tooltips are off where there is no hover (rail.css:207-211).
- **Card vs panel.** At ≤860 px the flight card is hidden while any panel is open (flightCard.css:450-454). A pick from the list closes the rail at that width (app.ts:499).
- **Tab count.** iPhone has no Fullscreen tab, so Scenarios makes 6 tabs there and 7 elsewhere. At 375 px, 7 tabs are about 52 px each, which is still over 44 px.

## 2. Tokens, icons, loaders

**Tokens** are on `:root` (theme.css:4-30):
- **Colours:**

  | Token | Value |
  |---|---|
  | `--fh-glass` | `rgba(13,17,25,.88)` |
  | `--fh-glass-strong` | `.92` |
  | `--fh-hairline` | `rgba(255,255,255,.09)` |
  | `--fh-hover` | `.07` |
  | `--fh-press` | `.12` |
  | `--fh-text` | `#e9eef4` |
  | `--fh-muted` | `#8e9aab` |
  | `--fh-faint` | `#7d889a` |
  | `--fh-accent` | `#5aa9ff` |
  | `--fh-accent-soft` | `.16` |
  | `--fh-ok` / `--fh-warn` / `--fh-err` | `#3ccf6e` / `#f2b53a` / `#ff5d5d` |

- **Radii:** `--fh-radius` 12 px and `--fh-radius-sm` 8 px. Buttons are 10 px, small buttons 8 px (theme.css:83, 112-116), pills 9 px (flightCard.css:350), phone sheets 18 px.
- **Font:** a system stack (`--fh-font`). `.fh-ui` is 13px/1.4, and 14 px at ≤640 px (theme.css:32-47).
- **Motion:** `--fh-ease` and `--fh-fast: 150ms`. Under `prefers-reduced-motion`, all animation and transitions are cut to near zero (theme.css:330-343).
- **Spacing:** there are no spacing tokens. The gutters are `--fh-top` / `--fh-left` (12 px plus safe-area), `--fh-right` and `--fh-insets-v` (theme.css:26-29). Paddings are 10-14 px, set per component.

**Surfaces and controls:**
- `.fh-glass` is a nearly opaque surface without blur. `.fh-blur` adds a 16 px backdrop blur and is for small surfaces only; the reason is the GPU cost (theme.css:54-67).
- Controls:

  | Class | Where | Notes |
  |---|---|---|
  | `.fh-ibtn` | theme.css:74-121 | 36 px; `.fh-sm` is 28 px, 44 px on coarse pointers (theme.css:296-300); `aria-expanded` / `aria-pressed` switch to the accent |
  | `.fh-pill`, `.fh-pill-secondary` | flightCard.css:342-375 | 44 px on touch (flightCard.css:427-440) |
  | `.fh-switch` | theme.css:237-269 | |
  | `.fh-field` | theme.css:272-286 | |
  | `.fh-kbd` | sceneToggles.css:74-85 | hidden on coarse pointers (sceneToggles.css:88-92) |
  | `.fh-badge` | theme.css:124-143 | |
  | `.fh-num` | theme.css:69-71 | tabular figures |

**Icons** (client/ui/icons.ts):
- A single path `d` string on a 24-unit grid, stroke 1.75, round caps and joins, `currentColor`, `aria-hidden` (icons.ts:2-3, 46-62).
- Add a key to `P` (icons.ts:5-39); `icon(name, size = 18)` builds it.
- Catch: `P` is typed `Record<string,string>`, so `IconName = keyof typeof P` is just `string` (icons.ts:43). A misspelt icon name compiles and renders `d="undefined"`.
- The existing names include `x`, `check`, `chevronDown`, `plane` and `map`. There is no play, pause, clock, film or captions icon yet.

**Loaders:**
- `.fh-spin` and `.fh-spin.fh-lg` (theme.css:180-199)
- `.fh-skel` shimmer (theme.css:202-212)
- `.fh-progress` indeterminate bar (theme.css:215-234)
- state dots `.fh-dot[data-state]` (theme.css:146-177)
- the rail busy sweep, `setBusy` → `.fh-busy::before` (rail.css:37-60)
- the splash, `mountSplash(): {set, done, fail}` (splash.ts:8-50), at z 100 (splash.css:4)

## 3. Where a playback bar and captions can go

**Layers today:**

| Z-index | Element | Where |
|---|---|---|
| 5 | `.fh-traffic` brackets | layout.css:27-33 |
| 10 | `.fh-ui` overlay root (`pointer-events: none`; this also makes it the stacking context for everything below) | layout.css:7-13 |
| 18 | `.fh-card` | flightCard.css:5 |
| 19 | `.fh-panel` | rail.css:86 |
| 20 | `.fh-rail` | rail.css:5 |
| 21 | `.fh-toast` | ui.css:6 |
| 10 (fixed) | bench overlay | bench/overlay.ts:128 |
| 100 | splash | splash.css:4 |

- Children of `.fh-ui` must set `pointer-events: auto` to receive input (rail.css:13, flightCard.css:13).
- **Imagery badge.** It is not an on-map overlay. It is the "Imagery" row of the Status panel: `statusPanel.setImagery` (sourceBadge.ts:88, 119-122; app.ts:363-364, 394-395). It cannot collide with anything.

**Desktop:**
- What is there:
  - The card is top-left, 320 px wide (336 px on coarse pointers) (flightCard.css:3-15, 442-446).
  - The rail is top-right. The panel sits 64 px from the right edge (72 px on coarse pointers), and its `max-height` is `100% - 24px - insets`, so a tall panel can reach the bottom (rail.css:84-96).
  - The only thing at the bottom is the toast, at bottom centre (ui.css:4-19). It shows only on provider trouble, which a scenario with no live polling should not show at all.
- **Playback bar, z 17** (below the card and panel):
  - `left: var(--fh-left); right: calc(64px + var(--fh-right)); bottom: calc(12px + env(safe-area-inset-bottom))`
  - 72 px instead of 64 px under `(pointer: coarse)`.
  - Add a token such as `--fh-player-h`. In scenario mode, subtract it from `.fh-panel` and `.fh-card` `max-height` so neither covers the bar.
- **Captions, z 16:**
  - `pointer-events: none`, centred above the bar at `bottom: calc(var(--fh-player-h) + 24px)`, `max-width: min(640px, …)`.
  - `role="log"` or `aria-live="polite"`.
  - The centre column between the 344 px card edge and the rail is about 690 px wide at 1100 px.

**Phones:**
- The bottom is already crowded. From the bottom up: the tab bar, then the card at `bottom: calc(var(--fh-tabbar-h) + 8px)` (flightCard.css:383-392), and sheets start from the same line. The toast moves to the top (ui.css:29-37).
- **Recommendation:**
  - Put the bar directly on the tab bar: `bottom: var(--fh-tabbar-h)`.
  - In scenario mode, raise the card by `var(--fh-player-h)`, or hide the live card. It is built for live `StatusBrief`/`raw`/`info` (flightCard.ts:126-129) and would need a scenario data path anyway.
  - Captions go above the bar.
  - Opaque sheets (z 19) will cover the bar and captions while open. That matches how the card waits (flightCard.css:450-454).

**Selectors:**
- `ui.dataset.mode` is `'browse' | 'chase'` (app.ts:340, 523), and CSS keys chase rules off it (flightCard.css:458).
- Keep `data-mode='chase'` so the chase rules still apply, and add a separate `data-scenario` attribute for the scenario overrides.

**URL:**
- `syncUrl` rewrites `?hex/?chase/?cam/?at` every second (app.ts:451-463).
- `writeUrl` keeps any parameter it does not own (urlState.ts:52-62), so `?scenario=` / `?t=` would survive a rewrite.
- `syncUrl` would have to skip the live `hex` while a scenario plays.
- Keys: `sceneKey` filters out modifiers, auto-repeat and typing in fields (app.ts:180-193). A Space play/pause key should reuse that same filter.

## 4. Tests and harness pages

- **Runner.** `npm test` = `node --test "shared/**/*.test.ts" "server/**/*.test.ts" "client/**/*.test.ts" "tools/**/*.test.ts"` on Node ≥24.2, which strips TypeScript types itself (package.json scripts and engines).
- **No DOM library.** There is no jsdom or happy-dom in devDependencies. Each UI test hand-rolls a fake DOM.
- **The pattern** (client/ui/sceneToggles.test.ts):
  1. `registerHooks({ load })` turns every `.css` import into an empty module, then the module under test is imported dynamically (lines 7-11).
  2. A minimal `class El` provides `children`, `className`, `textContent`, `hidden`, `type`, `attrs`, `setAttribute`, `append`, `remove`, `addEventListener` and `click()`. It goes onto `globalThis.document` (`createElement`, `createElementNS`) and `globalThis.window` (lines 14-60).
  3. The test mounts into `new El('div') as unknown as HTMLElement`, walks the tree with `all()`, and asserts on `attrs`, `className` and the `onChange` calls it records (lines 62-110).
- **Pure/DOM split.** Modules keep a pure part that needs no DOM in tests:
  - `cardView` vs `mountFlightCard` (flightCard.ts:6, 63, 153)
  - `readScenePrefs` / `writeScenePrefs` ("so Node tests need no DOM", scenePrefs.ts:4-5)
  - `readView` / `writeUrl` (urlState.ts:7)
  - `badgeView` (imageryBadge.ts:8)

  A scenario clock, a caption picker for time t, and marker positions should follow the same split.
- **No rail test.** There is no `rail.test.ts`. `mountRail` uses `dataset`, `classList.toggle`, `replaceChildren`, `matchMedia`, `setPointerCapture` and `style`, so the fake `El` would need to grow to test it.
- **Harness pages.**
  - `harness/*.html` + `*.ts` are served by Vite at `/harness/<name>.html`.
  - `harness/scene-toggles.html` mounts the real module into `#dock` over stand-in satellite, snow and night backgrounds, with a stats and controls panel (harness/scene-toggles.html:10-27; harness/scene-toggles.ts:1-6, 26-33). `harness/table.html` is similar.
  - The revamp was checked in the Browser pane at 1100×710, 800×710, 740×360 (touch) and 375×812 (HANDOFF.md:27).

## 5. The user's stated UI rules

- **Look:** map-first, uncluttered, premium-feeling. Every tool is collapsed behind a small square icon button, and every wait has a loader or an indicator (.planning/ui-revamp-design.md:3-4).
- **Panels:** all start closed, one at a time, and Esc closes before it leaves chase (ui-revamp-design.md:8-9; HANDOFF.md:22).
- **No disclaimers or credit boxes:**
  - no credit bar, no "Powered by", no "Not for navigation" line (HANDOFF.md:22)
  - a review finding that would restore the disclaimer and Cesium's credits was declined (HANDOFF.md:27)
  - Cesium credits go to a detached element (scene/viewer.ts:21, 43; ui-revamp-design.md:18-20)
  - sources are listed only under About, through `attributionFor()` (app.ts:208-228)

  Transcript and dossier sources belong in that About list, not on the map.
- **Collapsed by default:** the flight card starts collapsed (ui-revamp-design.md:26).
- **Tokens and motion:** glass, 1 px hairline, 12 px radius, one blue accent, system font, tabular numbers, 1.75 px line icons, 150 ms transitions, no motion under reduced-motion (ui-revamp-design.md:42-46).
- **No blur on big surfaces:** large panels get no backdrop blur for performance (theme.css:54-55). A full-width playback bar counts as large, so use `.fh-glass` without `.fh-blur`.
- **Touch:** 44 px targets (Apple HIG) and 16 px text in fields (theme.css:293-294). On phones, panels become sheets (ui-revamp-design.md:47).
- **Text only:** upstream strings go in with `textContent` only, never as HTML (flightCard.ts:151). Transcript lines should follow the same rule.
- **From memory** (<session cache> "User UI preferences"):
  - no disclaimers or credit boxes or logos
  - each tool behind an icon whose meaning is clear
  - a premium look with loaders
  - touch-first, with less important info collapsed
  - review critically as a user in the browser, including a phone viewport
- **A tension to raise with the user.** The closing memorial card is content, not a disclaimer. It fits these rules if it is sober and can be dismissed, and is not a legal-notice box.