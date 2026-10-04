# FlightHopper on a TV

A TV with a weak GPU cannot render the globe. Here a Linux PC renders FlightHopper in a Chromium kiosk and
[Sunshine](https://app.lizardbyte.dev/Sunshine/) streams it to [Moonlight](https://moonlight-stream.org/) on the TV.
The TV remote drives the app: the page runs with `?tv=1` (`client/ui/remote.ts`).

```
TV remote → Moonlight (OK → Enter, Back → Esc) → Sunshine → uinput keyboard → Hyprland
→ Chromium kiosk on the headless output FHTV (1920x1080) → http://localhost:8787/?tv=1
```

This is one working setup, not a product: a Xiaomi Mi TV (Android 9) and a PC with Omarchy (Arch, Hyprland) and a
Radeon GPU. The files name the host `omarchy` (`sunshine.conf` `sunshine_name`, `Launch.java` `HOST`) and the user
`YOUR_USER`. Change both to yours.

On the TV, the **FlightHopper** tile opens the stream. Home leaves it: it keeps running for 10 minutes, then
`fh-tv-idle` quits it. The tile resumes it.

## The host (tv/omarchy)

| File | Goes to |
|---|---|
| `flighthopper.service` | `/etc/systemd/system/`: the server, live on 127.0.0.1:8787, serving `~/flighthopper/dist` |
| `sunshine.conf`, `apps.json` | `~/.config/sunshine/`: captures FHTV, encodes with VA-API, one app "FlightHopper" |
| `fh-tv-start`, `fh-tv-stop`, `fh-tv-kiosk`, `fh-tv-idle` | `~/.local/bin/`: the app's prep commands, the kiosk, the idle quit |
| `fh-tv-idle.service`, `fh-tv-idle.timer` | `~/.config/systemd/user/` (enable the timer) |
| `flighthopper-tv.lua` | `~/.config/hypr/`, with `require("hypr.flighthopper-tv")` at the end of `hyprland.lua` |

Put your user name in before you copy them:

```bash
sed -i "s/YOUR_USER/$USER/g" tv/omarchy/flighthopper.service tv/omarchy/apps.json
```

Then, in `~/flighthopper` on the host: `npm ci && npm run build`, and `sudo systemctl enable --now flighthopper`.
`flighthopper.service` pins the path of a mise-installed Node: set it to your `node`.

`fh-tv-idle` reads the Sunshine web UI password from `~/.config/sunshine/.webui-pass`: write yours there, readable by
you only. The firewall must let Sunshine's ports in from your LAN: 47984, 47989, 48010/tcp and 47998-48000/udp.

**The host must be unlocked.** A lock screen covers every output, the TV's too, and the remote's keys would go to the
password box. `fh-tv-start` refuses to start while it is locked.

`sunshine.conf` caps the stream at 5 Mbit/s HEVC for a slow Wi-Fi link. Raise `max_bitrate` if yours carries more.

## The TV (tv/moonlight, tv/launcher)

- `tv/moonlight/patch.sh` builds `moonlight-tv.apk`: Moonlight v12.2 with OK and Back mapped, 1080p HEVC by default.
- `tv/launcher/build.sh` builds `flighthopper-tv.apk`: the tile.

Both need the Android build-tools. Install them with `adb install -r`. Pair once: in Moonlight pick the host, then
enter the PIN it shows in Sunshine's web UI (https://localhost:47990 on the host, PIN tab).
