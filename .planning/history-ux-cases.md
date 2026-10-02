# History: use cases and edge cases (2026-10-02)

Drawn up from the user's report and a headless walkthrough of local main (screens in the session scratchpad,
`qa/ux/`). Each case: what a person does, what they must see. **Now** = what main does today.

User's report: icons turn into triangles in History (helicopters too, surely); going back in time the selected
aircraft "cannot be found" most of the time; its history is scattered; the timeline has coloured sections that look
like "data here" but are not; loading takes a while with no loader while moving through history; times with no data
(or before the oldest) must not be reachable.

## Goals people bring
- G1 What flew here at time X (browse an area in the past).
- G2 Where was this aircraft at X, what did it do today (follow one aircraft through time).
- G3 Watch an event unfold (play at speed).
- G4 Share a moment (link with `?hist=`).

## Entering and leaving
- C1 History with nothing selected: opens near the newest published moment, paused; data shows, or a loader until it does.
- C2 History with an aircraft selected: it stays selected and is shown where it was then (flying, on the ground, or its
  last known spot when not heard); the map brings it into view. **Now:** "No recent position" whenever the newest half
  hour does not hold it near the view (a parked aircraft between legs, a leg that started later, an aircraft elsewhere).
- C3 Live / the History button again / Esc: back to live, same view and selection.
- C4 Reload with `?hist=` (and `?hex=`): the same moment and aircraft.

## Moving through time
- C5 Drag the scrubber: the map follows; where data is not loaded yet, a loader shows (never a silently empty map).
- C6 Click on the timeline: jump there, loader until the aircraft are back. **Now:** empty map, no loader.
- C7 The future and the half hour not published yet: visibly unavailable and out of reach (scrubber, Go to, chips).
- C8 Older than adsb.lol keeps: not offered (date picker, scrubber on the oldest day, chips). **Now:** 30 days assumed.
- C9 Go to: chips and date/time stay inside what exists; an impossible time cannot be chosen. **Now:** the time input
  has no bounds; the popover promises "The last 30 days open in seconds."
- C10 Playing across midnight: the bar moves to the next day.
- C11 The day before / after without opening Go to.
- C12 Speeds 1× 10× 60×, Space plays/pauses.
- C13 Playing into the newest published moment: stops there; Live is the way on.

## Loading and gaps in the data
- C15 A jump to a time not loaded: a loader at the clock until its aircraft show; playing waits for the data (buffers)
  instead of running over an empty map.
- C16 Playing on: the next half hour is fetched early enough for the speed, so playback does not stall.
- C17 A half hour adsb.lol does not have: marked on the timeline, the bar says there is no data.
- C18 adsb.lol or the server failing: the bar says it could not load and retries; never an endless silent wait.
- C19 Colours on the timeline mean one thing a person can read. **Now:** bright half hours = files the server happens
  to hold in memory (an implementation detail that reads as "data here").

## The aircraft on the map
- C20 Every aircraft in History draws its real silhouette (jet, heavy, light, helicopter, ground), as live. **Now:**
  all triangles: the half-hour files carry no type.
- C21 Helicopters draw as helicopters.
- C22 An address no database knows (TIS-B `~` addresses, new airframes): the generic arrow, as live.
- C23 Altitude colours as live.
- C24 The aircraft list in History: types filled in; its header does not say "Connecting…".
- C25 The callsign shown is the one the aircraft sent at that time. **Now:** the card showed ISR044 (its trace's last
  callsign of the leg) while the map label and list said ISR595.

## One aircraft through time (selected)
- C26 Selecting in History: card with the callsign of the time, type and registration, stats, "Replay · HH:MM"; its
  flown path for the leg it is on.
- C27 Jump to a time it flew elsewhere: shown there, the map brings it into view.
- C28 Jump to a time it stood on the ground (transponder on): on the ground at the airport.
- C29 Jump to a time it was not heard (parked with the transponder off, out of coverage): at its last known spot,
  faded, "Last heard HH:MM"; the path is the leg that ended there.
- C30 Before its first point in the data: not on the map, the card says when it is first heard.
- C31 Its flights on the timeline, so a person sees when it flew and can jump to one.
- C32 Its flown path continuous where it was heard; dotted only where it was not heard.
- C33 Chase in 3-D in History: works with a position; without one it is not offered.

## Everything else in History
- C35 Weather (live radar, METARs, SIGMETs) does not belong over the past: off in History.
- C36 No Record button in the past (done).
- C37 A scenario or recording takes the screen from History (done).
- C38 Search finds the flights of the replay (done).
- C39 Phone: bar, card and sheets do not cover each other; the timeline works by touch.
- C40 The whole world zoomed out: every aircraft loads and the map stays smooth.
- C41 Panning to another area in History: its aircraft come quickly, with the loader if they do not.
- C42 The list badge counts the replay's aircraft.
- C43 Sun and night follow the replay time in the chase (done).
- C44 The card's link in History carries `?hist=` so the recipient sees the same moment.
