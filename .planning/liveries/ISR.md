# Israir (ISR): Airbus A320-232 livery dossier

Status: research, 2026-09-29. Scope: the survey key `A320 ISR`, the own fleet `4X-AB*`.
The reference files are in `data/livery-refs/ISR/`. That folder is git-ignored. `refs.json` lists every file.

Independent check, 2026-09-29: every claim was re-measured on the photos. Marks: "(verified)" means the checker
re-measured it and it holds; "(corrected: was …)" means the checker changed it. The main corrections are an azure
triangle at the aft-lower corner of the sky disc (§4 rear shapes 3a), the navy under the tail cone running aft to
d ≈ 31.9 (§4 rear shapes 4–5), the fin LE/TE root positions and the fin u values that depend on them, the title-star
height, the engine nozzle length, and the fin-star TE clearance. The checker added 7 photos; the newest right-side
elevation is `commons/ABX-2026-07-15-SZG2.jpg` (2026).

## Conventions used in this dossier

- **d**: metres aft of the nose tip, in side elevation. The type is the A320-200: length 37.57 m, fuselage height
  4.14 m, width 3.95 m. The kit's paint frame has +z towards the nose, so z = z_nose − d.
- **f**: fraction of the local fuselage height at that d, in side elevation (0 = keel, 1 = crown), as `k.at(z, f)`.
- **fin (u, h)**: u = 0 at the leading edge (LE) and 1 at the trailing edge (TE). h = 0 at the fin root (crown) and
  1 at the tip, as `k.fin(u, h)`.
- The d scale comes from the Airbus A320 AC document (Jun 2024). Door 1 is at 5.04 m, the overwing exits are at
  14.43 m and 15.28 m, and the aft door (door 4) is at 29.53 m. In each photo I fitted a linear scale to door 1 and
  door 4. In ABG-2025-04-04 this fit puts the overwing exits within 0.1 m of the AC values and the tail tip at 37.69 m.
  The measured values are accurate to about ±0.3 m. (verified: checker's fit gives 44.45 px/m and the exits at 14.32
  and 15.17 m)
- **Side-elevation vs. on-surface size.** Titles on the upper fuselage (f ≈ 0.75–0.9) lie on a surface that is
  inclined about 38°. In a true side view they appear compressed vertically to about 0.78 of their real height. All
  heights below are side-elevation values, because the app projects the artwork along the span. The painter must use
  these values and must not scale them back up.
- Photo names refer to files in `data/livery-refs/ISR/` (`commons/…`, `ps/…`).

Type landmarks. From the A320 AC document: nose gear at 5.07 m; main gear at 17.71 m; forward cargo door at 8.16 m;
aft cargo door at 22.69 m; bulk door at 26.29 m; fin tip 12.0 m above the ground with the aft crown 6.0 m above the
ground, so the fin is about 6.0 m above the crown. Measured in ABG-2025-04-04:

- Cabin window centre line: f = 0.648, which is 2.68 m above the keel. (verified: ABG 0.657, 2.72 m)
- Door 1: top at f 0.86, sill at about f 0.40. (verified: ABG top 0.875, sill 0.40)
- Fin: the LE meets the crown at d ≈ 28.6 m through the dorsal fillet (corrected: d ≈ 28.9–29.1. In ABG the fillet's
  sky leaves the crown row at d 29.07 and is 0.2 m above the crown at d 29.5.) The straight LE line extended to the
  crown gives d ≈ 30.0 m (corrected: was 29.5; ABG 29.9, SZG2 30.1, straight-line fit through h 0.2–0.9). The TE
  line extended to the crown gives d ≈ 35.5 m (corrected: was "root TE at 35.0"; ABG 35.47, SZG2 35.5). At the crown row the navy ends at d ≈ 34.8–35.0 only because a small
  white tail-cone patch covers the TE root below fin h ≈ 0.08. Tip LE is at d ≈ 35.1 m and tip TE at d ≈ 37.0 m
  (verified: ABG 35.14 / 36.99, SZG2 35.19 / 37.0).
- Fin trapezoid used for every fin (u, h) value below (corrected): LE from d 30.0 (h 0) to 35.15 (h 1); TE from
  d 35.5 (h 0) to 37.0 (h 1). Where a value was given on the old trapezoid (LE 29.5, TE 35.0), it is marked. If the
  kit's fin outline differs, place fin art by d and h, which are the measured quantities.

---

## 1. Identity

**Scheme.** This is the Israir scheme introduced in June 2010. It was first painted on the new A320-232 that became
4X-ABF (World Airline News, 17 Jun 2010). (verified: the article says F-WWDC, msn 4354, left the Toulouse paint shop
on 12 June 2010; it has no description of the design.) The design has not changed since:

- A 2011 Commons photo of 4X-ABG shows the same design (verified: now downloaded as `commons/ABG-2011-08-16.jpg`,
  right side; same fields, same titles, same fin).
- Photos from 2022 to 2026 show the same design (verified; the newest is `commons/ABX-2026-07-15-SZG2.jpg`, whose
  crown crossings agree with ABG-2025-04-04 within 0.1 m).

The scheme is a white fuselage, with the bilingual title lock-up "ישראייר ★ ISRAIR" forward. The rear fuselage and
fin are built from overlapping navy, azure and pale sky-blue shapes. The fin is navy with a large orange six-point
star with a swoosh (the Israir emblem). The engines are navy and the belly is azure.

All 8 own aircraft are A320-232 with IAE V2500-A5 engines (Commons categories and planespotters titles).
(verified: the MSNs below match the Commons file titles; 4X-ABS msn 2728, ex 9V-TAF, V2527-A5, per airfleets.net;
Wikipedia lists 8 × A320 plus 2 × A330-200.)

| Registration | MSN | Scheme seen | Evidence photo | Date |
|---|---|---|---|---|
| 4X-ABF | 4354 | standard (verified) | commons/ABF-2024-07-14-a.jpg, -b.jpg | 2024-07-14 |
| 4X-ABF | | standard tail and rear, **no fuselage titles** | ps/4X-ABF.jpg | undated (recent planespotters ID) |
| 4X-ABG | 4413 | standard (verified) | commons/ABG-2011-08-16.jpg, ABG-2024-11-22.jpg, ABG-2025-04-04.jpg, ABG-2025-10-17.jpg; ps/4X-ABG.jpg | 2011-08-16, 2024-11-22, 2025-04-04, 2025-10-17 |
| 4X-ABI | 7110 | standard plus temporary "#Bringthemhome" banner and yellow ribbon (left side) | commons/ABI-2024-04-16-a/b/c.jpg | 2024-04-16 |
| 4X-ABI | | standard, no banner (right side) (verified) | ps/4X-ABI.jpg; commons/ABI-2018-06-02.jpg; commons/ABI-2025-08-18-belly-piki.jpg | undated; 2018-06-02; 2025-08-18 |
| 4X-ABS | 2728 | standard plus IFCJ special marks (doves, IFCJ logo, "…JEWISH PEOPLE HOME" with a photo panel) | commons/ABS-2022-04-14.jpg | 2022-04-14 |
| 4X-ABS | | standard | ps/4X-ABS.jpg | undated (recent) |
| 4X-ABT | 6200 | standard plus "SKIDEAL" / skier graphic / "SNOW MUST GO ON!" marks (left side) | commons/ABT-2024-11-03-BER.jpg, ABT-2024-12-05.jpg; ps/4X-ABT.jpg | 2024-11-03, 2024-12-05 |
| 4X-ABW | 2587 | standard (verified) | commons/ABW-2022-12-29.jpg, ABW-2023-03-08.jpg, ABW-2024-06-04.jpg, ABW-2024-06-04-b.jpg, ABW-2025-08-16-piki.jpg; ps/4X-ABW.jpg | 2022-12-29 … 2025-08-16 |
| 4X-ABX | 2934 | ex-Bamboo Airways "AIRWAYS" hybrid (white, green-striped tail) | commons/ABX-2024-07-26.jpg | 2024-07-26 |
| 4X-ABX | | standard (repainted) (verified) | commons/ABX-2025-11-28.jpg, ABX-2026-07-15-SZG2.jpg (right side), ABX-2026-07-15-SZG6.jpg (left side), SZG1/SZG7 (distant); ps/4X-ABX.jpg | 2025-11-28, 2026-07-15 |
| 4X-ABY | 3010 | ex-Bamboo "AIRWAYS" hybrid | commons/ABY-2024-09-29.jpg, ABY-2025-04-25.jpg | 2024-09-29, 2025-04-25 |
| 4X-ABY | | standard (repainted after Apr 2025) | ps/4X-ABY.jpg | undated (recent) |

