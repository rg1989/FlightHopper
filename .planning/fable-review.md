Now that I have all three documents, I want to write a critical review examining the hybrid's key decisions. On terrain, I agree with the hybrid's choice of Terrarium+EGM96 via CF proxy, but I'm noting it seems to overlook Sol's concern about runway draping needing more than a coarse clamp to terrain mesh.

Sol's point about SRTM data producing visible undulation across an engineered runway seems valid given the resolution and vertical error involved, but I lean toward GroundPrimitive clamped for MVP simplicity, with a planar runway and terrain flattening deferred. What bothers me more is the acceptance metric itself — "aircraft meets runway within ~2m vertically after datum correction" is nearly tautological if both aircraft and runway are clamped to the same terrain; the real test should compare aircraft altitude in HAE against terrain height at the moment of touchdown, since that's actually testing the terrain/geoid data rather than our code.

On Postgres, I strongly agree with the hybrid's stance to avoid it in MVP and rely on static packs — search across 85k airports doesn't need PostGIS, just a small static index with client-side lookup, and I'd flag PostGIS as a trap unless there's a genuine need for admin UI or user-contributed overrides.

On latency, I disagree with the hybrid's fixed ~3-4s window — it needs to be adaptive per source with floors (like 6s for MLAT), since a fixed window will starve on real-world gaps from sources like adsb.lol.

With a 3s cell poll cadence, non-selected aircraft have inter-sample gaps of at least that interval plus jitter, so the delay floor really needs to track above the poll interval to avoid constantly sitting at the edge of extrapolation — worth calling out explicitly. On NASR vs CIFP, I'm noting the redundancy: having both in v1 doesn't make sense since NASR runway-end records already include threshold coordinates, elevation, and displaced threshold data.

Since NASR already covers TCH and glide path angle, CIFP's procedural ground data adds little value for runways alone—its real worth is enabling approach procedures. This suggests dropping CIFP entirely from v1, deferring it to v2 alongside procedures, which conveniently removes the need for an ARINC 424 parser in the initial build. But I should double check whether the hybrid plan actually intended both sources for v1.

On the Primitive vs Entity API question for aircraft rendering, I'll stick with Primitive for aircraft models and billboards, while allowing Entity for one-off elements like runway highlight polygons—no changes needed to that approach. For Hop's ranking logic prioritizing "on final > departing > nearest," this depends on the phase detector and runway inference actually working correctly.

Running phase detection for every visible aircraft in the worker is expensive, so full-scope Hop is risky for MVP. I'll bound this to aircraft within airport activation radius so phase evaluation stays limited to a manageable set, while keeping the nearest-aircraft fallback as the baseline. On the glide ribbon question — I'd originally placed it in v1, but reconsidering the timing given it needs threshold and bearing calculations.

Given threshold elevation quality varies with OurAirports-only data, I'll flag full ribbon geometry as a stretch goal in MVP and push deviation dots to v1 since they need trustworthy threshold data. Simpler centerline-only rendering could work for MVP instead, since it's trivial to build and still validates runway selection visually.

On the ToS production gate requiring written confirmation — this is a real risk since it depends on external parties and could block a solo dev for weeks.

ial share-alike could theoretically apply since a publicly served derivative database may need ODbL terms — not a blocker for non-commercial use, but worth noting.

On fallbacks: the hybrid mentions airplanes.live/adsb.fi as backups "if whitelisted and ToS-ok," but without a confirmed agreement, MVP really only has one live source — the honest mitigation is a degraded-mode UX with a banner and frozen state, not "fallbacks" as claimed in the risk table. For cell polling, the hybrid's proposed ~1° or viewport-derived cells polled at 1-2 Hz per active cell seems reasonable but worth scrutinizing further.

The polling rate is actually too aggressive — adsb.lol does point queries at 250 nm radius, and my design called for 3 s per cell (0.33 Hz) with a global 2 req/s bucket, so 1-2 Hz per cell across multiple cells would get blocked; 1° cells are also too small (~60 nm) and wasteful for viewport coverage. The fix is to use fewer, larger 250 nm circles polled every 3 s, reserving 1 Hz polling only for the actively chased aircraft via the icao-specific endpoint.

Checking the architecture diagram — the build-to-CDN node is a stray cosmetic artifact, and the UI-to-route-cache-to-API path through the client is fine as designed.

On motion caps, the hybrid approach extrapolates up to 8 s, then linear coast/fade to 15 s, freeze/ghost to 30 s, and exit by 60 s — my version used 30 s dead reckoning with ghost at 15 and exit at 60, while Sol used a strict 8 s cap. The 8 s cap is the more honest choice, and combined with the 3-4 s delay and 3 s cell polling, non-chased billboard aircraft will often hit coast state in marginal coverage, but that's acceptable since they just freeze.

