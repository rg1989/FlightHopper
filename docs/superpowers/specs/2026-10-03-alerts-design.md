# Alerts: emergencies and steep descents, worldwide

The user asked for a toggle that catches interesting events anywhere on Earth (an emergency, a fast and unexpected loss
of altitude), alerts them, and can follow the aircraft automatically, so that no event is missed. The research, with
sources, is in `docs/anomaly-alerts.md`. The user was away, so the design decisions below were made without asking them
(their standing instruction). Each decision gives the alternative that was not taken.

## What it does

- **One switch, on the server.** The Events panel (a bell on the rail) holds the switch "Watch the world". When it is on, the
  server watches by itself, with or without a browser open. The state is kept in `EVENTS_DIR/state.json`, so it survives a
  restart. `make live` sets `EVENTS_DIR=data/events`. Without `EVENTS_DIR`, or with a replay source, there are no alerts.
  A page on another site cannot use the switch: the server refuses every POST whose `Sec-Fetch-Site` header is there and is
  not `same-origin` or `none` (403). Such a page could otherwise switch the watch or delete a recording on `127.0.0.1:8787`.
  The app's own POSTs are same-origin (also through the Vite dev proxy, which forwards the header), and curl sends no header.
- **Emergencies anywhere, within a minute at the full rate.** The poller asks adsb.fi for every aircraft on 7700, 7600
  and 7500, worldwide: `/api/v2/sqk/{code}`, one code every 10 s, so each code every 30 s. That is 0.1 req/s of the 0.9
  the app has (11 %), and nothing when the switch is off. The sweep keeps to an eighth of the request budget, so the map
  keeps seven tokens in eight: below 0.8 req/s the gap between sweep requests grows (8 ÷ rate seconds) and each code is
  asked less often than every 30 s. After one 429 has halved the rate to 0.45 req/s, each code is asked every 53 s. The
  answers go into the stores like any other answer, so these aircraft are on the map and can be chased.
- **ADS-B emergency status** (general, minfuel, nordo, unlawful, downed) is read from every answer the server gets: the
  view, the chase, recorded flights and the sweep. No endpoint filters on it, so outside these it is not seen.
- **Steep descents.** Two rules on the barometric altitude (`server/descent.ts`):
  - *Descent (D1):* from FL200 or above, 15,000 ft or more lost within 120 s, over 4 or more points. The fall is followed to
    its bottom, also past a repeated or slightly higher sample, until 60 s pass with no new low.
  - *Dive (D2):* the fall into the last point heard: its top is within the last 60 s, at FL150 or above, and the fall is
    3,000 ft or more, at 5,000 fpm or more on average, over 3 or more points. Then no position for 60 s or more. FZ1073 fits:
    in adsb.lol's 05:00 file its last points are 33,950 ft at 05:21:10 and 27,950 ft at 05:22:10, and nothing follows to the
    file's last slice at 05:29:50.
  - The points are cleaned first: none above 50,000 ft, and no outlier: a point whose steps to both neighbours go opposite
    ways and that is over 1,000 ft off the line between them (a GNSS altitude among baro ones), or whose steps are both over
    30,000 fpm (a spike). A point is judged only when both its steps are 60 s or less, so a point across a coverage hole
    stays, and it goes only where it is at least as far off as the points next to it, so the good point beside a spike stays.
  - Tuned on 8 real half hours (2026-10-03, `docs/anomaly-alerts.md` §3.2): D1 first took 10,000 ft and gave 21 events, mostly
    military and fighter aircraft, and the first D2 missed FZ1073.
  - Live, D1 runs on the samples of every aircraft the server takes: the view, the chase, recorded flights, and the sweep's
    answers. It runs only on a sample whose `baro_rate` is −3,000 fpm or lower, so most samples cost nothing.
  - Worldwide, D1 and D2 run on each new adsb.lol half-hour file that the server already downloads for History. This
    costs no request. The result comes 1 to 31 minutes after the event and is marked *late*.
  - A fall across the boundary of two half hours is found too. The server reads the half hours in time order, and when one
    follows the one read before it, each aircraft's points in the last 150 s of that one (if it was at FL150 or above there)
    go before its points in this one. An aircraft heard at the end of a half hour and not in the next was lost at the
    boundary: its end is judged alone, so D2 (and D1) can fire. A fall that both half hours hold stays one event, pushed once.
    Nothing is carried across a gap in the reads (the server down over a half hour), so a fall at that boundary is still lost.
