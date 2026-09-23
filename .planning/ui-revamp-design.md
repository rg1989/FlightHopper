# UI revamp (2026-09-23)

Goal: a map-first, uncluttered, premium-feeling UI. Every tool is collapsed behind a small square icon button; every wait
has a loader or an indicator. Requested by the user after the live/world-view work.

## Shell

- The globe fills the screen. One **rail** of 36 px square icon buttons (dark glass) sits on the right edge. Each opens
  one **panel** beside it; all start closed; one panel at a time; Esc closes it (and only then leaves chase).
- Rail, top to bottom:
  1. **Status**: a live dot (green live, amber replay, red trouble) with a spinner ring while the view is still filling.
     Panel: source (linked), mode, areas loading, imagery.
  2. **Aircraft**: list icon with a count badge (aircraft in view). Panel: the table.
  3. **Scene**: layers icon. Panel: switches for 3-D terrain (T), Sun (L), See-through buildings (X), each with its icon;
     a spinner on the terrain switch while the relief animates. The switches work in both modes (they apply in chase).
  4. **Altitude colours**: the legend.
  5. **Info**: the data and map sources, and the controls (touch gestures on touch screens). Cesium's own credits and
     "Powered by" logo are not shown anywhere (personal use; the user's call): its creditContainer is a detached element.
  6. **Fullscreen**.
- Removed: the credit box, the bottom legend, the HUD, Cesium's credit bar and fullscreen widget, the chase banner.

## Chase

- A compact **flight card**, top-left: callsign, airline · type, flag; live ALT, GS, VS, HDG (tabular numbers); a status
  line (Live · Predicting · Signal lost Ns ago · Locating aircraft…) with a coloured dot. Buttons: expand (photo and all
  detail sections, the old panel's content), copy link, close. Collapsed by default.
- A **toast** (top centre) only for provider trouble (rate-limited, blocked, down).

## Aircraft list

- Refreshes every **10 s** (was 1 s), so rows do not move under the cursor. A ring around the refresh button counts down to
  the next refresh; a click refreshes now. While refreshing (~400 ms) the list dims, shows a progress bar and ignores
  clicks. Sort and search apply at once to the current snapshot. Skeleton rows until the first data; an empty state with
  an icon.

## Loaders

- A **splash** while the globe boots ("Loading the globe…", then "Connecting to live traffic…"), fading out on the first
  data; an error state if the app cannot start.
- Spinners: status icon (view filling), terrain switch (relief animating), flight card (locating), photo skeleton.

## Look

- Tokens in `client/ui/theme.css`: glass `rgba(14,18,26,.78)` + 16 px blur, 1 px hairline border, 12 px radius, one blue
  accent for active state, green/amber/red for state; system UI font, tabular numbers; inline 1.75 px line icons
  (`client/ui/icons.ts`); 150 ms transitions, none under `prefers-reduced-motion`.
- Phones (< 640 px): panels become bottom sheets; the flight card spans the width left of the rail.
