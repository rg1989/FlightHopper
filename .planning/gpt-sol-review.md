# 1. Verdict

**Yes—with caveats.** It combines Sol’s operational discipline with Fable’s chase-view specificity, but several “defaults” are still unproven implementation bets or insufficiently hard production gates.

# 2. Keep / drop / change

- **Change fixed 3–4 s latency to adaptive delay.** Use roughly `p90 inter-sample gap + 1 s`, bounded around 3–8 s. Fixed delay will repeatedly starve on irregular or MLAT tracks.
- **Change cell polling.** “~1° cells at 1–2 Hz” can explode request volume. Use provider-sized overlapping query regions, a global token bucket, 3–5 s browse cadence, and dedicated selected-aircraft polling only when permitted.
- **Clarify extrapolation.** “≤8 s extrapolation” conflicts with “8–15 s linear coast.” Linear coast is extrapolation. Stop predictive movement at 8 s; then freeze/fade, or explicitly accept a 15 s limit.
- **Keep static airport packages; revise the PostGIS trigger.** Search and multi-region deployment do not inherently require PostGIS—a compact spatial index can cover MVP/v1. Add PostGIS only for runtime spatial queries, editing/admin workflows, or data complexity that static builds cannot handle.
- **Pull NASR forward selectively.** Include NASR for US hero airports in MVP; accurate thresholds and elevations directly support the touchdown promise.
- **Move CIFP `PG` to v2 unless a proven parser already exists.** NASR plus a clearly labeled nominal 3°/50 ft ribbon is enough for v1. CIFP’s agreement, ARINC parsing, and cycle operations are disproportionate merely to refine TCH.
- **Keep Primitive API, but do not mandate the Worker prematurely.** Primitive rendering and a custom estimator are correct. Move all-aircraft estimation to a Worker only after profiling; keep chased-aircraft interpolation on the render path.
- **Keep Hop.** Require fresh, chase-eligible tracks and deterministic ranking with graceful “no suitable aircraft” behavior.
- **Keep the glide ribbon in v1.** Label it **nominal visual glidepath**, suppress deviations for low-quality/MLAT tracks, and never imply a published or assigned approach.
- **Change ground clamping.** Prefer an engineered runway/taxi surface when spatially consistent; terrain is the fallback. Blend into the constraint only after strong ground evidence.
- **Strengthen the ToS gate.** “Written confirmation” is not enough. Record approved rates, caching, derived-database treatment, attribution, redistribution, commercial use, and shutdown requirements for every runtime provider and fallback.
- **Add an explicit imagery decision.** The architecture mentions an imagery cache but selects no MVP imagery source. This is a licensing and product-quality dependency, not a v2 detail.

# 3. Missing risks

- The Terrarium-to-Cesium heightmap path is still a technical hypothesis: tiling, border continuity, decode cost, availability metadata, normals, and per-vertex geoid conversion need Phase 0 proof.
- Public ADS-B point APIs may be unusable at meaningful distributed demand even with fan-in.
- Hero airports may lack suitable live traffic during demos; recorded deterministic replay fixtures are needed.
- Coarse terrain should not define runway shape—draping can visibly warp engineered pavement.
- WebSocket backpressure, reconnect sequence recovery, client clock synchronization, and source-switch discontinuities are underweighted.
- Privacy/abuse controls and deep-link policy need to precede public sharing.
- “Within ~2 m vertically” can be achieved artificially by clamping; it does not validate airborne altitude accuracy.

# 4. MVP cut confirmation

**The Phase 0 → MVP → v1 → v2 sequence is sound.**

Acceptance tweaks:

- Phase 0 must separately prove terrain/datum conversion, recorded-track smoothing, model-axis calibration, and provider request economics.
- Define exact test devices and duration for 60/30 FPS.
- Add a 24-hour provider-budget soak with zero uncontrolled 429s.
- Test reconnect, sequence gaps, source changes, and terrain loss.
- Replace the touchdown criterion with:
  - ground model within 2 m of the modeled runway surface after confirmed ground state;
  - no visible vertical correction exceeding 5 m during touchdown transition;
  - runway endpoint accuracy measured separately.
- Replace “ToS path confirmed” with “production rights approved for every required live, terrain, and imagery source.”

# 5. Final blessing

**Yes, I would ship against this hybrid as the working plan.**

The one required change is to make the source-by-source production rights matrix—including live ADS-B, fallbacks, terrain, and imagery—a hard public-launch gate rather than a general ToS intention.