- **The late check also reads emergency squawks.** An aircraft with two or more 7500, 7600 or 7700 ident records in a
  half-hour file is an event. This catches codes that adsb.fi did not hear.
- **False alarms.** These rules are from section 4 of the research:
  - Confirmation: a squawk or status counts only when it is seen again 25 s or more after it was first seen. One-off
    glitches are common (OpenSky counted over 8,000 brief 7500s in 4 months). The times are those of the messages (the
    answer's receipt minus `seen`), not of the answers: readsb serves a squawk for 60 s after its last message, so two sweeps
    30 s apart can hold one message. A first sighting waits 10 min for its second, then it is forgotten. That is two rounds
    of the sweep (a failed answer skips its code for one round) down to 0.08 req/s; after three 429s (0.1125 req/s) each
    code is asked every 213 s.
  - Ignored: aircraft on the ground, surface vehicles (C1 to C3), addresses that are not ICAO, `000000`, `000001`,
    `lifeguard` (a medical flight's priority, not an emergency) and `reserved`.
  - No descent or dive events for military aircraft (live: `dbFlags & 1` or the type table's flag from the Mictronics
    database; late: the type table's flag), or for fighter and trainer types (a list of ICAO type designators in
    `server/alerts.ts`: F-5, T-38, Texan II, L-39, Su-27 and others), which dive as routine. Their squawks and statuses still
    count: the real files held a KC-135 and a C-130 on 7700.
  - No live descent events for light aircraft and gliders (A1, B1 to B7), which covers jump planes.
  - *Quiet* events are logged but raise no alert: 7600 and the nordo and minfuel statuses on a light aircraft (79 % of
    7600s are small private aircraft on approach). Late, the type table's category decides, which also quiets a late 7600 of
    a turboprop airliner: radio failures are the least urgent cause. A worse cause that is older than the event's newest
    sighting (a late 7700 from before a quiet 7600) still makes the event loud, and it is pushed once.
- **One event per aircraft per episode.** A new cause on an open event updates it and does not open a new one: for
  example 7700, then unlawful, then 7500. An event stays open until 30 min pass with no sighting of any cause. A late
  finding for an aircraft that already has an event within 30 min is merged into that event. A late event whose aircraft is
  seen live again is no longer late.
- **The log.** `EVENTS_DIR/YYYY-MM-DD.jsonl` (UTC day of the write) holds one JSON line per open or change, and the
  newest line of an id wins. A position-only update is written at most every 5 min. At start the server reads the last
  8 days. Older files are kept as an archive (tens of KB a day); delete them to clear them. After a write that failed, the
  next line starts on a new line, so a line cut short cannot join it. `data/events/` is git-ignored.
- **Phone push.** When `NTFY_URL` is set (for example `https://ntfy.sh/<random topic>`), each new alerting event, and
  each new cause on one, is a POST there. ntfy.sh needs no account. The topic is the password.
- **In the app** (Events panel, `client/ui/alerts.ts`):
  - **The list.** It shows the last 7 days, newest first. Each row shows the callsign, type, what happened, when, and
    whether it is ongoing or late.
  - **Opening an event.** A click on an ongoing, live event follows the aircraft. A click on any other event opens
    History at the event, with the aircraft selected. History replays any aircraft that adsb.lol heard, for 42 days.
    History has an event only once its half hour is published, 20 s after the half hour ends. Until then the row follows
    the aircraft if it was seen within the hour, and it says "Replay at hh:mm". A small button beside a row does the other
    action: Replay beside a followed row, Live beside a replayed one (only within the hour).
  - **New events.** After the page has loaded, each new alerting event shows a toast (Follow or Replay, ×). With that
    option on, it also shows a notification, but only while the page is hidden or not focused (a visible, focused page has
    the toast); the permission is asked for in the switch's click. While the panel is closed, the rail's bell shows the
    number of events since the panel was last opened.
  - **How the events come in.** The panel asks for them when a poll's status says they changed, and when it opens. Where
    the app polls nothing live (History, a scenario, a hidden tab with notifications on), the panel asks every 30 s
    itself, so toasts show there too. A browser that freezes or discards a background tab runs no timer there, so no
    notification comes; ntfy is the path then.
  - **Follow automatically** (an option kept in the browser) selects the new event's aircraft and flies the map to it. It
    does this only for a live event, not a late one, and not in History or a scenario. It never takes the screen from the
    person: not during a chase, not within 60 s of the map being moved, not within 2 min of an aircraft picked by hand, and
    not while another tool's sheet is open on a phone. The toast shows all the same.

## Decisions taken for the user

1. **The switch lives on the server.** The alternative was a browser setting, but then nothing would be watched while
   no page was open, so events would be missed.
2. **Past events replay in History, and the event aircraft are not recorded.** History already replays any aircraft from
   adsb.lol's files. Recording would cost extra hex polling: 0.2 to 0.5 req/s, taken from the map. Recording can be
   added if History's data turns out not to be enough.
3. **The sweep uses adsb.fi only**, the `make live` source. adsb.lol's budget (0.04 req/s) is too small for it, and a
   replay has no live world.
4. **ntfy is the phone path.** Web Push needs a service worker and HTTPS, and on an iPhone a Home Screen app.
5. **Not built now:** a military list, rare types (Plane Alert DB), go-arounds and holding, a home circle polled while no
   one watches, live D2, the selected altitude (`nav_altitude_mcp`) as a sign, batched `/v2/icao` hex requests, sound.

## Units

| Unit | Does | Depends on |
|---|---|---|
| `shared/alerts.ts` | `AlertEvent`, `EventsReply`, `describe(e)` (title and line, ASCII title for push), the squawk and status sets | nothing |
| `server/descent.ts` | `clean`, `steepDescent` (D1), `diveThenLost` (D2) on `{ tS, ft }[]` | nothing |
| `server/heatmap.ts` `scanSlot` | one pass over a half-hour file: every altitude that is known and off the ground, per aircraft, whatever its speed; the last position; the emergency idents of an airborne aircraft (a known altitude off the ground and a ground speed that is unknown or 50 kt or more) | the file format |
| `server/alerts.ts` `Alerts` | switch, confirmation, episodes, the log, push, `observe(ac)`, `sample(s, track)`, `scanSlot(buf, slotMs)`, `reply()` | the above, `fs`, `fetch` |
| `server/sources/adsbfi.ts` `squawk(code)` | `/v2/sqk/{code}`; a code that is not 4 octal digits is not asked | `fetchSnapshot` |
| `server/poller.ts` | the sweep, after a due chase and before the watch; `onAircraft` for every aircraft it takes | `opts.squawks()` |
| `server/main.ts` | wiring; `GET /api/events`, `POST /api/events?on=1\|0`; `StatusBrief.alertsRev`; the late scan after each history tick, the older half hour first; a cross-site POST refused | all |
| `client/ui/alerts.ts` | the panel, the toast, notifications, the badge count, pure `freshEvents()` | `shared/alerts.ts` |
| `client/app.ts` | the rail item, `followEvent(e)`, `replayEvent(e)`, refetch when `status.alertsRev` changes | the above |

## Errors

- A sweep answer that fails (429, 5xx, timeout) goes through the bucket like any other answer. The next code comes 10 s on.
- A log write that fails is logged once a minute at most. The event stays in memory.
- A push that fails is logged. There is no retry.
- A late scan of a file that does not read finds nothing.
- `GET /api/events` without `EVENTS_DIR` is a 404. The panel says that alerts are off on this server.

## Testing

- Unit tests for each unit with fakes: the rules on synthetic series and on the FZ1073 dive; confirmation and episodes;
  the log read back after a restart; the push headers; the sweep's order and pacing in the poller; the endpoints.
- Real data:
  - One sweep request, to check that the answer reads.
  - The late check run over a few daytime half-hour files, to count false alarms per half hour, with the thresholds
    changed if they are noisy. Done on 8 half hours: D1 went from 10,000 to 15,000 ft, D2 became the fall into the last
    point, and military and fighter aircraft were left out of the falls.
  - The panel, toast, follow and replay checked in the browser. For that check, `ALERT_SQUAWKS` sweeps a common squawk
    instead, so that events come quickly, into a log of its own (`make live EVENTS_DIR=/tmp/fh-events ALERT_SQUAWKS=7000`):
    one late check of a real half hour opened 822 events, which would fill the real week's list.
