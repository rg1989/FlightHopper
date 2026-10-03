# Alerts: emergencies and steep descents, worldwide

The user asked for a toggle that catches interesting events anywhere on Earth (an emergency, a fast and unexpected loss
of altitude), alerts them, and can follow the aircraft automatically, so that no event is missed. The research, with
sources, is in `docs/anomaly-alerts.md`. The user was away, so the design decisions below were made without asking them
(their standing instruction). Each decision gives the alternative that was not taken.

## What it does

- **One switch, on the server.** The Events panel (a bell on the rail) holds the switch "Watch the world". When it is on, the
  server watches by itself, with or without a browser open. The state is kept in `EVENTS_DIR/state.json`, so it survives a
  restart. `make live` sets `EVENTS_DIR=data/events`. Without `EVENTS_DIR`, or with a replay source, there are no alerts.
- **Emergencies anywhere, within a minute.** The poller asks adsb.fi for every aircraft on 7700, 7600 and 7500, worldwide:
  `/api/v2/sqk/{code}`, one code every 10 s, so each code every 30 s. That is 0.1 req/s of the 0.9 the app has (11 %),
  and nothing when the switch is off. The answers go into the stores like any other answer, so these aircraft are on the
  map and can be chased.
- **ADS-B emergency status** (general, minfuel, nordo, unlawful, downed) is read from every answer the server gets: the
  view, the chase, recorded flights and the sweep. No endpoint filters on it, so outside these it is not seen.
- **Steep descents.** Two rules on the barometric altitude (`server/descent.ts`):
  - *Descent (D1):* from FL200 or above, 10,000 ft or more lost within 120 s, over 4 or more points.
  - *Dive (D2):* 3,000 ft or more lost within 30 s above FL150, and then no position for 60 s or more. FZ1073 fits: the open
    networks heard 34,678 ft at 05:21:43 and 30,045 ft at 05:22:13, then nothing for 9 minutes.
  - The points are cleaned first: none above 50,000 ft, none more than 30,000 fpm away from both neighbours (a spike).
  - Live, D1 runs on the samples of the aircraft the server polls (the view, the chase). It runs only on a sample whose
    `baro_rate` is −3,000 fpm or lower, so most samples cost nothing.
  - Worldwide, D1 and D2 run on each new adsb.lol half-hour file that the server already downloads for History. This
    costs no request. The result comes 1 to 31 minutes after the event and is marked *late*.
- **The late check also reads emergency squawks.** An aircraft with two or more 7500, 7600 or 7700 ident records in a
  half-hour file is an event. This catches codes that adsb.fi did not hear.
- **False alarms.** These rules are from section 4 of the research:
  - Confirmation: a squawk or status counts only when it is seen again 25 s or more after it was first seen. One-off
    glitches are common (OpenSky counted over 8,000 brief 7500s in 4 months).
  - Ignored: aircraft on the ground, surface vehicles (C1 to C3), addresses that are not ICAO, `000000`, `000001`,
    `lifeguard` (a medical flight's priority, not an emergency) and `reserved`.
  - No descent events for military aircraft (`dbFlags & 1`, live only) or for light aircraft and gliders (A1, B1 to B7),
    which covers jump planes.
  - *Quiet* events are logged but raise no alert: 7600 and the nordo and minfuel statuses on a light aircraft (79 % of
    7600s are small private aircraft on approach).
- **One event per aircraft per episode.** A new cause on an open event updates it and does not open a new one: for
  example 7700, then unlawful, then 7500. An event stays open until 30 min pass with no sighting of any cause. A late
  finding for an aircraft that already has an event within 30 min is merged into that event.
- **The log.** `EVENTS_DIR/YYYY-MM-DD.jsonl` (UTC day of the write) holds one JSON line per open or change, and the
  newest line of an id wins. A position-only update is written at most every 5 min. At start the server reads the last
  8 days. `data/events/` is git-ignored.
- **Phone push.** When `NTFY_URL` is set (for example `https://ntfy.sh/<random topic>`), each new alerting event, and
  each new cause on one, is a POST there. ntfy.sh needs no account. The topic is the password.
- **In the app** (Events panel, `client/ui/alerts.ts`):
  - **The list.** It shows the last 7 days, newest first. Each row shows the callsign, type, what happened, when, and
    whether it is ongoing or late.
  - **Opening an event.** A click on an ongoing, live event follows the aircraft. A click on any other event opens
    History at the event, with the aircraft selected. History replays any aircraft that adsb.lol heard, for 42 days.
  - **New events.** After the page has loaded, each new alerting event shows a toast (Follow, ×). It also shows a desktop
    notification when that option is on; the permission is asked for in the switch's click. While the panel is closed,
    the rail's bell shows the number of events since the panel was last opened.
  - **Follow automatically** (an option kept in the browser) selects the new event's aircraft. It does this only for a
    live event, not a late one, and not in History or a scenario. If the map is in the chase, the chase moves to the new
    aircraft. Otherwise the map flies to it.

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
| `server/heatmap.ts` `scanSlot` | one pass over a half-hour file: airborne altitudes per aircraft, the last position, emergency idents | the file format |
| `server/alerts.ts` `Alerts` | switch, confirmation, episodes, the log, push, `observe(ac)`, `sample(s, track)`, `scanSlot(buf, slotMs)`, `reply()` | the above, `fs`, `fetch` |
| `server/sources/adsbfi.ts` `squawk(code)` | `/v2/sqk/{code}`; a code that is not 4 octal digits is not asked | `fetchSnapshot` |
| `server/poller.ts` | the sweep, after a due chase and before the watch; `onAircraft` for every aircraft it takes | `opts.squawks()` |
| `server/main.ts` | wiring; `GET /api/events`, `POST /api/events?on=1\|0`; `StatusBrief.alertsRev`; the late scan after each history tick | all |
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
    changed if they are noisy.
  - The panel, toast, follow and replay checked in the browser. For that check, `ALERT_SQUAWKS` sweeps a common squawk
    instead, so that events come quickly.
