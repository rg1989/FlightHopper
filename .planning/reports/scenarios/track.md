# JAL123 flight-path and attitude check: primary-source corrections to the CSV

I did not edit anything in the repo and did not use curl. WebFetch saved copies of the PDFs I opened (the JTSB commentary, report parts 05, 10 and 11, and the NASA TM) outside the repo. I rendered page crops to measure the plots in the session scratchpad. The 57.7 MB report and the 18.1 MB supplement (付録) were not fetched.

**The main finding:** the Japanese report is split into small PDFs, and they contain the official annotated flight-path map (付図-1) and the full DFDR strip charts. From those, the CSV is off by roughly 10–30 km on most legs. It also leaves out the final 360° right turn and puts the impact point about 350 m from the real ridge. On that spot the terrain is about 95 m higher than the ridge.

## 1. Sources

| Key | Source | What it gives | Reliability |
|---|---|---|---|
| R05 | AAIC 1987 report, part 05: https://jtsb.mlit.go.jp/aircraft/download/62-2-JA8119-05.pdf | **付図-1 JA8119飛行経路略図** (p.137): track with 20 time/altitude/speed labels. 付図-13 and 付図-19 (pp.149, 155): wreckage maps with 一本から松, U字溝, scale bars and north arrow. | Primary. 付図-1 is a sketch map. I fitted it to 16 towns and got 0.9 km RMS error, with a bias of about 2.5 km to the west near the crash. |
| R10 | Part 10: https://jtsb.mlit.go.jp/aircraft/download/62-2-JA8119-10.pdf | 別添5 DFDR: parameter definitions and the Japanese observations table (pp.290–294). States **"phugoid period about 80 s"** (p.294). **HDG is magnetic; ALT is pressure altitude on 29.92** (p.282). | Primary |
| R11 | Part 11: https://jtsb.mlit.go.jp/aircraft/download/62-2-JA8119-11.pdf | **DFDR図-1…6 strip charts** (PDF pp.1–42): VRTG, HDG, CAS, ALT, RLL, PCH, EPR, TAS, VS. Also enlarged plots of 18:24:31–51. | Primary. Scans are clean. I read values off them to about ±3 s and ±2°. |
| RH | 付録: https://jtsb.mlit.go.jp/aircraft/download/62-2-JA8119-huroku.pdf (index: https://jtsb.mlit.go.jp/jtsb/aircraft/download/bunkatsu.html) | Per the index: DFDR error correction, the flight-state reconstruction and the simulator study. | Primary. Not fetched (18.1 MB). **Most valuable next step.** |
| K | JTSB 2011 commentary (解説): https://jtsb.mlit.go.jp/kaisetsu/nikkou123-kaisetsu.pdf | 図16 (report 付図-21 on a lat/lon grid): **estimated failure point and a 244° track**. 別添1 timeline: ATC "72 NM from Nagoya" at 18:31:14, CVR "相模湖まで来てます" (we've reached Lake Sagami) at 18:46:07, elevations 1,530/1,610/1,565 m. It has **no** DFDR plots or full-route maps. | Primary |
| GSI | GSI elevation API, 1 m laser DEM: https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php | Elevations I used to check each candidate crash-site point | Primary |
| WJ | https://ja.wikipedia.org/wiki/日本航空123便墜落事故 | Last recorded values: pitch −42.2°, roll 131.5°, HDG 277.1°, 263.7 kt. Coordinates 36°00′05″N 138°41′38″E. Also a table value "35°59′54″N 138°41′49″E (事故調資料)", which the DEM puts at 1,469 m, in a valley, so it is **not** the ridge. | Secondary |
| WO | https://ja.wikipedia.org/wiki/御巣鷹の尾根 | 昇魂之碑 memorial at 36°00′02.3″N 138°41′41.1″E. The DEM gives 1,559.6 m there, which fits the 1,565 m ridge. | Secondary, confirmed by GSI |
| CY | https://cooyou.org/123/dfdrsim/jal123sim.html, https://cooyou.org/123/otsuki/otsuki.html | About 5,100 points per parameter (HDG, TAS, ALT, RLL, PCH) digitized from R11. Its track uses HDG+TAS only. No downloadable data file. | Secondary. The same site argues against the official cause, so use its numbers only after checking them. |
| NASA | TM-2004-212045: https://ntrs.nasa.gov/api/citations/20040021348/downloads/20040021348.pdf | After the failure the aircraft trimmed at about 255 kt; lowering the gear cut trim speed from 250 to 225 kt. Gives no JAL phugoid or Dutch roll numbers. | Secondary, from a reputable source |
| BL | https://ameblo.jp/fnks2416/entry-12949801646.html | Claims U字溝 contact at about DFDR 18:56:24 with pitch about +10°, and the larch cut about 14 m above ground | Secondary, **not verified** |
| HND | https://axttriple.com/昔にタイムスリップシリーズ②　1985年春の羽田空/ | In 1985, 15L/33R was the old C runway | Secondary. I found no coordinates for it. |

