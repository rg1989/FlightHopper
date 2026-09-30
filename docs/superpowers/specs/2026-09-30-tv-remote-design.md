# FlightHopper on the TV: remote-control navigation (design)

2026-09-30. The user watches FlightHopper on the living-room TV (Xiaomi Mi TV, Android 9, weak GPU). The TV cannot
render Cesium, so `omarchy` (MacBookPro16,1, Radeon 5300M, Arch + Hyprland, LAN 10.0.0.12) renders the app in a Chromium
kiosk on a 1920×1080 headless Hyprland output. Sunshine streams that output to Moonlight on the TV. The Xiaomi remote
(D-pad, OK, Back, Menu) must drive the whole app.

## Key path (decided)

Xiaomi RC → Moonlight (patched: OK → Enter, Back → Escape; Menu is already the ContextMenu key; arrows are already arrow
keys) → Sunshine → uinput keyboard → Hyprland → Chromium → the page. **The page sees only ordinary `keydown` events:
ArrowUp/Down/Left/Right, Enter, Escape, ContextMenu.** Holding a key gives auto-repeat (`e.repeat`), made by Chromium.

Stock Moonlight drops OK (DPAD_CENTER has no keyboard mapping) and quits the stream on Back (KEYCODE_BACK falls through
to the Activity), because the remote is a keyboard-class device (sources 0x301), not a gamepad. Hence the patch.

## Scope: `?tv=1`

Everything below is on only with the URL parameter `tv=1` (the kiosk's URL). Desktop and phone behaviour stay exactly as
they are. The app's URL rewriting must keep `tv=1`.

## Behaviour

Two modes.

**UI mode** (a DOM control has focus):
- Arrows move focus spatially to the nearest visible, enabled, focusable control in that direction (the usual scoring:
  distance along the axis plus a penalty for the perpendicular offset; only candidates whose rect lies in that
  half-plane). The focused control scrolls into view (`block: 'nearest'`).
- Controls that own arrows keep them: range sliders (Left/Right change the value; Up/Down navigate), the search box
  (Up/Down pick among its results), and lists that already handle Up/Down (the aircraft table) keep Up/Down inside the
  list and Left/Right leave it. Every arrow leaves a plain text field (the on-screen keyboard types at the end: no caret).
- Enter clicks the focused control (native for buttons; make it so for everything clickable).
- Escape (Back) runs the app's existing Esc chain (panel → traffic card → edit mode → scenario/chase → focus) and then
  puts focus on a sensible control (the rail button of the panel that closed, else the first rail button).
- An arrow with no candidate in that direction enters **map mode** (e.g. Left from the rail with no panel open: "go
  left onto the map").
- The Settings dialog keeps its own key capture, but arrows/Enter/Escape must still navigate inside it.

**Map mode** (the map has the remote):
- A crosshair at the screen centre and a one-line hint at the bottom: `◀ ▲ ▼ ▶ move · OK zoom in / pick · hold OK zoom
  out · Back done`.
- Top-down map: arrows pan (one press ≈ 10 % of the view; held, a smooth continuous pan). OK: if an aircraft (or, in the
  chase, a traffic bracket) is under the crosshair, pick it exactly as a click there would; else zoom in (half the
  height). OK held ≥ 600 ms: zoom out (double). Every camera change goes through the app's normal paths (URL, polling,
  loading veil).
- Chase (3-D): Left/Right orbit round the aircraft, Up/Down tilt; OK / hold OK: closer / farther. Through the chase
  camera's existing orbit state (`?cam=`), not a second camera path.
- Back leaves map mode: focus returns to the control it came from (else the first rail button). Only a Back in UI mode
  runs the Esc chain.
- Menu (ContextMenu key) toggles between map mode and UI mode. The context menu itself never opens in TV mode.

**Start:** UI mode, focus on the first rail button, visibly.

## Look (TV mode only)

- A bold focus ring on every focusable control (accent outline + soft glow, readable from 3 m), `:focus-visible`.
- Icon-only buttons show their tooltip (`data-tip`) while focused, so the rail is readable without hover.
- No mouse cursor (`cursor: none` everywhere): the stream would otherwise show a stray pointer.
- The kiosk renders at 1920×1080 CSS px, device scale 1 (the stream is 1080p: the TV's Wi-Fi carries ~9 Mbit/s):
  check every layout there, compact, covering little of the 3-D view.

## Reachability audit

Every action a mouse can reach must be reachable by D-pad + OK: rail and corner buttons, every panel's controls and list
rows (aircraft table, search results, recordings, scenarios, layers, settings tabs and switches), the flight card and
traffic card buttons, the play bar. Aircraft on the map are reached through the aircraft list or map-mode pick.

## Typing: the on-screen keyboard (added)

OK on a text field (the search box, the aircraft list's filter, a rename, a Settings key) opens an on-screen keyboard
bound to it (`client/ui/osk.ts`): a glass panel at the bottom centre, in the top layer (a popover, so over a modal
dialog too), with an alphabetical 13-column grid: 0–9 and ⌫, a–m, n–z, Space / Clear / Done. The field keeps the DOM
focus throughout (the search box closes its list without it); the arrows move the keyboard's highlight, OK types it
(the value, then an `input` event, as typing), Back or Done closes it. The search box then picks with ↑/↓ and OK as
its own keys (OK opens the keyboard again while no result is highlighted); Back clears its text, then leaves it.

## Chase camera presets (added)

In the chase view only, a column of pills under the rail's Layers square (`client/ui/chasePresets.ts`): Behind (the
chase's own start), Left side, Right side, Front, Above, Wide, and Auto (a tour through them, 4 s glides, 15 s on
each). A pick glides the orbit there in 1.2 s (eased; the heading the short way round, the range in proportion)
through `chaseCam.orbit`, never a jump; a map-mode camera key, another preset or Auto again ends the tour. The view on
screen is marked. The flight-data frame keeps off the column (beside the rail it costs the frame least). Entering the
chase closes an open panel and puts the focus on the marked preset. The 3-D view draws at device pixels
(`useBrowserRecommendedResolution = false`).

## Code shape

- `client/ui/remote.ts`: the mode state, key routing (one `keydown` listener on `window`, capture phase; handled keys
  are `preventDefault` + `stopImmediatePropagation` so e.g. the scenario player's ←/→ do not also fire), the crosshair
  and hint. Pure, unit-tested helpers: `pickNext(from, candidates, dir)` and `remoteAction(key, mode, ctx)`.
- `client/ui/remote.css`: focus ring, crosshair, hint, cursor.
- Hooks into `client/app.ts` for the camera (pan/zoom/orbit/pick) and the Esc chain; small focusability fixes where
  controls are not focusable today.

## Verification

- `npm run check` (typecheck + tests) passes.
- Headless Chrome over CDP at 1280×720 with `?tv=1` on a replay server: a scripted key sequence (open the aircraft list,
  pick a flight, chase, orbit, Back ×n to the map, map-mode pan/zoom/pick, Settings) with screenshots at each step.
</content>
</invoke>
