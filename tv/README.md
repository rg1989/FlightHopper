# FlightHopper on the TV

The living-room TV (Xiaomi Mi TV, Android 9, 4K panel, weak GPU) cannot render Cesium, so `omarchy` (MacBookPro16,1,
Radeon Pro 5300M, Arch/Omarchy, Hyprland) renders FlightHopper and Sunshine streams it to Moonlight on the TV: 1080p
HEVC capped at 5 Mbit/s (`max_bitrate`), because the TV's Wi-Fi takes only ~9 Mbit/s from omarchy.
The TV remote drives the app: the page runs with `?tv=1` (`client/ui/remote.ts`).

```
TV remote → Moonlight (tv/moonlight: OK → Enter, Back → Esc) → Sunshine (omarchy) → uinput keyboard → Hyprland →
Chromium kiosk on the headless output FHTV (1920x1080, device scale 1: 1920x1080 CSS px)
→ http://localhost:8787/?tv=1
```

On the TV: the **FlightHopper** tile (tv/launcher) opens the stream straight away. Home leaves it (it keeps running
for 10 minutes, then `fh-tv-idle` quits it); the tile resumes it.

## omarchy (files in tv/omarchy)

| File | Goes to |
|---|---|
| `flighthopper.service` | `/etc/systemd/system/` — the server, live adsb.fi on 127.0.0.1:8787, serving `~/flighthopper/dist` |
| `sunshine.conf`, `apps.json` | `~/.config/sunshine/` — wlr capture of FHTV, VA-API on the Radeon, one app "FlightHopper" |
| `fh-tv-start`, `fh-tv-stop`, `fh-tv-kiosk`, `fh-tv-idle` | `~/.local/bin/` — the app's prep commands, the kiosk, the idle quit |
| `fh-tv-idle.service`, `fh-tv-idle.timer` | `~/.config/systemd/user/` (enable the timer) |
| `flighthopper-tv.lua` | `~/.config/hypr/`, with `require("hypr.flighthopper-tv")` at the end of `hyprland.lua` |

Deploy the app: `git archive <branch> | ssh omarchy tar -x -C ~/flighthopper`, then on omarchy
`npm ci && npm run build` (mise node on PATH) and `sudo systemctl restart flighthopper`. `.env.local` (the ArcGIS key)
is copied by hand. Sunshine's web UI answers on omarchy only: `ssh -L 47990:localhost:47990 omarchy`, then
https://localhost:47990 (user admin, password in `~/.config/sunshine/.webui-pass`). ufw lets 47984, 47989, 48010/tcp
and 47998-48000/udp in from 10.0.0.0/24.

**Omarchy must be unlocked.** It locks when its lid closes, and a lock covers every screen, the TV's too; the remote's
keys would go to the password box. `fh-tv-start` refuses to start while it is locked (Moonlight then says the app
failed to start). Whether it locks at all is the owner's choice (Omarchy's `omarchy-toggle-idle`, the lid settings).

## TV (tv/moonlight, tv/launcher)

`tv/moonlight/patch.sh` builds `moonlight-tv.apk` (Moonlight v12.2, OK/Back mapped, 1080p HEVC by default) and
`tv/launcher/build.sh` builds `flighthopper-tv.apk` (the tile). Install both with `adb install -r`. Pair once: Moonlight →
omarchy → it shows a PIN → enter it in Sunshine's web UI (PIN tab) or
`curl -sk -u admin:<pass> -X POST https://localhost:47990/api/pin -d '{"pin":"1234","name":"TV"}'` on omarchy.
