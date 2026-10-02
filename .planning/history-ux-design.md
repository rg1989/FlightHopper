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
replay time t the selected aircraft is in one of four states (`client/history/aircraftDay.ts`, pure):
- heard: t inside a leg (its first point to a minute after its last): drawn from the leg (as now), card "Replay · HH:MM".
- quiet: after a leg ended, before the next one: drawn faded at the leg's last point; card "Not heard since HH:MM", or
  "On the ground since HH:MM" when that point was on the ground. Its path: that leg.
- before: earlier than its first leg in the range: not drawn; card "Not heard until HH:MM".
- none: no leg in the range: not drawn; card "Not heard this day".
The callsign shown (card, label, list) for the selected aircraft is the leg's callsign at t (`calls`). Its legs show on
the timeline (D3), so where it flew is one glance and one click away.
After a jump in time (or entering History, or selecting), the map brings the selected aircraft into view when its
position at t (heard or quiet) is off screen: the top-down camera flies over it at the same height. While playing, an
aircraft that was on screen and reaches the edge is followed (the view re-centres on it), except while the person moves
the map (a pointer down, a wheel or trackpad gesture in the last 1.5 s). The chase needs no such help.
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
- Failures: the bar's note says "Could not load · retrying" (as now) and the loader stops.

## D5 Limits (C7–C9, C13)
- Oldest: the server reports the oldest half hour adsb.lol has (`HistoryStatus.oldestSlotMs`), see "Facts" for how.
  The clock, scrubber, Go to (date min, time min on that day) and chips keep to it.
- Newest: as now (the newest published half hour's end); Go to's time max on today; the chips that fall outside are
  disabled. "The last 30 days open in seconds." goes.
- Playing into the newest moment stops there (as now).

## D6 Everything else (C24, C35, C42)
- The list's header in History: "Replay" with adsb.lol as the source (ODbL), Map refresh "—"; Coverage shows the
  loader while History loads.
- Weather layers hide in History; the Layers switch shows disabled ("Live only") until Live.

## Facts
(filled from the research: type table source and licence, adsb.lol's oldest day, trace point spacing)
