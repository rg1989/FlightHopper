# History UX hardening: design (2026-10-02)

Cases: `.planning/history-ux-cases.md` (C1–C44). Built on History as merged (local main be3d3ad).

## Principles
- What looks like it works, works; what cannot work is not offered (out of reach, disabled), not explained in prose.
- Text only where a state needs a name, and then short: a status line, a tooltip.
- One meaning per colour on the timeline.

## D1 Aircraft types in the past (C20–C22, C24)
The half-hour files carry no type. The server keeps a hex → ICAO type table in memory (source and licence: see
"Facts"), downloaded at start-up (the command-line entry only; tests inject a table), refreshed daily, never written to
disk. `/api/history` waits for it up to a few seconds on the first ask, then answers with or without it.
`HistoryTrack.type: string | null`. The client's feed gives it as `AircraftInfo.typeCode`, so icons (`iconFor`), the
list's TYPE column and the traffic card get it like live. No emitter category exists in the past: `iconFor(null, type)`.

## D2 One aircraft through time (C2, C25–C33)
The server's trace endpoint gains a range mode: `GET /api/trace?hex&from&to` → `TraceDay { hex, reg, typeCode, legs }`,
every leg (TraceReply as now, plus `calls`: its callsign changes) overlapping [from, to], from the live file for the last
25 h and the UTC day files before that, merged (a leg crossing a file edge stays one leg). The `at` mode (one leg, live
mode's flown path) stays as it is.
The client asks for the bar's local day with 12 h before it (to know where the aircraft stood at the day's start). At
replay time t the selected aircraft is in one of five states (`client/history/aircraftDay.ts`, pure):
- heard: t inside a leg (its first point to a minute after its last): drawn from the leg (as now), card "Replay · HH:MM".
- gap: inside a leg, in a hole no receiver heard (a step its flown path draws dotted): drawn faded where it is estimated
  to be (along the great circle between the points either side, its altitude and speed between theirs), the card's
  numbers the estimate's, dimmed; card "Last heard HH:MM" (the point before the hole). Its path: that leg.
- quiet: after a leg ended, before the next one: drawn faded at the leg's last point; card "Last heard HH:MM" (its ALT
  says GND when that point was on the ground). Its path: that leg.
- before: earlier than its first leg in the range: not drawn; card "First heard HH:MM".
- none: no leg in the range: not drawn; card "Not heard this day".
A time on another day than the replay's carries its weekday: "Last heard Thu 22:58".
The callsign shown (card, label, list) for the selected aircraft is the leg's callsign at t (`calls`). Its legs show on
the timeline (D3), so where it flew is one glance and one click away.
After a jump in time (or entering History, or selecting), the map brings the selected aircraft into view when its
position at t (heard, in a hole or quiet) is not in view: the top-down camera flies over it at the same height. In view
means drawn inside the part of the screen that nothing covers (the aircraft card, the time bar, the rail and its open
panel, the search box, the map key), less a tenth of that part on each side; the camera puts the aircraft at the middle
of that part, not of the screen. While playing, an aircraft that was in view and leaves it (the edge, or under a card or
a panel) is followed (the view re-centres on it the same way, aimed where it will be as the flight lands: the replay goes
on meanwhile), except while the person moves the map (a pointer down, a wheel or trackpad gesture in the last 1.5 s).
The chase needs no such help.
Chase in 3-D is offered only while heard.

## D3 The timeline (C7, C8, C17, C19, C31)
- Gone: the half hours the server holds (bright) and loading (striped): an implementation detail that read as "data".
- Kept: missing at adsb.lol (red hatch), the part not published yet (hatched, out of reach).
- New: before the oldest moment adsb.lol has (hatched, out of reach), on the oldest day.
- New: the selected aircraft's legs as amber bars on the rail (the Replay colour); nothing selected, none.
- New: a loader at the clock while the time under it is loading (D4).
- New: ‹ › beside the date: the day before / after (disabled past the oldest day / at today).

## D4 Loading and buffering (C5, C6, C15, C16, C18, C41)
- Waiting = the half hour under the clock is not loaded for this view, not missing, not failed. While waiting the bar
  shows the loader and a playing clock stalls (buffers) instead of running over an empty map.
- A jump (click, Go to, a day arrow, a key) asks at once; a drag asks once it rests (as now, but 300 ms, not a tick).
- Playing prefetches the next half hour early enough for the speed: max(5 min, rate × 20 s) of replay time ahead.
- Failures: the bar's note says "Could not load this time · retrying" while the half hour under the clock fails (one
  fetched ahead of time says nothing of it), and the loader stops.

## D5 Limits (C7–C9, C13)
- Oldest: the server reports the oldest half hour adsb.lol has (`HistoryStatus.oldestSlotMs`), see "Facts" for how.
  The clock, scrubber, Go to (date min, time min on that day) and chips keep to it. Until a status says, 30 days are
  assumed; a `?hist=` time further back waits for the first status that reaches it, the address bar keeping it.
- Newest: as now (the newest published half hour's end); Go to's time max on today; the chips that fall outside are
  disabled. "The last 30 days open in seconds." goes.
- Playing into the newest moment stops there (as now).

## D6 Everything else (C24, C35, C42)
- The list's header in History: "Replay" with adsb.lol as the source (ODbL), Map refresh "—"; Coverage shows the
  loader while History loads.
- Weather layers hide in History; the Layers switch shows disabled ("Live only") until Live.

## Facts (measured 2026-10-02)
- Types: Mictronics aircraft database (`indexedDB_old.zip`, 4.3 MB, weekly, ODC-By 1.0: credit "Contains information
  from the Mictronics aircraft database, made available under the ODC Attribution License"): 452k addresses, types with
  their ICAO description (L2J, H1P…) and wake category; 94.9% of a real half hour's aircraft typed. tar1090-db (97.8%)
  mixes in ADS-B Exchange data with no licence: not used. OpenSky's database is research-only: not used.
- adsb.lol keeps 42 whole days (oldest 2026-08-21 today; 08-20 gone); no partial days at the edge. The newest half
  hour's file appears 2–8 s after it ends (p90 8 s); the half hour in progress is never there.
- A half hour downloads in 1–2 s here (15.6 MB at 13.6 MB/s) and decompresses in 0.06 s: the wait is not the download.
- Traces: legs start at the first row and at rows flagged 2; a row flagged 1 follows a gap (every gap ≥ 30 s). Cruise
  rows ~20 s apart, low ~2 s; gaps over 60 s are coverage holes (0.36% of pairs). A straight line across ≤ 60 s is good
  to 0.1 nm: the flown path's dotted rule (over 60 s and over 2 nm) stays.
