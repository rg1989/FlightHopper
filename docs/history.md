# The past: flown paths and History

- **Flown path:** select an aircraft and its whole leg so far shows behind it, coloured by altitude; dotted where no
  receiver heard it, and from its origin airport when the route is known.
- **History** (the rail's clock button, or `?hist=<unix s>`): the map as it was at any time of the last ~42 days (what
  adsb.lol keeps), every aircraft in view on a replay clock with its type's silhouette, and a time bar (play, scrub over
  the day, the day before and after, 1×/10×/60×, Go to, Live) that shows a loader while the time under it loads. A
  selected aircraft brings its day: its flights in amber on the bar, and where it was at any time (flying, on the ground,
  or faded where it was last heard). Chase in 3-D works in the past too. Aircraft types: the Mictronics database (ODC-By
  1.0, credit below). Design: [`.planning/history-design.md`](../.planning/history-design.md),
  [`.planning/history-ux-design.md`](../.planning/history-ux-design.md).
- A live server keeps the newest hour of the past in memory (two half-hour files, ~25 MB per 30 min while it runs); older
  half hours are fetched when the replay needs them and dropped again. Nothing is written to disk.
