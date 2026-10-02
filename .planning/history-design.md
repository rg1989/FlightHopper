# History: the flown path and time travel

Approved 2026-10-01/02 from the mocks in `.planning/reports/history-mock/` ("yes build the thing!"). Research:
`.planning/reports/historical-positions-research.md`.

## What the user gets

1. **The flown path of the selected aircraft.** Select an aircraft (live or in history) and its whole leg so far shows
   behind it on the top-down map: coloured by altitude with the icons' palette, dotted grey where no receiver heard it,
   and dotted from its origin airport when the route is known and the first position is far from it, with a
   "First heard HH:MM" label there. Only the selected aircraft.
2. **History mode.** A History button (rail on desktop, a tab on phones) turns the map into a replay of the past: every
   aircraft in view at the replay time, moving smoothly. A time bar at the bottom (the scenario play bar's look) has
   play/pause, the clock with the date ("REPLAY · TUE 22 SEP", amber), a scrubber over the local day with hour labels
   (bright = downloaded, striped = downloading, hatched = not published yet), the speed (1×, 10×, 60×), a calendar
   button with a "Go to" popover (1 h ago, 6 h ago, Yesterday, A week ago, a date and a time) and **Live** to return.
   Clicking an aircraft opens the usual card, its status reading "Replay · 17:43" with an amber dot; Chase in 3-D works
   in the past too. The address bar keeps the replay time (`?hist=<unix s>`), so a reload returns to it, paused.
3. **The rolling file.** While a live server runs it keeps the newest two half-hour files in memory (fetched at start,
   then each new one ~90 s after its half hour ends, the oldest dropped), so rewinding the last hour needs no wait.
   Older half hours are fetched when the replay needs them and dropped again (at most 4 in memory). Nothing is written
   to disk.

## Data (all keyless, adsb.lol, ODbL 1.0)

- Half-hour files: `https://adsb.lol/globe_history/YYYY/MM/DD/heatmap/NN.bin.ttf` (NN = half hour of the UTC day, 00–47):
  every aircraft the network heard, at most one position per aircraft per 10 s slice; lat, lon, baro alt (25 ft
  steps, ground, unknown), ground speed, and callsign/squawk records. 12–25 MB each (served gzip). ~30 days kept.
- Traces: `https://adsb.lol/data/traces/<xx>/trace_full_<hex>.json` (the last 24 h + 60 min, 1–4 s points with track,
  vertical rate, roll) and `https://adsb.lol/globe_history/YYYY/MM/DD/traces/<xx>/trace_full_<hex>.json` (one UTC day;
  some aircraft 404). `<xx>` = the hex's last two digits. Legs split at points whose flags have bit 2 ("new leg").

## Architecture

- **Server** fetches and caches; it never sends a whole file to the browser.
  - `shared/history.ts`: slot arithmetic both sides share (`SLOT_MS`, `slotOf`, `newestSlotMs`, `stepFor`).
  - `server/heatmap.ts`: reads a decompressed half-hour file into a `HistorySlot` for one circle (one pass, filters by
    circle and step).
  - `server/historyStore.ts`: fetch (deduped, 404 remembered 10 min), ≤ 4 files in memory (the newest 2 pinned),
    `tick()` for the rolling fetch, `status()`.
  - `server/trace.ts`: trace URL choice (live file when `at` is within 24 h, else the day file), leg cut, columnar
    `TraceReply` with geoid N per point; small cache.
  - `server/main.ts`: `GET /api/history?slot&lat&lon&nm`, `GET /api/history/status`, `GET /api/trace?hex&at`;
    `ChaseResponse.origin`; the rolling timer only for live sources.
- **Client** plays the past through the same pipeline as live: the Fleet, the TrackRegistry, the card and the chase.
  - `client/history/clock.ts`: the replay clock (play, pause, seek, rate, bounds).
  - `client/history/feed.ts`: holds the loaded slots and turns them into `Sample`s (track, vertical rate derived from
    the next point, so the Fleet's dead reckoning is an interpolation between 10 s points).
  - `client/history/bar.ts` (+ `client/ui/playbar.ts` options): the time bar and the Go to popover.
  - `client/scene/routeLine.ts`: the altitude-coloured path, gaps, lead-in and label.
  - `client/app.ts`: history mode. Live polls pause; each frame the feed's new samples go into a Fleet of its own;
    the render time is the replay clock; the selected aircraft's track and path come from its trace (else from the
    feed's samples).

## Limits (said in the UI where they show)

- Only what community receivers heard; gaps are drawn dotted.
- The current half hour is never in a file: the bar ends at the newest published one (hatched beyond); Live covers it.
- In history, aircraft have callsign and squawk but no type or registration until selected (the trace has them).
- adsb.lol keeps ~30 days of files; older times say "No data for this time" (GitHub archives: later, not built).
- The rolling fetch costs ~25 MB per 30 min while a live server runs.