**Exceptions.**

- **Special marks** are temporary decals applied over the standard scheme: SkiDeal on 4X-ABT, #Bringthemhome on
  4X-ABI, and IFCJ on 4X-ABS. Their current state is unknown. Leave them out and paint the standard scheme.
  (verified in the named photos; the recent planespotters photo of 4X-ABS shows no IFCJ marks.)
- **4X-ABF titles.** One recent planespotters photo shows 4X-ABF without fuselage titles. Everything else in that photo
  is standard. The cause is probably a repaint or a lease. Paint the standard scheme. (verified: no titles; tail, rear
  fields, belly band and navy engines are standard. The photo date is unknown.)
- **Wet-leased frames** fly ISR callsigns in other paint. The design decision of 2026-09-23 says they are painted in
  Israir's standard livery anyway. For the record, their real paint is:

| Registration | Operator (planespotters) | Real paint | Evidence |
|---|---|---|---|
| 9A-BTM, 9A-BTI, 9A-BTH | Trade Air | Trade Air (navy/turquoise swooshes, yellow-orange sun tail) (verified) | ps/9A-BTM.jpg, ps/9A-BTH.jpg |
| YR-ADC, YR-ADA | FlyYo | all white (verified for both; checker added ps/YR-ADA.jpg) | ps/YR-ADC.jpg, ps/YR-ADA.jpg |
| YR-RAM | HelloJets | all white (verified) | ps/YR-RAM.jpg |
| OK-HEU | Smartwings | Czech Airlines "100 years" (verified) | ps/OK-HEU.jpg |
| LY-TEN | GetJet Airlines (corrected: was "?"; A320-214 msn 3817, ex VP-CXT, per flightradar24 / airfleets.net) | not seen: no API photo | – |

**Wingtip devices (own fleet).**

| Wingtip | Registrations | Evidence photos |
|---|---|---|
| Wingtip fences | 4X-ABF, ABG, ABS, ABT, ABW, ABX, ABY (7 aircraft) | ABF-2024-07-14-a, ABG-2025-10-17, ABS-2022-04-14, ABT-2024-11-03-BER, ABW-2024-06-04, ABX-2025-11-28, ABY-2025-04-25 (verified) |
| Sharklets | 4X-ABI only | ABI-2024-04-16-a/b/c, ABI-2018-06-02, ABI-2025-08-18-belly-piki, ps/4X-ABI; planespotters lists it as "A320-232 WL" (verified; Commons: "first Israir A320 with sharklet", 2016) |

## 2. Reference images

All paths are relative to `data/livery-refs/ISR/`.