Other checks:
- **No raw radar track is public.** Radar appears only in the ATC position calls.
- **The dossier has a stall-time error:** R10 gives min CAS 108 kt and AOA 30.9° at **18:49:42**, not 18:49:36.
- **The Japanese R10 has a typo:** it says 45分 "25,000 ft/min" where 2,500 is meant.

## 2. Corrections to the CSV anchors

Speeds are CAS and altitudes are pressure altitude. Positions come from the 付図-1 fit (±1.5–2 km) unless the row says otherwise.

| Time | Corrected position | Alt ft / CAS kt | Notes (CSV error) |
|---|---|---|---|
| 18:11:32 to 18:12:16 | RWY 15L, the old C runway. Coordinates **unverified**; trace it from the GSI 1984–86 aerial photos. | 0 → about 160 | 44 s ground roll. The DFDR runway heading is about 152° magnetic (about 146° true). The CSV has the aircraft parked at 160 kt with 8° pitch. |
| 18:12:48 | Right turn, about 15° bank, to about 185° magnetic | ~165 | DFDR RLL and HDG (R11) |
| 18:13:55 | 35.48 N, 139.79 E | 3,200 / 170 | Due south down mid Tokyo Bay. **The CSV flies SW over Kawasaki and Miura instead.** |
| 18:16:05 | Turn with about 20° bank to about 205° magnetic | ~6,000 / ~255 | DFDR |
| 18:18:30 | 35.12 N, 139.80 E | 12,200 / 290 | The CSV is at 35.18 N, 139.48 E, about 30 km west. |
| about 18:19:15 | Turn at about 35.03 N, 139.78 E, to about 258° magnetic | ~14,000 / 300 | Right bank about 20° |
| 18:21:36 | 34.915 N, 139.49 E | 18,900 / 300 | Moved onto the 244° track so the speeds are consistent |
| 18:24:12 | 34.78 N, 139.15 E | 23,400 / 300 | |
| **18:24:35 failure** | **34°45.7′N 139°06.0′E (34.761, 139.100), ±0.5 km** | 23,900 / 300 | Measured on K 図16. **The CSV is 11–12 km NNE of this** (34.8635, 139.1535). |
| 18:25:18 | 34.73 N, 139.01 E | 23,900 / 310 | Off the Kawazu coast. Shifted 3 km west for speed consistency. |
| 18:27:07 | 34.79 N, 138.79 E | 24,400 / 280 | Crosses **southern** Izu. **The CSV is 15–20 km too far north.** |
| 18:28:36 | 34.82 N, 138.585 E | 22,100 / 280 | Mouth of Suruga Bay |
| 18:31:08 | 34.915 N, 138.30 E | 24,900 / 250 | Just north of the Yaizu coast. This point is 70.9 NM from Nagoya, and ATC called 72 NM, which checks out. The CSV is inland at 35.03 N, 138.255 E. |
| 18:34:53 | 35.31 N, 138.34 E | 21,400 / 270 | The right turn, 35 km west of Fuji. The northbound leg is at about 138.28–138.30 E, not the CSV's 138.24 E. |
| 18:38:08 | 35.41 N, 138.71 E | 22,400 / 260 | About 6 km north of the summit (the report says "7 km NNW"). The CSV is close here. |
| 18:40:30 | 35.61 N, 138.87 E | 22,400 / 220 | Otsuki turn entry |
| 18:41:59, 18:43:05, 18:44:09 | 35.57 N, 139.02 E / 35.53 N, 138.92 E / 35.65 N, 138.91 E | 20,900, 18,600, 17,000 / 240 | **The loop is about 10–12 km across, centred about 35.58 N, 138.95 E, just south of Otsuki.** The CSV circle is about 12 km too far east and much too small. |
| 18:45:48 | 35.665 N, 139.06 E | 13,500 / 220 | The CSV has 330 kt here. |
| 18:47:17 | 35.72 N, 139.17 E | 9,000 / 230 | Easternmost point, over Okutama, west of Ome. The CSV has 11,055 ft at 139.22 E. |
| 18:48:03 | 35.78 N, 139.15 E | 6,800 / 230 | Heading about 310° magnetic. The CSV has the turn over Ome at 139.26 E. |
| about 18:49:05 / 18:49:42 | about 35.80 N, 139.10 E | 5,300 at 280 kt / about 9,400 at **108 kt, AOA 30.9°** | |
| 18:51:03 | 35.86 N, 138.96 E | 9,600 / 190 | **The CSV is 22 km too far east.** |
| 18:53:03 | 35.89 N, 138.80 E | 13,400 / 180 | **The CSV is about 30 km too far NE** (36.02 N, 139.10 E). |
| 18:54:30 | 35.968 N, 138.753 E (±1 km) | 10,700 / 220 | Worked backward from the crash using DFDR heading and speed. Heading 298° magnetic. |
| 18:55:00 | 35.982 N, 138.715 E | 11,300 / 180 | Start of the final right turn, just NE of Mt. Mikuni (三国山) |
| 18:55:40, 18:56:00, 18:56:10 | 36.014 N, 138.727 E / 35.9985 N, 138.741 E / 35.989 N, 138.729 E | 10,100 / 205, about 9,000 / 240, about 6,500 / 300 | **The final loop the CSV leaves out:** about 375° of right turn between 18:54:55 and 18:56:18, averaging about 4.5°/s and peaking about 5.6°/s. It is about 3.2 km across, centred about 36.001 N, 138.723 E. |
| 18:56:18 | 35.991 N, 138.714 E | about 4,900 / 340 | Heading 314° magnetic, about 307° true |
| **about 18:56:23** | **一本から松 (the larch): 35.9951 N, 138.7048 E; ground 1,530 m (DEM 1,534)** | | First tree strike. Position from R05 geometry, then checked against the DEM. |
| **about 18:56:26** | **U字溝 (the groove): 35.9976 N, 138.6995 E; 1,610 m (DEM 1,606)** | | About 500 m from the larch, heading about 293–300° true |
| **18:56:28 to 18:56:30** | **Ridge impact: 36.0010 N, 138.6943 E; 1,565 m (DEM 1,558–1,560)** | | About 600 m from the groove, heading about 309° true, and matches the "570 m NW" in K. **The CSV point (36.0014, 138.6897) is at 1,660 m in the DEM.** |

