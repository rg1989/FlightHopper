# Flight physics: motion and attitude (design)

2026-09-28. Owner's request: aircraft in chase (live and nearby traffic) must move like real aircraft. On final approach they
"jerk the nose up periodically", the speed readout "drops to zero every now and then", and the motion should rest on real
physics so that impossible movements cannot appear. The owner approved this design and asked for the work to be done
without further questions.

## 1. Evidence (14 min of Heathrow arrivals, 184 aircraft, replayed through the app's own Track at 60 fps)

Capture: the app's server on adsb.fi at the chase rate (one 25 nm circle every 1.4 s), recorded to
`data/recordings/egll-arrivals-2026-09-28.jsonl` (git-ignored; `physics-replay-*` launch configs replay it).

| Finding | Measure | Cause |
|---|---|---|
| Nose down on final | median pitch −1.0° on 19 approaches (real: +2.5 to +3.5°) | pitch = path angle + a fixed 2° "AoA" in descent |
| Nose nodding | drawn V/S swings ±300 fpm in 1–2 s (≈ 0.3 g), std 50–120 fpm about its 5 s mean | the vertical Hermite passes through every α-β state; 25 ft steps |
| 4° pitch step | at V/S = +295 fpm | AoA table switches 2° → 6° (climb) |
| Speed jumps / dips | GS 149 → 166 kt in 1 s; 0.8 % of airborne frames < 80 % of the reported speed; taxi 4 ↔ 21 kt, track flips | the horizontal Hermite passes exactly through every position; sample times jitter ±0.1 s (1 % > 0.9 s, max 5 s) |
| Yaw wobble | ±0.5–1° at 5–10 s | nose follows the raw `true_heading` (Comm-B, noisy, refreshed every 4–5 s) |
| Bad data trusted | a gyroplane's `geom_rate` +2,600 fpm while level → pitch 0–17° at 1 Hz, height 300 ft off; a stuck 21° `roll` while flying straight | rates and roll taken at face value |
| Traffic | height steps every sample, positions snap, pitch from raw `baro_rate`, no roll | Fleet keeps only the newest sample |

## 2. Motion: a physical smoother instead of an interpolating spline

`client/track/smoother.ts`: per axis (east, north, height) a Kalman filter + Rauch–Tung–Striebel smoother with a white-jerk
motion model (state position, velocity, acceleration). It is the statistically best path under "aircraft accelerate
smoothly", and it passes near, not through, noisy samples.

- Measurements: position (σ = hypot(10 m, v·0.12 s) per axis: sample-time jitter along the velocity) and reported velocity
  (gs/track, σ 0.6 m/s; dropped when the positions contradict it, as before). Height from the altitude ladder (σ 3 m) and
  the reported rate (σ 0.5 m/s), a rate being used only when it agrees with the height trend (±2.5 m/s or 40 %).
- Report lag: a velocity report is older than its position. Measured on 1,750 turning samples, the reported track trails
  the direction flown by 0.73 s (median; quartiles 0.32–1.38 s). The velocity measurement is therefore v − 0.75·a, with
  ±0.55 s of spread as noise in proportion to the acceleration (barometric rate: 1 ± 0.7 s). On held-out real positions
  this cut the cross-track error in turns from 29 m to 11 m (p95), and in straight flight from 11.6 m to 8.5 m.
- Outliers: a position beyond 4σ is ignored (a late position, a spike); the next prediction then allows a manoeuvre
  (jerk × 20), so a real turn is followed within a sample or two; a third miss in a row restarts the state there, as
  does anything implying more than 400 m/s or 2 g (a 3 km MLAT jump). Across a gap > 4 s nothing is gated.
- Process noise from airliner limits: horizontal jerk q 0.15 m²/s⁵ (tuned on the capture: the bank it implies matches the
  broadcast roll within 1.8° RMS), MLAT 0.03, vertical 0.05.