| File | View | Reg | Source | Author | Licence |
|---|---|---|---|---|---|
| commons/ABF-2024-07-14-a.jpg | 3/4 front left (in flight) | 4X-ABF | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(cn_4354,_4X-ABF)_2024-07-14_Andre_Gerwing_Collection_ID_021133.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABF-2024-07-14-b.jpg | left side (in flight) | 4X-ABF | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(cn_4354,_4X-ABF)_2024-07-14_Andre_Gerwing_Collection_ID_021134.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABG-2025-04-04.jpg | right side (ground level, sun), **main right-side measurement photo** | 4X-ABG | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(c-n_4413,_4X-ABG)_2025-04-04_Andre_Gerwing_Collection_ID_023336.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABG-2025-10-17.jpg | 3/4 front right (in flight) | 4X-ABG | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(c-n_4413,_4X-ABG)_2025-10-17_Andre_Gerwing_Collection_ID_026993.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABI-2024-04-16-a.jpg | 3/4 front left; winglet (inner face of the right sharklet) | 4X-ABI | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(cn_7110,_4X-ABI)_2024-04-16_Andre_Gerwing_Collection_ID_019831.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABI-2024-04-16-b.jpg | left side; winglet (outer face) | 4X-ABI | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(cn_7110,_4X-ABI)_2024-04-16_Andre_Gerwing_Collection_ID_019832.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABI-2024-04-16-c.jpg | 3/4 front left; both winglets | 4X-ABI | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(cn_7110,_4X-ABI)_2024-04-16_Andre_Gerwing_Collection_ID_019833.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABI-2025-08-18-belly-piki.jpg | belly | 4X-ABI | https://commons.wikimedia.org/wiki/File:147528_israir_takes_off_from_ben_gurion_airport_PikiWiki_Israel.jpg | דוידי ורדי (Davidi Vardi), PikiWiki | CC BY 2.5 |
| commons/ABS-2022-04-14.jpg | 3/4 left from below (sun), belly | 4X-ABS | https://commons.wikimedia.org/wiki/File:4X-ABS_Micha_b.jpg | LLHZ2805 | CC BY-SA 4.0 |
| commons/ABT-2024-11-03-BER.jpg | left side, in flight seen from below, fuselage tilted 5.5° in the frame (corrected: was "left side (full sun)"), **main left-side measurement photo**: good for d; its f values carry perspective error | 4X-ABT | https://commons.wikimedia.org/wiki/File:Berlin_Brandenburg_Airport_Israir_Airbus_A320-232_4X-ABT_(DSC06434).jpg | MarcelX42 | CC BY-SA 4.0 |
| commons/ABT-2024-12-05.jpg | left side (in flight) | 4X-ABT | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(c-n_6200,_4X-ABT)_2024-12-05_Andre_Gerwing_Collection_ID_022658.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABW-2022-12-29.jpg | right side 3/4 from above (parked, sun); tail close-up; engine | 4X-ABW | https://commons.wikimedia.org/wiki/File:4X-ABW_Micha.jpg | LLHZ2805 | CC BY-SA 4.0 |
| commons/ABW-2023-03-08.jpg | 3/4 left from below (belly) | 4X-ABW | https://commons.wikimedia.org/wiki/File:4X-ABW.jpg | PDBEHFLFHJWS | CC BY-SA 4.0 |
| commons/ABW-2024-06-04.jpg | left side (in flight) | 4X-ABW | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(cn_2587,_4X-ABW)_2024-06-04_Andre_Gerwing_Collection_ID_019905.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABW-2025-08-16-piki.jpg | right side (in flight, evening) | 4X-ABW | https://commons.wikimedia.org/wiki/File:147526_israir_a320_aircraft_PikiWiki_Israel.jpg | דוידי ורדי (Davidi Vardi), PikiWiki | CC BY 2.5 |
| commons/ABX-2024-07-26.jpg | 3/4 right from below (ex-Bamboo paint) | 4X-ABX | https://commons.wikimedia.org/wiki/File:4X-ABX-Micha_b.jpg | LLHZ2805 | CC BY-SA 4.0 |
| commons/ABX-2025-11-28.jpg | 3/4 front right (in flight) | 4X-ABX | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(c-n_2934,_4X-ABX)_2025-11-28_Andre_Gerwing_Collection_ID_027502.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABX-2026-07-15-SZG6.jpg | left side (ground level); tail-cone boundary | 4X-ABX | https://commons.wikimedia.org/wiki/File:Salzburg_-_Maxglan_-_Flughafen_-_4X-ABX_(Israir)_-_2026_07_15-6.jpg | Eweht | CC BY-SA 4.0 |
| commons/ABY-2024-09-29.jpg | right side (parked, ex-Bamboo paint) | 4X-ABY | https://commons.wikimedia.org/wiki/File:4X-ABY_Micha.jpg | LLHZ2805 | CC BY-SA 4.0 |
| commons/ABY-2025-04-25.jpg | right side (in flight, ex-Bamboo paint) | 4X-ABY | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(c-n_3010,_4X-ABY)_2025-04-25_Andre_Gerwing_Collection_ID_023599.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABG-2011-08-16.jpg | right side (ground, sun); 2011 proof that the design is unchanged (added by checker) | 4X-ABG | https://commons.wikimedia.org/wiki/File:Israir_-_Airbus_A320-232_-_Tel_Aviv_Ben_Gurion_-_4X-ABG-1263.jpg | Raimond Spekking | CC BY-SA 4.0 |
| commons/ABG-2024-11-22.jpg | left side (in flight, overcast) (added by checker) | 4X-ABG | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(c-n_4413,_4X-ABG)_2024-11-22_Andre_Gerwing_Collection_ID_022589.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABI-2018-06-02.jpg | right side (in flight, sun); right sharklet outer face (added by checker) | 4X-ABI | https://commons.wikimedia.org/wiki/File:Israir_4X-ABI.jpg | Tony Goldin | CC BY-SA 4.0 |
| commons/ABW-2024-06-04-b.jpg | 3/4 front left (in flight) (added by checker) | 4X-ABW | https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(cn_2587,_4X-ABW)_2024-06-04_Andre_Gerwing_Collection_ID_019904.jpg | André Gerwing | CC BY-SA 4.0 |
| commons/ABX-2026-07-15-SZG2.jpg | right side (ground level, overcast), **newest right-side elevation (2026)**, cross-check of ABG (added by checker) | 4X-ABX | https://commons.wikimedia.org/wiki/File:Salzburg_-_Maxglan_-_Flughafen_-_4X-ABX_(Israir)_-_2026_07_15-2.jpg | Eweht | CC BY-SA 4.0 |
| commons/ABX-2026-07-15-SZG1.jpg, -SZG7.jpg | distant left side / climb-out from below; low value (added by checker) | 4X-ABX | https://commons.wikimedia.org/wiki/File:Salzburg_-_Maxglan_-_Flughafen_-_4X-ABX_(Israir)_-_2026_07_15-1.jpg, …-7.jpg | Eweht | CC BY-SA 4.0 |
| ps/4X-ABF.jpg | left side (ground), no titles | 4X-ABF | https://www.planespotters.net/photo/1970069/4x-abf-israir-airlines-airbus-a320-232 | Niklas Engel | reference only |
| ps/4X-ABG.jpg | right side (in flight) | 4X-ABG | https://www.planespotters.net/photo/1951299/4x-abg-israir-airlines-airbus-a320-232 | Kamil Cukrowski | reference only |
| ps/4X-ABI.jpg | right side (ground); sharklets | 4X-ABI | https://www.planespotters.net/photo/1954860/4x-abi-israir-airlines-airbus-a320-232-wl | Severin Hackenberger | reference only |
| ps/4X-ABS.jpg | left side (landing) | 4X-ABS | https://www.planespotters.net/photo/1926422/4x-abs-israir-airlines-airbus-a320-232 | Niklas Driessen | reference only |
| ps/4X-ABT.jpg | left side (ground), SkiDeal marks | 4X-ABT | https://www.planespotters.net/photo/1980410/4x-abt-israir-airlines-airbus-a320-232 | Roland Winkler | reference only |
| ps/4X-ABW.jpg | left side (landing) | 4X-ABW | https://www.planespotters.net/photo/1939523/4x-abw-israir-airlines-airbus-a320-232 | Severin Hackenberger | reference only |
| ps/4X-ABX.jpg | 3/4 left from below | 4X-ABX | https://www.planespotters.net/photo/1985528/4x-abx-israir-airlines-airbus-a320-232 | Peter Tolnai | reference only |
| ps/4X-ABY.jpg | right side (ground) | 4X-ABY | https://www.planespotters.net/photo/1982577/4x-aby-israir-airlines-airbus-a320-232 | Gerrit Griem | reference only |
| ps/9A-BTM.jpg | right side (Trade Air) | 9A-BTM | https://www.planespotters.net/photo/1911577/9a-btm-trade-air-airbus-a320-216 | Graeme Williamson | reference only |
| ps/9A-BTH.jpg | left side (Trade Air) | 9A-BTH | https://www.planespotters.net/photo/1985897/9a-bth-trade-air-airbus-a320-214 | Niklas Engel | reference only |
| ps/YR-ADC.jpg | right side (white) | YR-ADC | https://www.planespotters.net/photo/1799697/yr-adc-flyyo-airbus-a320-214 | Varani Ennio - VRN Spotter Group | reference only |
| ps/YR-RAM.jpg | left side (white) | YR-RAM | https://www.planespotters.net/photo/1953356/yr-ram-hellojets-airbus-a320-232 | Varani Ennio - VRN Spotter Group | reference only |
| ps/OK-HEU.jpg | left side (Czech Airlines 100 years) | OK-HEU | https://www.planespotters.net/photo/1952804/ok-heu-smartwings-airbus-a320-214 | Kaan Can Ozdemir | reference only |
| ps/YR-ADA.jpg | left side (in flight, white) (added by checker) | YR-ADA | https://www.planespotters.net/photo/1966653/yr-ada-flyyo-airbus-a320-214 | András Soós | reference only |
| logos/Israir_Airlines_Logo.svg | logo lock-up | – | https://commons.wikimedia.org/wiki/File:Israir_Airlines_Logo.svg | Israir Airlines Ltd. | PD-textlogo |
| logos/israir-star.svg, israir-title-latin.svg, israir-title-hebrew.svg | logo parts (derived) | – | as above | Israir Airlines Ltd. | PD-textlogo |

The planespotters API responses are saved in `api/` for provenance. The planespotters API returns only one photo per
aircraft and gives no photo dates.

## 3. Colours

**Brand source.**

- `logos/Israir_Airlines_Logo.svg` uses blue `#18549C` and orange `#F47721`. Commons gives israir.co.il as its
  source.
- The israir.co.il stylesheets (fetched 2026-09-29) use `#18549C`, a dark navy `#0F3766`, and `#F47721` / `#FF6600`.
- There is no public paint specification.

**Photo samples.**

- I white-balanced each photo on the sunlit white fuselage, set to 242.
- For the colour clusters I used k-means on saturated pixels in each region. For the spot checks I used small boxes.
- Main samples come from ABW-2022-12-29 (full sun), ABG-2025-04-04 (hazy sun), ABT-2024-11-03-BER (sun, from below)
  and ABX-2026-07-15-SZG6 (overcast).