About the final heading:
- The DFDR heading reads about 314° magnetic at 18:56:18, then a few scattered points at about 278° magnetic after 18:56:21. That fits the 277.1° in WJ, recorded after the wing strike.
- The wreckage line runs about 295–309° true, so the final ground track was about 300–305° true. The CSV's 270° is wrong.
- The final attitude from WJ is pitch −42°, roll 131°, nearly inverted.

## 3. Attitude numbers read from the DFDR charts (R11)

Axis scales used: RLL is ±80° across the chart, with right roll plotted upward; PCH is ±40°.

| Phase | Phugoid period | Phugoid size | PCH range | Dutch roll period | RLL mean ± amplitude |
|---|---|---|---|---|---|
| Climb, 18:12:16–18:24 | – | – | +15 to +17° after liftoff; +7.5° from 18:13:45; about +5 to +6° from 18:17 | – | 0°; turns at 15–20° R |
| 18:24:35–18:26 | Starting | +0.11 g forward, −0.24 g vertical; about 2 Hz lateral shake 18:24:36–40 | 0 to +9° | – | Rolls right to +38° at about 18:25:58, then rolls out |
| 18:26–18:28:30 | about 85 s | – | −4 to +9° | about 11 s | −7 ± 13° |
| 18:28:30–18:35:30 | 82–98 s, mean about 88 s | ALT ±1,300–1,500 ft; CAS ±30 kt around about 265 kt | −5 to +13°; −11 to +20° at 18:34–35 | about 11 s | 0 ± 22°; then +18 ± 39° (peaks +57°) at 18:31–32; −11 ± 30°; +18 ± 40° |
| 18:35:30–18:39:30 | 70–80 s, slightly damped | – | −2 to +13° | about 11 s | −2 ± 36° |
| Gear down 18:39:32; Otsuki turn to 18:45:21 | Dies out quickly after about 18:42 | 22,000 → 6,600 ft by 18:48 | +1 ± 5° | about 11 s | **+27 ± 25° (peaks +52°)**, then +18 ± 17°. The report says mean ≤40° and Dutch roll ±25°. |
| Left turn, 18:45:21–18:48 | None | Sink about 2,500 fpm | −1 to −2° | about 10 s | −11 ± 14°. The report says max 25° L and Dutch roll ±12°. |
| Stall climb, 18:48–18:50:30 | **60–65 s** | ALT 5,300–9,400 ft; CAS 104–280 kt; vertical g 0.55–1.8 | **−19 to +39°** (+39° at about 18:49:28) | about 10 s | +8 ± 10°, with a spike of +29/−33° at the stall |
| 18:50:30–18:54:15 | 60–75 s, damped | Climbing to 13,400 ft | +2 to +22° | about 10 s | +6 ± 10° |
| 18:54:15–18:55:45 | about 50–55 s (flaps going out) | – | +13 → −6 → +11° | – | Left dip to −31° at 18:54:26; +21° at 18:54:50; then +35 ± 5° |
| Final dive, 18:55:45–18:56:23 | – | Sink >18,000 fpm; CAS 183 → 342 kt; 3 g at 18:56:18–23.5 | +11 → **−35°** (about 18:56:05) → +10° | – | +59° → **about +80° peak** (about 18:56:01; the report says about 70° at 18:56:07) → +40° at 18:56:10–17 |