Now I'm considering the rule that Redis should only be used when running 2+ replicas.

On altitude, there's ambiguity between the hybrid's HUD display of baro/geom versus Sol's policy of baro as the principal aviation indication — I think the HUD should default to baro for altitude since that's what pilots and ATC use and what spectators expect from FR24, while geometric height stays the render-only value. The hybrid also conflates display and render policy under "primary model height," and it's missing the baro-to-HAE fallback correction for the roughly 10-20% of ADS-B traffic lacking geometric altitude.

For the terrain provider, there's an underweighted risk around Terrarium zoom-15 tile resolution and the per-tile decoding cost of 256² heightmap tiles.

My design downsamples to 64², but Phase 0 needs to actually measure this cost — the hybrid's Phase 0 mentions terrain height queries but skips the provider performance test, so I should add a Phase 0 exit criterion covering terrain provider validation at KSFO/LOWI with EGM96 and a tile decode budget. I also want to move the glTF calibration spike from §4 into Phase 0 since it's cheap and blocks the chase-cam feel.

Another gap: the hybrid mentions server-stamped samples but never addresses client-server clock offset via ping/pong, which is needed for the render clock to sync properly — a minor but real omission.

Then there's dedupe of unchanged positions, since adsb.lol re-serves the same position between updates and without deduping by timestamp, interpolation will judder — this is the single most critical detail for chase smoothness and the hybrid doesn't call it out explicitly. I also want to flag missing sequence numbers for WS snapshot recovery (mine lacked this, Sol had it) and note that imagery licensing risk isn't addressed in the hybrid either.

The hybrid's stack table has no imagery row at all, but terrain without imagery is just a grey globe, and airports need high-res texture to actually look real — probably the biggest visual factor for "touchdown looks geographically correct" after datum accuracy. My plan uses EOX Sentinel-2 cloudless (NC license) as default with keyed high-res imagery near hero airports via MapTiler's free tier or Esri World Imagery for MVP.

There's also a missing rate-limit safeguard on our own WebSocket (Sol §7.7) — a client could subscribe to the whole world bbox, so I'd add a max bbox/aircraft cap, though that's minor. More importantly, the 4-8 week solo MVP timeline feels optimistic given everything involved (backend, pipeline, Cesium terrain, estimator, phase detector, camera, Hop, mobile battery-saver, dataset registry, metrics) — I'd cut mobile battery-saver to a measurement-only goal rather than a separate build path, and keep the dataset registry as a simple JSON file rather than a full system, flagging the real MVP timeline closer to 8+ weeks.

On sequencing, Phase 0 → MVP → v1 → v2 makes sense, but Phase 0's exit criteria need to be measurable rather than subjective — something like "no visible snap over 20m in 5 minutes on ADS-B v2 aircraft, turns render as arcs, and a recorded replay fixture exists." I'd move fixture recording into Phase 0 itself, since that's exactly what's needed to tune the estimator early, and it's a quick afternoon task capturing 10 minutes of `/v2/icao` data rather than waiting until v1.

My verdict is yes-with-caveats: the merged plan beats either original by dropping Postgres/ion while keeping estimator detail, but it introduced regressions (NASR+CIFP both landing in v1, poll rate set too low at 1-2 Hz per cell) and dropped critical details like dedupe, clock sync, and the baro fallback ladder, plus imagery. I'd give final approval conditional on restoring the estimator's correctness details — sample dedupe by timestamp, server clock sync, and adaptive smoothing floored at the cell's poll interval — since without these the "Delayed Hermite playback" decision is hollow, and if I had to pick one fix, it'd be correcting the ingestion cadence spec.

The imagery omission is just a planning gap I'd add as a row, not a blocker, but the polling spec as written would actually get the project stuck, so that's the one change worth forcing. On "Follow mode," I think it's cheap enough with Cesium's near-free camera tracking that it's worth keeping as a low-cost optional feature in the hybrid plan.

There's also an inconsistency I want to flag: the hybrid lists OSM higher-res pavement for MVP hero airports but pushes OSM taxi/apron to v1 — better to clarify MVP hero airports use OurAirports rectangles plus high-res imagery and hand-verified thresholds, keeping all OSM work (with its osmium/ODbL packaging overhead) in v1. That's a real simplification worth suggesting, and similarly, PostGIS isn't actually needed just for search, so I should call that out too.

The dead-reckoning rule (no silent DR beyond ~8-15s) and the motion model's 8s extrapolation cap plus 8-15s visible coasting are basically consistent if "silent" is the key qualifier, though the wording could be tightened.

For output format, I'll go with structured markdown, numbered sections 1-5 as requested, opinionated and concise, using tables where they clarify tradeoffs.