- The fin and the titles have the same navy in every photo, and so does the nacelle. (verified: title stroke cores
  ABG #131453 vs fin #15206F, ABW22 #173778 vs #0A2D81; the titles are navy, not the logo file's lighter #18549C.)
- Checker's re-samples (median of all pixels of each field, white-balanced to 242 on the nearest sunlit white):

| Field | ABG-2025-04-04 (hazy) | ABW-2022-12-29 (sun) | ABT-2024-11-03-BER (sun, below) | ABX-2026-07-15-SZG2 (overcast) | Mean |
|---|---|---|---|---|---|
| Fin navy | #162170 | #0A2E82 | #01187E | #21366C | #102777 |
| Fin star orange | #DC621C | #FF6916 | #FB5301 | #CF591D | #E95E14 |
| Azure crescent | #4D89CB | #35A0FA | #017DE3 | #72AEF2 | #3D95E6 |
| Sky (disc) | #8FAAE1 | #7FBBFB | #6AAFF8 (lighter pixels only) | #8EB3F0 | #82B2F1 |
| Sky (flat fin, lower LE) | #819DD6 | #86C0F8 | #71B3F8 | #759DDA | #7BABE8 |

  The chosen navy, azure and sky hexes below lie inside these spreads (verified). The chosen orange `#F36A1E` is a
  little lighter and yellower than every photo sample (G 106 vs 83–105, B 30 vs 1–29). It is a compromise toward the
  brand `#F47721`. For a photo match use `#EB5F16`, the mean of the checker's and the original samples.

| Name | Hex (use) | Where | Evidence (white-balanced samples) | Trust |
|---|---|---|---|---|
| ISR white | `#F4F5F7` | fuselage base, radome, tail cone, door outlines | reference white of every photo | high (assumed standard white) |
| ISR navy | `#12307F` | fin, rear navy shape, titles, nacelles, sharklet blade | fin: ABG #162376, ABT #01187C, SZG #04296F, ABW22 #0A2C7E (side), #2053AC (full sun); titles: ABW22 #2653AC, ABG #2F3180 (anti-aliased); nacelle: ABG #162576, ABW22 #0F4098, ABT #01147B. Brand: `#0F3766` (web dark navy), `#18549C` (logo, lighter end). (verified: checker mean #102777; the lighter ABW22 readings #2053AC are the sunlit fixed fin, the darker ones the deflected rudder) | medium: the hue is certain, the lightness is ±15% |
| ISR azure | `#4C92E0` | crescent ahead of the rear shapes, belly band, the small triangle at the aft-lower corner of the sky disc (§4 rear shapes 3a) | ABG #5190D5 / #5490D4, ABW22 #479DF3 (sun), ABT #017DE3 (corrected: was #3879C2; the crescent core in ABT is raw #0170CA). Belly (shade) is brighter than the navy in the same shade (belly photo: belly #1F3751 vs nacelle #02102B), consistent with azure (verified: #1F374E vs #01112C). In sun the crescent reads more saturated than the hex (ABW22 #35A0FA); the hex is kept as a mid value (verified within the spread). | medium |
| ISR sky | `#8AB7F1` | rear "disc" around door 4, fin LE root, fin top-aft corner | door region: ABG #97B5EE / #98B5EE, ABW22 #7DB8F5 / #82BFF5, ABT #6DB0F5 / #73B6F9, SZG #9FBDEE / #ABC5F2. Fin corner reads about 8% darker (ABG #85A4D5, ABW22 #619EF5, SZG #8CADE5). This is the same paint lit differently. (verified: the darker read is only on the rudder part of the corner. In ABW22 the fixed-fin part of the corner is #8DC7FA, the same as the lower-LE sky #86C0F8, while the rudder part is #63A0F8; the navy shows the same step, fixed fin #224DA4 vs rudder #092C7D. The rudder is slightly deflected.) | medium |
| ISR orange | `#F36A1E` | star (fin, titles, sharklet) | ABG #E96517 / #EB691D, ABW22 #FF6717, ABT #FB5300 / #F65000, SZG #FB6B06 / #F26605. Brand `#F47721`. Photos read redder than the brand value. (verified: checker mean #E95E14) | medium-high (brand `#F47721` is an acceptable alternative) |
| Wing grey | `#BDBFBF` | wings (upper and lower), wing-to-body fairing above the band, sharklet transition | ABW22 wing upper #B9BBB7 (sun) | medium |
| Tailplane grey | `#C8CACA` | horizontal stabiliser | ABW22 top between #A5A7A1 and #EDEEEE; ABG / SZG light grey | low-medium |
| Fence grey | `#C4C7C5` | wingtip fences | ABW22 #C1C4C0 / #E9E9E7; ABT and ABX light grey | medium |
| Bare metal | `#B5B9BD` / `#8C9094` | nacelle inlet lip / exhaust nozzle and plug | ABW22 engine close-up; ABG | medium |

## 4. Elements (side elevation)

The livery is **mirror-symmetric in its shapes**: the same d and f values apply on both sides. Only the title
lock-up and the star read the same on both sides. They are drawn unmirrored, so the word order relative to the nose
changes between sides (see *Titles*).

**Fuselage base.** ISR white everywhere not covered below: nose, radome, cabin, crown, and the tail cone aft of the
navy.

**Belly (azure).**

- In plan view (ABI-2025-08-18-belly-piki) the azure panel starts with a rounded front just aft of the nose-gear bay,
  at d ≈ 6.0 m (±0.7). The red lower beacon is inside it.
- Forward of the wing the panel is about half the fuselage width. It covers the whole underside of the wing-to-body
  fairing, then narrows again and runs aft into the navy rear shape at d ≈ 29.
- In side elevation it is a thin keel band:
  - it begins at d 6.0 (f 0);
  - it is f ≈ 0.07 (about 0.3 m) from d 7.5 to 13;
  - it rises smoothly to f ≈ 0.13 (about 0.55 m) along the fairing, from d 14 to 21;
  - it drops back to f ≈ 0.07 by d 23;
  - it stays at f ≈ 0.07 until d 28.9, where it runs into the navy.

  Evidence: ABG-2025-04-04 keel band is 15 px forward and 27 px on the fairing, at 44.5 px/m.
  (verified ±0.02 in ABG with local keel and crown: f 0.05 at d 7.5 growing to 0.09 at d 10.2; 0.11–0.12 at
  d 19–22; 0.07 at d 23.7. d 11–19 is hidden by the engine and gear.)
  (corrected: was "stays at f ≈ 0.07 until d 28.9". As the keel sweeps up, the band's top rises in local f: 0.07 at
  d 27.0, 0.13 at d 28.2, 0.16 at d 29.1, where it meets the white's aft corner and the navy. From there the
  navy/azure edge runs down and aft to the keel at d ≈ 29.7. ABG white-edge trace; SZG2 agrees, with the keel end
  at d 29.6–30.2.)
- The boundary is a straight, soft line with no curve upward at the ends. (verified for d 7.5–24; see the correction
  above for the aft end.)
- All frames show the band, including 4X-ABS in 2022 (verified: its fairing underside and forward keel band both read
  #4E5A6F in shade, with a sharp edge against the lit white).

**Rear shapes.** The rear is built from four fields. In order from the front: the azure crescent, the sky "disc"
with the navy wedge under it, then the navy band into the fin, then the white tail cone. All points are (d, f).
Measured in ABG-2025-04-04, cross-checked in ABT-2024-11-03-BER, ABF-2024-07-14-b and ABX-2026-07-15-SZG6.
The crown crossings agree within 0.3 m across photos. (verified; the checker also used ABX-2026-07-15-SZG2. Five
fields, not four: there is also a small azure triangle, item 3a.) f at the rear is the local f: the keel sweeps up
from d ≈ 24, so the local height at door 4 is only about 3.4 m.

1. **White / colour boundary** (the aft edge of the white).
   - It crosses the crown at **d 24.9** (ABG 24.94, ABT 24.86, ABF 24.98). This is 4.6 m ahead of the door-4 centre.
     (verified: ABG 24.93, SZG2 ≈ 24.9–25.1, ABT 24.8)
   - It sweeps down and aft in a concave curve that gets steeper lower down: (24.9, 1.00) → (25.8, 0.87) →
     (26.7, 0.75) → (27.7, 0.62) → (28.05, 0.50) → (28.5, 0.35) → (28.95, 0.18). It then meets the belly band.
     (verified ±0.2 m: ABG trace (25.9, 0.87), (26.35, 0.81), (26.86, 0.74), (27.99, 0.47), (28.46, 0.34),
     (28.84, 0.25), (29.1, 0.16) at the belly band.)
   - The aftmost cabin window (d ≈ 27.6) sits just inside the white. (verified: ABG d 27.47, touching the boundary)
2. **Azure crescent.**
   - It lies between boundary 1 and a nearly straight aft edge that runs from the crown at **d 27.1** (ABG 27.23,
     ABT 27.04, ABF 27.01) down to the crescent tip. The aft edge is slightly convex forward: (27.1, 1.0) →
     (27.35, 0.85) → (27.5, 0.72) → (27.7, 0.62). (verified: ABG 27.12 at the crown, SZG2 27.19, ABT 27.0; ABG
     aft edge (27.2, 0.87), (27.29, 0.81), (27.40, 0.74))
   - The tip is at **(27.7, 0.62)**, on the window line. (verified: ABG (27.5, 0.62), ±0.2 m)
   - It is 2.2 m wide at the crown and passes over the crown to the other side.
3. **Sky disc** (contains door 4 at d 29.53).
   - Forward edge: the crescent's aft edge.
   - Lower edge, against the navy wedge: (27.7, 0.62) → (28.4, 0.43) → (29.0, 0.32) → (29.7, 0.23) → (30.2, 0.20).
     (verified ±0.05 f: ABG (28.2, 0.48), (28.5, 0.43), (28.9, 0.39), (29.4, 0.33), then along the door-4 sill to
     (30.15, 0.24).)
   - Aft edge: a convex-aft arc (30.2, 0.20) → (30.9, 0.29) → (31.2, 0.39) → (31.45, 0.53) → (31.65, 0.68) →
     (31.8, 0.85) → (31.85, 1.00). (verified for f ≥ 0.35: ABG crown 31.73, SZG2 31.76; corrected at the bottom:
     the sky ends on the line (30.15, 0.24) → (31.1, 0.30); below that line is the azure triangle 3a, not sky.)
   - The arc continues up into the fin: fin(0.41, 0) → (0.39, 0.07) → (0.30, 0.14) → (0.12, 0.215) → (0, 0.265).
     The sky therefore also covers the dorsal fillet and the fin LE up to 27% of the fin height (ABG 0.265,
     ABF 0.26). (corrected: those u values belong to the old trapezoid, LE root 29.5. Measured in d, the edge is
     almost vertical at d 31.7–31.8 from the crown up to h 0.17, then curves forward to the LE at h 0.265 (ABG).
     On the corrected trapezoid (Conventions) that is fin(0.33, 0) → (0.28, 0.07) → (0.22, 0.14) → (0.14, 0.20) →
     (0.08, 0.24) → (0, 0.265). The top at h 0.265 is verified.)
   - Door 4 has a thin white outline (about 5 cm, seal/frame) that shows on the sky. (verified: a light frame of
     3–4 px in ABG, 7–9 cm, all round the door)
3a. **Azure triangle** (added by the checker; ISR azure). It sits at the aft-lower corner of the sky disc, aft of the
   door-4 sill, on both sides. Its vertices are (30.15, 0.24) (the forward tip, just aft of the sill's aft corner),
   (31.1, 0.30) (upper aft, where the navy band's lower end meets the white tail cone) and (30.8, 0.16) (lower aft, the
   white tail cone's forward-lower corner). Its edges are straight. It reads as a deeper, more saturated blue than the
   sky above it, with a sharp edge between them (ABG sliver hue R/B 0.35 vs sky 0.55). About 1 m long and 0.4 m tall.
   Evidence: ABG-2025-04-04 (x 389–432, y 691–712), ABT-2024-11-03-BER (d 30.2 / 31.1 / 30.7) and
   ABX-2026-07-15-SZG2.
4. **Navy tail shape** (ISR navy; the fin colour continues onto the fuselage).
   - Its forward edge is boundary 1 below the crescent tip, so a **navy wedge** points up and forward to (27.7, 0.62),
     between the white and the sky disc. (verified: 0.2 m wide at f 0.5, 0.66 m at f 0.4, ABG)
   - The wedge widens into a navy pool on the lower rear fuselage from d 28.9 to about 30.4. This pool joins the
     belly band. (corrected: the pool starts where the belly band ends, on the diagonal from (29.1, 0.16) to the keel
     at d 29.7. Aft, it does not stop at d 30.4: it continues along the keel, under the white tail cone, and tapers to
     nothing at d ≈ 31.9. See 5.)
   - Above the pool, the navy is a band that hugs the disc's aft arc.
   - The band is widest under the fin. At the crown it runs from d 31.85 to the fin TE root, about 35.0. (verified:
     ABG 31.75–34.8; the navy continues up the fin TE, whose line reaches the crown at 35.5.)
   - It pinches to about 0.4–0.6 m where it passes just ahead of the tailplane root leading edge (f 0.4–0.6).
     (verified: ABG 0.6 m at f 0.6)
5. **Tail-cone line** (the aft edge of the navy; white aft of it).
   - It starts on the fin TE just above the root, at fin h ≈ 0.07 (d ≈ 35.0). (verified: ABG h 0.08–0.09)
   - It runs down and forward, passing just ahead of and below the tailplane root LE:
     (35.0, 0.95) → (33.7, 0.79) → (32.2, 0.63) → (31.7, 0.42) → (31.3, 0.33) → (30.9, 0.16) → (30.4, 0.13) → keel
     at d ≈ 30.2. (corrected below f 0.33: was "(30.9, 0.16) → (30.4, 0.13) → keel at d ≈ 30.2". The navy band
     ends at (31.1, 0.30). The white then borders the azure triangle down to (30.8, 0.16). From that corner the
     white's lower edge runs aft and down: (30.8, 0.16) → (31.3, 0.10) → (31.8, 0.02) → keel at d ≈ 31.9, with navy
     below it. ABG: navy 0.3 m tall under the white at d 31.3, 0.07 m at d 31.8. ABT: navy meets the keel at 31.8.
     SZG2: 32.1.)
   - ABG shows this line slightly concave. SZG shows it nearly straight from (35.5, 1.0) to (30.7, 0.13). Either
     reading is within ±0.5 m.
   - The tail cone, the APU exhaust area and the underside aft of d 30.2 are white. (corrected: the underside is
     white aft of d ≈ 31.9)

**Titles.** The lock-up is "ישראייר ★ ISRAIR": Hebrew word, orange star, Latin word, on one baseline.

- The glyphs are exactly those of `logos/Israir_Airlines_Logo.svg`: a heavy italic sans for both scripts, with
  forward-leaning (right-slanted) italics as in the logo, and the star emblem. (corrected wording: was
  "forward-leaning". Both scripts slant with the top to the right as seen, 12° in the logo. Because the block is
  unmirrored, the letters lean forward on the right side and aft on the left side. Verified in ABG and ABT.)
- Text colour is ISR navy. The star is ISR orange with its swoosh cut showing the white fuselage. (verified)
- Placement is above the window row, starting just aft of door 1. It runs from **d 6.0 to d 14.3**, ending before the
  overwing exits. (corrected: the aft word ends right above the forward overwing exit, not before it. ABG: title
  end 14.40, exit centre 14.32. SZG2: 14.36 and 14.37.)
- Baseline at **f 0.76** (3.14 m above the keel, about 0.46 m above the window centre line). Latin cap top at
  **f 0.874** (3.62 m), level with the top of door 1. (verified: ABG baseline 0.761, cap top 0.883, door-1 top 0.875)
- Side-elevation heights: Latin caps **0.50 m**, Hebrew letters 0.54 m, star 0.86–0.95 m (f 0.71–0.92, centre f 0.81).
  (verified: caps 0.50 m in ABG and SZG2, Hebrew 0.52 m. Corrected for the star: its thin top and bottom tips reach
  f 0.69–0.93, so the star is about 1.0 m tall (ABG 44–46 px) and 1.2 m wide (51–54 px). Centre f 0.81 is verified.)
- On the real curved surface the lettering is about 0.62–0.65 m high.
- Horizontal extents (side elevation). Each word is about 3.2 m long, the star is about 1.15–1.2 m wide, and each gap
  is about 0.3–0.4 m. These gaps are wider than in the logo file (logo gap ≈ 0.2 m at this scale). (verified)
- The title star is the logo star, upright, with the loop at the upper right on both sides (verified in the ABG and
  ABT close-ups). In side elevation its width to height ratio is about 1.2, the logo's 0.878 compressed vertically
  by about 0.73.

| Side | Forward word (d) | Star (d) | Aft word (d) | Evidence |
|---|---|---|---|---|
| Left (nose left) | Hebrew 6.0–9.3 | 9.55–10.8 | ISRAIR 11.1–14.3 | ABT 6.07–9.36 / 9.69–10.86 / 11.23–14.38; ABF 5.94–9.28 / 9.43–10.72 / 10.94–14.16; (verified) checker ABT, de-rotated: 5.97–9.29 / 9.66–10.81 / 11.16–14.29 |
| Right (nose right) | ISRAIR 6.1–9.2 | 9.55–10.7 | Hebrew 11.05–14.3 | ABG 6.09–9.19 / 9.55–10.69 / 11.07–14.31; (verified) checker ABG 6.03–9.17 / 9.47–10.71 / 11.00–14.40; SZG2 (2026) 6.13–9.28 / 9.65–10.70 / 11.03–14.36 |

- On both sides the block reads left-to-right "ישראייר ★ ISRAIR" when you face that side. Draw the block unmirrored.
  On the left the Hebrew is forward. On the right "ISRAIR" is forward. (verified: ABT, ABF-b, SZG6 left; ABG, ABW22,
  SZG2 right)
- When drawing from the SVG parts, use a non-uniform scale:
  - horizontal: 0.0445 m per logo unit (ISRAIR = 70.4 units → 3.13 m); (verified: 3.13–3.15 m in ABT, ABG, SZG2)
  - vertical: 0.78 of the horizontal scale (0.0347 m per unit → caps 0.50 m);
  - star: draw it into the explicit box above (about 1.15 × 0.9 m). On the aircraft it is smaller relative to the
    letters than in the logo lock-up. (corrected: box about 1.2 × 1.0 m, f 0.69–0.93. The star is 2.0 × the cap
    height against 2.3 × in the logo, so it is only slightly smaller.)
- The registration, "IATA", "AIRBUS A320", the small Israeli-flag and stencil markings are not modelled.

**Fin.**

- Base: ISR navy.
- **Top-aft corner** is ISR sky. Its boundary is a curved line from the tip at u 0.08 to the TE at h 0.71, bowing
  toward the corner through (0.76, 0.85). So the sky covers almost the whole tip chord and the top 29% of the TE.
  Evidence: ABG 0.08 / 0.71, ABW22 about 0.74, ABF and ABT the same shape. (verified: ABG navy touches the tip only
  at the rounded LE corner (u ≤ 0.1). The edge meets the TE at h 0.69 and passes (0.72, 0.84). The same paint as the
  lower-LE sky, see §3.)
- **Lower LE** is ISR sky, as part of the disc; see rear shapes 3.
- **Star emblem**: `logos/israir-star.svg`, ISR orange.
  - It is upright (points up and down), with the swoosh loop at the upper right, exactly as in the logo. (verified:
    ABG top tip x 254.5, bottom tip x 250, 1.4° off vertical; ABT 2.8°)
  - It is **not mirrored**: the same on both sides. The loop therefore faces aft on the left side and forward on the
    right side. Evidence: ABF-2024-07-14-b / ABT-2024-11-03-BER (left) vs ABG-2025-04-04 / ABW-2022-12-29 (right).
    (verified)
  - Its bounding box is centre fin(u 0.62, h 0.40), about d 34.2 and 2.4 m above the crown. Height **0.70 × fin
    height** (4.2 m). Width 0.89 × its height (3.75 m). (verified: ABG bbox 168–335 × 398–586 px, so centre d 34.21,
    h 0.40, 4.23 × 3.76 m. Corrected for u: 0.62 holds only on the old trapezoid. On the measured fin (LE d 32.0,
    TE d 36.1 at h 0.40) the centre is at **u 0.54**. Place it by d 34.2.)
  - Its lowest point is at h ≈ 0.05. Its aft-upper point touches the fin TE (ABG, ABT). (lowest point verified,
    h 0.05. Corrected: the aft point comes within about 0.3 m of the TE but does not touch it. ABG gap 14 px at
    y 441; ABT gap about 16 px.)
  - The swoosh cut shows the navy fin. (verified)
- There is no other art. The navy continues under the fin root onto the fuselage (rear shapes 4). The sky continues
  from the fin LE root into the fuselage disc.

**Tail cone.** White aft of the tail-cone line. The APU exhaust is bare metal.

**Horizontal stabiliser.** Light grey (`#C8CACA`), plain.

**Wings.** Airbus light grey (`#BDBFBF`), with no paint features. The registration on the lower left wing is not
modelled.

**Engine nacelles** (IAE V2500-A5; both engines alike; both faces alike).

- The whole nacelle (inlet cowl, fan cowl, reverser and aft cowl) is ISR navy. (verified)
- The inlet lip is bare metal, a ring about 0.2 m deep. The last about 0.4 m (common nozzle) and the exhaust plug are
  bare metal grey. (lip verified: ABG 10 px, 0.22 m. Corrected for the nozzle: the bare-metal common nozzle that
  sticks out aft of the navy reverser cowl is about 0.9–1.0 m long in side elevation (ABG row y 790: navy ends at
  x 1114, metal to x 1072, 42 px). The exhaust plug sticks out behind it; in ABG it is dark and partly hidden, so its
  length is not measured. ABW22 shows the same long cylindrical metal nozzle.)
- There are no logos or titles, only small red/white warning stencils. The pylon is wing grey. (verified)
- Evidence: ABW-2022-12-29 (right engine, open cowls), ABG-2025-04-04, ABF-2024-07-14-a. Inboard faces: the far
  engine in ABI-2024-04-16-a is navy too (verified).

**Wingtip devices.**

- *Fences* (7 aircraft): plain fence grey on both faces, no logos (ABT-2024-11-03-BER, ABX-2025-11-28). (verified:
  outer faces in ABT, ABS-2022 and ABX-2025; no photo shows a fence's inner face closely, so "both faces" is assumed)
- *Sharklets* (4X-ABI):
  - The vertical blade is ISR navy. (verified)
  - The leading-edge erosion strip is light grey, about 10% of the chord. (the grey strip reads 20–30% of the visible
    width in the oblique views of ABI-2024-04-16-c, but the view includes the curved LE. Use 10–15% (low confidence).)
  - The lower curved transition, the bottom 25% of the height, is wing grey. (verified: navy ends at 24% of the height,
    ABI-c left)
  - An **orange star** (logo star, upright) is on **both the outer and the inner face**. Its centre is at about 47% of
    the sharklet height, and its height is about 0.28 × the sharklet height (≈0.7 m). (verified: ABI-c left outer
    face, centre 46%, height 0.29; right inner face shows the star too; ABI-2018-06-02 shows the right outer face)
  - Evidence: ABI-2024-04-16-c (left outer face and right inner face), ABI-2024-04-16-a (inner), ABI-2024-04-16-b
    (outer), ps/4X-ABI.

**Nose.** White radome with no nose band. The cockpit glass is the model's.

**Anything else.** There is no crown stripe and no cheatline. Door 1 and the forward doors are on white. Only door 4
(both sides) shows the white outline, on the sky disc. (verified)

## 5. Side-elevation drawing steps

Painter's order, using the kit terms. Colours are from §3.

**LEFT side (nose left).**

1. `fill` the whole body and fin with ISR white `#F4F5F7`.
2. Belly band, ISR azure `#4C92E0`: fill below f_b(d). f_b = 0 at d 6.0, rises to 0.07 by d 7.5, stays 0.07 to d 13,
   rises smoothly to 0.13 by d 14, stays 0.13 to d 21, falls to 0.07 by d 23, stays 0.07 to d 29.5.
   (corrected aft end: stays 0.07 to d 27.0, then rises to 0.13 at d 28.2 and 0.16 at d 29.1, and runs to d 29.7.
   Step 3 paints the navy over its aft end.)
3. Navy tail shape, ISR navy `#12307F`.
   - `poly` (d, f) through: (24.9, 1.00), (25.8, 0.87), (26.7, 0.75), (27.7, 0.62), (28.05, 0.50), (28.5, 0.35),
     (28.95, 0.18), (28.95, 0.0), (30.2, 0.0), (30.4, 0.13), (30.9, 0.16), (31.3, 0.33), (31.7, 0.42),
     (32.2, 0.63), (33.7, 0.79), (35.0, 0.95), fin TE at h 0.07, then up the fin TE to the tip, across the tip, down
     the fin LE and dorsal fillet to the crown, then forward along the crown back to (24.9, 1.00).
   - (corrected: replace the run "(28.95, 0.18), (28.95, 0.0), (30.2, 0.0), (30.4, 0.13), (30.9, 0.16), (31.3, 0.33)"
     with "(28.95, 0.18), (29.1, 0.16), (29.7, 0.0), (31.9, 0.0), (31.8, 0.02), (31.3, 0.10), (30.8, 0.16),
     (31.1, 0.30), (31.3, 0.33)". The navy/belly edge is a diagonal, and the navy runs along the keel under the
     white tail cone to d 31.9. The small area inside (30.8, 0.16)–(31.1, 0.30) is repainted azure in step 5b.)
   - In short: `finFill` navy plus this body polygon. Smooth the corners with Q curves; every boundary in this livery
     is curved.
4. Azure crescent, `#4C92E0`: `poly` (24.9, 1.0), (25.8, 0.87), (26.7, 0.75), (27.7, 0.62), (27.5, 0.72),
   (27.35, 0.85), (27.1, 1.0).
5. Sky disc, ISR sky `#8AB7F1`, painted over the navy.
   - Path: (27.1, 1.0) → (27.35, 0.85) → (27.5, 0.72) → (27.7, 0.62) → (28.4, 0.43) → (29.0, 0.32) → (29.7, 0.23) →
     (30.2, 0.20) → (30.9, 0.29) → (31.2, 0.39) → (31.45, 0.53) → (31.65, 0.68) → (31.8, 0.85) → (31.85, 1.0).
     (corrected bottom: replace "(29.7, 0.23) → (30.2, 0.20) → (30.9, 0.29)" with "(29.7, 0.26) → (30.15, 0.24) →
     (31.1, 0.30)". The sky ends on the straight upper edge of the azure triangle.)
   - Continue onto the fin: fin(0.41, 0) → fin(0.39, 0.07) → fin(0.30, 0.14) → fin(0.12, 0.215) → fin(0, 0.265).
     (corrected, on the corrected trapezoid: fin(0.33, 0) → (0.28, 0.07) → (0.22, 0.14) → (0.14, 0.20) →
     (0.08, 0.24) → (0, 0.265). In d, the edge is at 31.7–31.8 up to h 0.17.)
   - Then run down the fin LE and dorsal fillet to the crown, and forward along the crown to (27.1, 1.0).
   - Use a smooth curve (C/Q) through these points: the aft edge is a near-circular arc.
5b. Azure triangle (added by the checker), ISR azure `#4C92E0`: `poly` (30.15, 0.24), (31.1, 0.30), (30.8, 0.16).
   Use straight edges.
6. Door 4 outline: 5 cm white `stripe` around the door-4 cut-out (optional). (measured 7–9 cm, verified)
7. Fin top-aft corner, sky: `finPoly` fin(0.08, 1.0) → fin(1, 1) → fin(1, 0.71) → curve through fin(0.76, 0.85) back to
   fin(0.08, 1.0). (verified: ABG (0.72, 0.84), TE at h 0.69)
8. Fin star: `image` `logos/israir-star.svg`, orange as in the file. Centre fin(0.62, 0.40), height 0.70 × fin
   height, keep aspect (w = 0.87 h), not mirrored. (corrected: centre fin(0.54, 0.40) on the corrected trapezoid,
   which is d 34.2. The SVG aspect is w = 0.878 h; measured 0.89. Keep 0.3 m clear of the TE.)
9. Titles, all on baseline f 0.76:
   - `image` `logos/israir-title-hebrew.svg`, recoloured ISR navy, box d 6.0–9.3, f 0.758–0.887 (0.54 m tall).
   - `image` `logos/israir-star.svg`, box d 9.55–10.8, f 0.71–0.92. (corrected: f 0.69–0.93)
   - `image` `logos/israir-title-latin.svg`, recoloured ISR navy, box d 11.1–14.3, f 0.758–0.874 (0.50 m).
   - Draw them unmirrored, stretching each part to its box.
10. Engine atlas: fill ISR navy. Inlet lip: bare metal `#B5B9BD`, front 0.2 m. Nozzle: aft 0.4 m `#8C9094`.
    (corrected: nozzle aft 0.9–1.0 m `#8C9094`, plus the exhaust plug)
11. Winglet atlas:
    - Fences: fence grey on both halves.
    - Sharklets: navy blade above 25% height; wing-grey transition below; light-grey LE strip; orange star centred at
      47% height, 0.28 × height, on both halves.
12. Flat colours: wing `#BDBFBF`, stab `#C8CACA`.

**RIGHT side (nose right): differences only.**

- Steps 1–8, 10–12 are the same, with the same d and f values (mirror-symmetric shapes). This includes step 5b.
  (verified: crown crossings, titles and the azure triangle match between ABT (left) and ABG / SZG2 (right)
  within 0.2 m)
- The fin star is again drawn unmirrored, so its loop is toward the LE on this side.
- Step 9 order changes (still unmirrored, reading left to right):
  - `israir-title-latin.svg` at d 6.1–9.2;
  - star at d 9.55–10.7;
  - `israir-title-hebrew.svg` at d 11.05–14.3.
- Heights and baseline are the same as on the left.

## 6. Logos and wordmarks

| Graphic | Commons file | Licence | Status |
|---|---|---|---|
| Title lock-up (Hebrew + star + ISRAIR) | https://commons.wikimedia.org/wiki/File:Israir_Airlines_Logo.svg | {{PD-logo}}, which redirects to **{{PD-textlogo}}** (public domain, below the threshold of originality). Author "Israir Airlines Ltd.", source israir.co.il, 2024-04-06 (verified 2026-09-29: the page wikitext has `{{PD-logo}}`, Template:PD-logo redirects to Template:PD-textlogo, and extmetadata says "Public domain". PD-textlogo covers copyright only: trademark rights remain.) | downloaded: `logos/Israir_Airlines_Logo.svg` (verified: SHA-1 92cd6157… is identical to the current Commons original) |
| Star emblem (fin, title star, sharklet) | same file, orange `#F47721` path | PD-textlogo (as above) | derived: `logos/israir-star.svg` (the orange path only, viewBox cropped, path unchanged) (verified: all elements of the 3 derived files are byte-identical to elements of the source; viewBoxes fit the ink) |
| "ISRAIR" wordmark | same file | PD-textlogo | derived: `logos/israir-title-latin.svg` |
| "ישראייר" wordmark | same file | PD-textlogo | derived: `logos/israir-title-hebrew.svg` |

- The fin emblem is the same star as in the logo file, with the same swoosh and loop, verified against
  ABG-2025-04-04, so no other emblem file is needed.
- Font fallback, only if the SVG cannot be used:
  - "ISRAIR": Montserrat ExtraBold Italic (OFL, Google Fonts), all caps, tracking about 0.
  - Hebrew: Heebo ExtraBold (OFL), with a synthetic 12° oblique leaning in the reading direction of the logo (the
    logo's Hebrew leans the same way as the Latin italics). (corrected wording: "in the reading direction" would
    mean leaning left for Hebrew. The logo's Hebrew slants with the top to the right, like the Latin, 12°.)
- The SVG is preferred: it is the exact artwork.

## 7. Geometry facts for the model

- **Type:** A320-232 (all 8). Engines: IAE V2500-A5.
  - The nacelle is long-duct with a mixed-flow common nozzle, and has no chevrons.
  - It is slimmer and longer-looking than a CFM56-5, and sits higher: nacelle low point 0.76 m above ground vs 0.58 m
    for the CFM56 (A320 AC, ground clearances).
  - Check that the `a320` model's nacelle reads as a V2500. If it is a CFM56-5B shape, a V2500 variant (longer,
    more cylindrical, conical tail plug) would be more faithful.
- **Wingtip fences** (4X-ABF, ABG, ABS, ABT, ABW, ABX, ABY):
  - Span 34.10 m.
  - Fence total height about 0.97 m: AC "wing tip fence top" 4.767 m vs "fence bottom" 3.795 m above ground. About
    0.6 m is above the wing and 0.35 m below.
  - Arrowhead planform, chord about 1.1–1.4 m (ABT-2024-11-03-BER).
- **Sharklets** (4X-ABI only): span 35.80 m, sharklet height about 2.43 m (AC).
  - This needs a sharklet variant of `a320` for that one airframe. Alternatively accept fences, since the livery is
    per airline, not per registration.
  - The painted design on the sharklet is in §4/§5.
- **Fin:** about 6.0 m above the crown (AC: fin tip 11.996 m, aft crown 6.001 m above ground). Root TE at d ≈ 35.0 m;
  tip at d 35.1–37.0 m. The measured values agree with the AC. (height verified: ABG 270 px, 6.07 m. Corrected: the
  TE line reaches the crown at d ≈ 35.5 and the straight LE line at d ≈ 30.0; see Conventions.)
- **Engine nozzle:** the bare-metal V2500 common nozzle is about 0.9–1.0 m long in side elevation (added by checker).
- Nothing else differs from a generic A320ceo. There are no extra antennas that are relevant for paint.

## 8. Confidence and open questions

**High confidence.**

- The scheme and its elements: white base, bilingual title block and its position, navy fin with the orange star
  (unmirrored), sky top-aft fin corner and sky LE root, rear azure / sky / navy composition, azure belly.
- Navy engines with bare-metal lip.
- Fence vs sharklet per registration.
- The logo file licence.
- The scheme has been unchanged since 2010.
- (verified, all five items above: the checker re-checked the livery items in ABG-2025-04-04, ABT-2024-11-03-BER,
  the 2026 photo ABX-2026-07-15-SZG2 and the 2011 photo ABG-2011-08-16, and the licence in the Commons page source.)

**Medium confidence.**

- Exact rear curves, ±0.3 m at the crown crossings and ±0.5 m for the lower tail-cone line. ABG shows it slightly
  concave, SZG straight. (verified: the crown crossings agree within 0.15 m in ABG, SZG2 and ABT)
- The azure triangle 3a (±0.2 m; seen on both sides in three photos) and the navy running along the keel under the tail
  cone to d ≈ 31.9 (±0.2; seen in ABG, ABT, SZG2, all from ground level or below, so the camera sees part of the
  underside).
- Belly-band height f 0.07 / 0.13 and its start at d ≈ 6 (±0.7).
- Paint hexes, ±10–15% lightness from camera and white-balance differences. The navy is the least certain: photos
  range from `#01187C` to `#2053AC`. (the lighter end is the sunlit fixed fin; the rudder, slightly deflected, reads
  darker. Both are the same paint.)
- The azure belly colour. It is inferred from shaded views; no sunlit belly photo exists. (partly corrected: the
  band's top edge is sunlit in ABW-2022-12-29 at #4784CF, which is consistent with azure.)
- Fin (u, h) values. They depend on the fin outline. The checker moved the fin LE root from 29.5 to 30.0 and the TE
  root from 35.0 to 35.5, which changes u by up to 0.1. The d and h values are the measured ones.

**Low confidence.**

- Tailplane grey (white vs grey).
- Sharklet star size and position (small in all photos).
- The exact grey of the sharklet LE and transition.

**Open questions.**

1. Why the recent planespotters photo of 4X-ABF shows no fuselage titles (repaint in progress, or a lease), and
   whether that is still true.
2. Whether the SkiDeal (4X-ABT), #Bringthemhome (4X-ABI) and IFCJ (4X-ABS) marks are still carried. The recommendation
   is to ignore them.
3. LY-TEN operator and paint: no API photo. (partly answered: the operator is GetJet Airlines, A320-214 msn 3817. The
   paint is still not seen.)
4. Israir's 2 × A330-200 (ex-American, 2025–26) are outside this survey key. Their livery is not researched here.

Sources (web):

- World Airline News, "Israir Airlines introduces a new livery", 2010-06-17:
  https://worldairlinenews.com/2010/06/17/israir-airlines-introduces-a-new-livery/
- Wikipedia "Israir" (fleet): https://en.wikipedia.org/wiki/Israir
- Airbus A320 Aircraft Characteristics – Airport and Maintenance Planning (Jun 2024):
  https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2025-01/AC_A320_0624.pdf
- israir.co.il home page stylesheets (brand colours), fetched 2026-09-29.
- (added by checker) airfleets.net, 4X-ABS msn 2728: https://www.airfleets.net/ficheapp/plane-a320-2728.htm ;
  LY-TEN (GetJet, msn 3817): https://www.flightradar24.com/data/aircraft/ly-ten ,
  https://www.airfleets.net/ficheapp/plane-a320-3817.htm
- (added by checker) Commons API, File:Israir_Airlines_Logo.svg wikitext and Template:PD-logo redirect, read
  2026-09-29.