The phugoid period shrinks with speed, which is what theory predicts (T ≈ π√2·V/g): about 88 s at about 400 kt true airspeed, about 60 s at about 220 kt. The Dutch roll period of about 10–12 s is shorter than the CSV's 15 s rows, which is why the CSV attitude looks wrong.

## 4. How to generate a 30–60 Hz pose

1. **Base path.** The best route is to digitize R11 (or get CY's arrays) at 1 Hz: HDG, TAS, ALT, RLL, PCH.
   - Convert magnetic heading to true. I used about 6.5° W declination, but that value is **unverified**; compute it from IGRF for 1985.6.
   - Dead-reckon position from true heading and true airspeed.
   - Force the path through the section 2 anchors by solving for a slowly varying wind, or by spreading the closing error along a spline in time.
   - The final 2 minutes should be worked backward from the tree strike (larch, groove, ridge), as I did.
   - Without digitized data, use a C1 Hermite or clothoid spline through the anchors, timed to the anchor speeds.
2. **Base attitude.**
   - Flight path angle γ = asin(ḣ/V).
   - Pitch = γ + α_trim, where α_trim is about 3–4° at 250 kt and scales with (V_ref/V)².
   - Base bank φ = atan(V·ψ̇/g). This matches the observed mean banks (Otsuki about 27–30°, final turn 45–60°) to within about 10°.
   - Yaw = track + wind crab.
3. **Phugoid overlay.** Add an altitude term A_h·sin(ϕ_p). Put CAS 180° out of phase with altitude, and pitch 90° ahead: Δθ ≈ 2πA_h/(T·V). As a check, 430 m, 88 s and 210 m/s give ±8.4°, which matches the DFDR.
4. **Dutch roll overlay.** φ_DR = A_φ(t)·sin(ϕ_d). Add a yaw term of A_φ/k with k about 3–4, lagging by about 90°; this is a tuning assumption, not measured. Pitch coupling is small. Include the 2 Hz shake at 18:24:36–40.
5. **Keep the oscillations smooth.** Take periods, amplitudes and mean bank per phase from the section 3 table and interpolate them smoothly. Build each oscillation's phase by integrating its frequency, ϕ(t) = ∫2π/T(t)dt, so phases never jump between segments. Evaluate the formulas at render time instead of interpolating samples. Compose the orientation as q = q_yaw·q_pitch·q_roll.
6. **Replace the scripted sections** (the stall at 18:48–50 and the dive at 18:55:45–56:23) with the digitized curves when available.

**Data that would help most:**
- The RH supplement: the DFDR error correction and the investigators' reconstructed path.
- A full 1 Hz digitization of DFDR図-1/2/4/5.
- QNH, temperature and winds aloft for 12 Aug 1985. JMA radiosondes would give the winds and temperature needed to convert pressure altitude to true altitude.
- Coordinates for the old Haneda C runway, traced from GSI 1984–86 aerial photos.