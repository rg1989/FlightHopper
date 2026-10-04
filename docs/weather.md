# The weather in the chase

- **Weather** (the Layers panel's switch, or `W`): in the chase the clouds, rain and storms are volumes round the aircraft, out to 150 km,
  from airport reports, the rain radar and the weather model: it flies into them and fades out of sight in thick ones, and rain falls as
  a veil under a raining cloud. A line at the top centre says what is on its heading ("In light rain", "Clear air · a thunderstorm in
  3 min"; "No weather data" until a weather source has answered), a second line names a hazard area on the way, in the area's colour,
  and a red frame round the view shows the aircraft is inside one. Live only: History and scenarios draw none.
- **The Weather menu** (a square of its own under Layers, there while the chase's weather is drawn; it opens when you turn Weather on in
  a live chase, not at load). **Clouds:** natural, severity colours (cloud white, light rain blue, heavy rain amber, thunderstorm red) or
  blocks. **Hazard areas:** their edges as a curtain or a fence (each with the area's striped footprint on the ground) or a box.
  **Looking ahead:** three switches, the track line (the next six minutes on this heading, a label at each minute, coloured where it
  enters weather), the level slice (the weather at the aircraft's own altitude within 60 km, with rings at 10, 20 and 40 km) and the
  ahead strip (a side view of the next 80 km: the weather's cells, the hazard areas, the aircraft's way; not in a window under 480 px
  high). A choice applies at once and is kept in this browser; `?wxlook=natural|severity|blocks`, `?wxhaz=curtain|fence|box` and
  `?wxtrack`, `?wxslice`, `?wxstrip` (`=0` or `=1`) set them for one load, and are not kept.
- The clouds are drawn at half the view's size, and coarser (0.35, then 0.25) when the frames have been slow for a while and that helps.
  Should the graphics card refuse the cloud pass, the view goes on without it: a toast says "3-D clouds stopped after a drawing error",
  the Weather menu goes, and the hazard areas stay marked on the ground. Check aids: `?wxdemo=1` (a made-up sky, no weather asked for;
  `?wxdemo=60` starts in its rain, `?wxdemo=98` at its storm), `?wxscale=0.5|0.35|0.25` (the clouds held at one size), `?wxbreak=1`
  (the cloud pass fails on purpose).