- Between knots: quintic Hermite through the smoothed (p, v, a): position, velocity and acceleration are continuous (C2),
  so speed, V/S and bank are continuous too. After the newest knot: constant speed and turn, constant V/S (as before).
- Re-join blends stay (a new sample moves the smoothed end of the path a little). Speed, track and V/S shown and used for
  the attitude come from the estimate, not the blend (the blend's velocity made the speed readout three times noisier).
- A gap > 12 s whose ends disagree (a turn, a hold unseen) is not interpolated across: the aircraft flies into the newer
  state along its velocity. Dead reckoning keeps the change of speed of the last 2 s, fading over 4 s (take-off rolls).
- MLAT uses the same smoother with σ 60 m and no velocity (replaces gate → average → differentiate).

## 3. Attitude from flight mechanics (`client/track/attitude.ts`)

- Pitch θ = γ + α. γ = flight-path angle atan2(V/S, horizontal speed). α from the lift equation:
  with landing flap at V_ref the body angle of attack is 6°; between V_ref and ~1.6 V_ref crews set the flaps for the
  speed, which holds it near 5–6°; above that the clean wing follows the lift law α = −3.2° + C_L/0.09 with
  C_L = 1.55 · n · (V_ref/EAS)²; below V_ref it rises as 1/V². n = the turn's load factor 1/cos φ (a pull-up's too would
  be real, but from 25 ft steps its estimate is noise: it made the pitch wobble 30 % more). EAS = IAS when broadcast,
  else GS × √(ρ/ρ₀) clamped to 1–2.1 V_ref (the wind is unknown). V_ref by emitter category (light 65 kt … heavy 150 kt).
  Gives +3° on a 3° approach, ~14° after take-off, 2° in cruise, −3° in an idle descent, and the flare pitch-up, with no
  thresholds. Braking harder than any airborne drag allows (> 0.8–1.8 m/s², nearly level) is a rollout: nose down.
- Bank φ = atan(V · ω / g), ω the turn rate of the smoothed path (coordinated turn). The broadcast roll is not used.
- Heading = track + crab, the crab (true heading − track) averaged over ~15 s from fresh, plausible (≤ 25°) reports: the
  nose points into the wind without wobbling.
- Ground: pitch 0, wings level, heading along the track when moving, else held. Take-off: the nose rotates in the last
  3 s on the runway before the first airborne sample (the render delay shows what comes next).
- Rotorcraft: nose down with speed (−5° at 120 kt); balloons, gliders, vehicles: level.
- Output through a critically damped second-order filter (ω 4 rad/s) with rate limits (pitch 5°/s, roll 15°/s,
  yaw 10°/s): the real aircraft's inertia. Small render-time steps backwards no longer reset it.

## 4. Traffic

The 3-D traffic within range runs the same Track (samples of the chase circle go to the registry for aircraft near the
chased one), so it moves, climbs and banks like the chased aircraft. Tracks are dropped when out of range.

## 5. Scenarios

Unchanged: they play the recorded flight-data-recorder attitude (JAL 123's rolling is its real dutch roll).

## 6. Results on the Heathrow capture (65 airborne aircraft, 60 fps, old → new)

| | old | new |
|---|---|---|
| Pitch on final (median of 18 approaches) | −1.0° | +3.0° |
| Pitch wobble on final (std about a 5 s mean) | 0.17° | 0.23° (the path angle's real variation) |
| Speed change rate p99 (median aircraft / worst aircraft) | 35 / 99 kt/s | 2.4 / 9.6 kt/s |
| Worst single-frame pitch rate | 24.5°/s | 5°/s (the rate limit) |
| V/S wobble on final | 76 fpm | 56 fpm |
| Airborne frames below 80 % of the reported speed | 0.77 % | 0.52 % (mostly MLAT light aircraft) |

## 7. Checks

Unit tests for the smoother and the attitude physics, plus a regression test on a real Heathrow approach extracted from
the capture (pitch on final +1.5…+4.5°, pitch rate p99 < 2°/s, no GS below 90 % of the reported speed, V/S wobble < 30 fpm).
