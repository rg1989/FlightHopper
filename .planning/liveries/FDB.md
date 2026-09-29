# flydubai (FDB) — Boeing 737-8 (B38M) livery dossier

Research date: 2026-09-29. Refs folder: `data/livery-refs/FDB/` (git-ignored). All paths below that start with
`commons/`, `ps/` or `logos/` are relative to that folder. Every fact comes from a named photo. I looked at each
photo (full frame plus zoomed crops), and I measured colours and positions from its pixels.

**Independent check (2026-09-29):** a second agent re-opened every photo, re-sampled the colours, re-measured the
positions and read the Commons licence pages. Each checked claim is marked **(verified)** or **(corrected: was ...)**.
A summary is in §9.

Coordinate convention used throughout (side elevation, the same for both sides):

- **z** = metres aft of the nose tip (0 = radome tip; 39.5 = tail-cone tip).
- **h** = metres above the keel of the constant-section fuselage (0 = lowest line of the main fuselage;
  crown = 4.0).
- Fin art uses normalised fin coordinates: **v** = 0 at the fin root (h ≈ 4.2) to 1 at the fin tip (h ≈ 11.25);
  **u** = 0 at the leading edge to 1 at the trailing edge, measured along the local chord at that height.

Scale source: `commons/A6-FML_left_2022.jpg` (a near-perpendicular telephoto taxi shot). In it, nose tip x = 32.5 px
and tail-cone tip x = 1140 px, so 1107.5 px = 39.52 m, which is 28.0 px/m. The keel is at y = 424 px and the crown
at y = 312 px (112 px = 4.01 m, which is consistent). For the right side I used `commons/A6-FMA_right_2018.jpg`
(26.3 px/m), with positions cross-checked against doors R1/R2.

---

## 1. Identity

**Scheme:** the standard flydubai livery. It has been in use since the airline launched in 2009 (the same design
on 737-800, 737-8 and 737-9) and is still current on every tracked 737-8 (verified: all 23 API thumbnails
re-inspected; A6-FED 2013 (737-800) and A6-FNC 2022 (737-9) carry the same art; a web search on 2026-09-29 found no
new standard livery, only specials). Its parts:

- white fuselage;
- the "flydubai" title ("fly" in orange, "dubai" in blue, with an orange dot);
- an orange stripe and blue swoosh bands that wrap the aft fuselage;
- a navy lower tail cone;
- an abstract fin of blue bands, white arcs and orange. **The fin art is different on the left and right sides.**
  Infinite Flight users reported the same thing ("all FlyDubai planes right tail differs from the left one",
  community.infiniteflight.com/t/flydubai-livery-mistakes/296023), and I confirmed it in every photo below;
- AT winglets: orange on the outboard face, blue with the wordmark ("fly" and disc orange, "dubai" white) on the
  inboard face (verified: A6-FMH_below-left right tip, A6-FML and A6-FMA far winglets).

The fleet shows no newer "2020s" livery. The only exceptions are temporary specials (see below).

All 23 tracked aircraft (`B38M FDB` in regs-survey.json) wear the standard scheme in their current planespotters
API photo (verified: hexes, sample counts and photo ids/links/photographers match regs-survey.json and `api/*.json`;
every thumbnail re-inspected):

| Registration | Hex | Survey samples | Scheme | Evidence photo | Photo date |
|---|---|---|---|---|---|
| A6-FKN | 896604 | 130 | standard | ps/A6-FKN_1582614.jpg (3/4 front right) | n/a (API) |
| A6-FKI | 8965D4 | 96 | standard | ps/A6-FKI_1788855.jpg (left) | n/a |
| A6-FKL | 8965D7 | 87 | standard | ps/A6-FKL_1576462.jpg (left) | n/a |
| A6-FKF | 8965D1 | 67 | standard | ps/A6-FKF_1911180.jpg (left) | n/a |
| A6-FKT | 89660A | 50 | standard | ps/A6-FKT_1702692.jpg (left) | n/a |
| A6-FKK | 8965D6 | 47 | standard | ps/A6-FKK_1598415.jpg (right) | n/a |
| A6-FKC | 8965CE | 31 | standard | ps/A6-FKC_1698547.jpg (left) | n/a |
| A6-FMZ | 8965B6 | 30 | standard | ps/A6-FMZ_1929591.jpg (left) | n/a |
| A6-FMO | 896555 | 29 | standard | ps/A6-FMO_1971380.jpg (right) | n/a |
| A6-FKO | 896605 | 27 | standard | ps/A6-FKO_1769265.jpg (left) | n/a |
| A6-FKD | 8965CF | 27 | standard | ps/A6-FKD_1416980.jpg (left) | n/a |
| A6-FKE | 8965D0 | 26 | standard | ps/A6-FKE_1643547.jpg (left) | n/a |
| A6-FMH | 896517 | 26 | standard | ps/A6-FMH_1898465.jpg; commons/A6-FMH_right_2024.jpg; commons/A6-FMH_below-left_2021.jpg | 2024-06-11 / 2021-12-05 |
| A6-FKR | 896608 | 25 | standard | ps/A6-FKR_1610511.jpg (left) | n/a |
| A6-FKJ | 8965D5 | 23 | standard | ps/A6-FKJ_1685904.jpg (3/4 right) | n/a |
| A6-FKB | 8965CD | 22 | standard now (special in 2022, see below) | ps/A6-FKB_1767321.jpg (3/4 front right, night) | n/a |
| A6-FKH | 8965D3 | 19 | standard | ps/A6-FKH_1859023.jpg (left) | n/a |
| A6-FMB | 8964D1 | 9 | standard | ps/A6-FMB_1974432.jpg; commons/A6-FMB_left_2018.jpg | n/a / 2018-10-24 |
| A6-FMN | 896556 | 5 | standard | ps/A6-FMN_1813360.jpg; commons/A6-FMN_belly_2024.jpg | n/a / 2024-06-18 |
| A6-FKM | 896603 | 3 | standard | ps/A6-FKM_1827878.jpg (right) | n/a |
| A6-FKA | 8965CC | 2 | standard in API photo (special in 2022, see below) | ps/A6-FKA_1550625.jpg (3/4 below left) | n/a |
| A6-FMG | 896512 | 1 | standard | ps/A6-FMG_1908865.jpg; commons/A6-FMG_front_2024.jpg | n/a / 2024-08-15 |
| A6-FMA | 8964D0 | 1 | standard | ps/A6-FMA_1710481.jpg; commons/A6-FMA_right_2018.jpg | n/a / 2018-10-28 |

**Exceptions / specials**

- **A6-FKA and A6-FKB** received an Argentina national football team (AFA) special livery for the 2022 World Cup
  shuttle: player artwork from 18 Nov 2022, then a "Campeón" / three-star version from Dec 2022. Sources:
  news.flydubai.com (2022-11-18 release), simpleflying.com, aviationweek.com. The artwork was added on top of the
  standard flydubai scheme. The current API photos of both aircraft show the plain standard scheme, but I could not
  date them. Paint both as standard.
- **A6-FMI and A6-FMK** had a temporary "50 YEARS OF UNITY" UAE-anniversary decal on the right engine nacelle in
  March 2022 (`commons/A6-FMI_right_2022.jpg`, `commons/A6-FMK_right_2022.jpg`) (corrected: was A6-FMI only). A6-FMW,
  photographed the same day, has a plain nacelle. The decal is not part of the scheme; ignore it.
- A6-FPC (not tracked) has a 15th-anniversary special (2024) (verified: aerotime.aero, aviationa2z.com). No tracked
  aircraft is leased in or out in another scheme.

## 2. Reference images

Commons photos are 1200–1920 px wide. Planespotters photos are API `thumbnail_large` (≈498×280), for reference only.

| File | View | Reg | Source | Author | Licence |
|---|---|---|---|---|---|
| commons/A6-FML_left_2022.jpg | left side (taxi, sunlit) — **primary left** | A6-FML | https://commons.wikimedia.org/wiki/File:A6-FML_@_DXB,_2022-03-30.jpg | Anna Zvereva | CC BY-SA 2.0 |
| commons/A6-FMD_left_2024.jpg | left side (taxi, overcast) | A6-FMD | https://commons.wikimedia.org/wiki/File:A6-FMD_@_PRG,_2024-08-28.jpg | Anna Zvereva | CC BY-SA 2.0 |
| commons/A6-FMA_left_takeoff_2018.jpg | left side (rotation) | A6-FMA | https://commons.wikimedia.org/wiki/File:FlyDubai,_A6-FMA,_Boeing_737-8_MAX_(45620442622).jpg | Anna Zvereva | CC BY-SA 2.0 |
| commons/A6-FMB_left_2018.jpg | left side (landing) | A6-FMB | https://commons.wikimedia.org/wiki/File:FlyDubai,_A6-FMB,_Boeing_737-8_MAX_(30728990597).jpg | Anna Zvereva | CC BY-SA 2.0 |
| commons/A6-MAX_left_2021.jpg | left side (landing) | A6-MAX | https://commons.wikimedia.org/wiki/File:Flydubai,_A6-MAX,_Boeing_737-8_MAX_(51678021177).jpg | Anna Zvereva | CC BY-SA 2.0 |
| commons/A6-FMH_below-left_2021.jpg | 3/4 below left (climb) — both winglet faces, engines, belly | A6-FMH | https://commons.wikimedia.org/wiki/File:TLV-FlyDubai_Boeing_737_MAX8_A6-FMH.jpg | ronen fefer | CC BY-SA 2.0 |
| commons/A6-FNC_737-9_left_2022.jpg | left side (737-9, same scheme) | A6-FNC | https://commons.wikimedia.org/wiki/File:A6-FNC_@_DXB,_2022-03-28.jpg | Anna Zvereva | CC BY-SA 2.0 |
| commons/A6-FMA_right_2018.jpg | right side (taxi, overcast) — **primary right** | A6-FMA | https://commons.wikimedia.org/wiki/File:FlyDubai,_A6-FMA,_Boeing_737-8_MAX_(45620442302).jpg | Anna Zvereva | CC BY-SA 2.0 |
| commons/A6-FMI_right_2022.jpg | right side (landing) | A6-FMI | https://commons.wikimedia.org/wiki/File:A6-FMI_@_DXB,_2022-03-25.jpg | Anna Zvereva | CC BY-SA 2.0 |
| commons/A6-FMK_right_2022.jpg | right side (landing) | A6-FMK | https://commons.wikimedia.org/wiki/File:A6-FMK_@_DXB,_2022-03-25.jpg | Anna Zvereva | CC BY-SA 2.0 |
| commons/A6-FMW_right_2022.jpg | right side (landing) | A6-FMW | https://commons.wikimedia.org/wiki/File:A6-FMW_@_DXB,_2022-03-25.jpg | Anna Zvereva | CC BY-SA 2.0 |
| commons/A6-FMH_right_2024.jpg | right side (landing) | A6-FMH | https://commons.wikimedia.org/wiki/File:FlyDubai,_A6-FMH,_Boeing_737-8_MAX_(53812657763).jpg | Anna Zvereva | CC BY-SA 2.0 |
| commons/A6-FMN_belly_2024.jpg | belly (straight up from below) | A6-FMN | https://commons.wikimedia.org/wiki/File:Flydubai_737_8-MAX_(A6-FMN)_taking_off_from_Pisa_airport,_P4_parking,_2024.jpg | Marcxosm | CC BY 4.0 |
| commons/A6-FMG_3q-front-right_2024.jpg | 3/4 front right (parked) | A6-FMG | https://commons.wikimedia.org/wiki/File:Flydubai_Boeing_737_A6-FMG_Krakow_2024_(01).jpg | Bahnfrend | CC BY-SA 4.0 |
| commons/A6-FMG_front_2024.jpg | front (engines, winglets) | A6-FMG | https://commons.wikimedia.org/wiki/File:Flydubai_Boeing_737_A6-FMG_Krakow_2024_(02).jpg | Bahnfrend | CC BY-SA 4.0 |
| commons/A6-FMY_right-far_2022.jpg | **right** side, distant (nose to the right; right-side fin art) (corrected: was "left side, distant 3/4 rear"; file renamed from A6-FMY_left-far_2022.jpg) | A6-FMY | https://commons.wikimedia.org/wiki/File:Flydubai_plane_at_Kraków_Airport,_Poland,_May_2022.jpg | Kgbo | CC BY-SA 4.0 |
| commons/A6-FED_737-800_tail-left_2013.jpg | tail close-up, left side (737-800, same fin art; strong blue colour cast, use for shapes only) | A6-FED | https://commons.wikimedia.org/wiki/File:A6-FED_Boeing_738WL_FlyDubai_Tail_(12237999613).jpg | Aeroprints.com | CC BY-SA 3.0 |
| ps/A6-FKA_1550625.jpg | 3/4 below left | A6-FKA | https://www.planespotters.net/photo/1550625/a6-fka-flydubai-boeing-737-8-max | vvrahjdgi | reference only |
| ps/A6-FKB_1767321.jpg | 3/4 front right (night) | A6-FKB | https://www.planespotters.net/photo/1767321/a6-fkb-flydubai-boeing-737-8-max | Yukino-JA8161 | reference only |
| ps/A6-FKC_1698547.jpg | left side | A6-FKC | https://www.planespotters.net/photo/1698547/a6-fkc-flydubai-boeing-737-8-max | Mukhammad-Rosul Mukhiddinov - Uzbekistan Spotters Team | reference only |
| ps/A6-FKD_1416980.jpg | left side | A6-FKD | https://www.planespotters.net/photo/1416980/a6-fkd-flydubai-boeing-737-8-max | Jet92 | reference only |
| ps/A6-FKE_1643547.jpg | left side (climb) | A6-FKE | https://www.planespotters.net/photo/1643547/a6-fke-flydubai-boeing-737-8-max | Mukhammad-Rosul Mukhiddinov - Uzbekistan Spotters Team | reference only |
| ps/A6-FKF_1911180.jpg | left side | A6-FKF | https://www.planespotters.net/photo/1911180/a6-fkf-flydubai-boeing-737-8-max | Karl Dittlbacher | reference only |
| ps/A6-FKH_1859023.jpg | left side | A6-FKH | https://www.planespotters.net/photo/1859023/a6-fkh-flydubai-boeing-737-8-max | Ronen fefer | reference only |
| ps/A6-FKI_1788855.jpg | left side (take-off roll) | A6-FKI | https://www.planespotters.net/photo/1788855/a6-fki-flydubai-boeing-737-8-max | Damir Uzbekov - Kazahstan Spotting Club | reference only |
| ps/A6-FKJ_1685904.jpg | 3/4 front right (parked) | A6-FKJ | https://www.planespotters.net/photo/1685904/a6-fkj-flydubai-boeing-737-8-max | Majid Hasankhani | reference only |
| ps/A6-FKK_1598415.jpg | right side (climb) | A6-FKK | https://www.planespotters.net/photo/1598415/a6-fkk-flydubai-boeing-737-8-max | Mukhammad-Rosul Mukhiddinov - Uzbekistan Spotters Team | reference only |
| ps/A6-FKL_1576462.jpg | left side | A6-FKL | https://www.planespotters.net/photo/1576462/a6-fkl-flydubai-boeing-737-8-max | G. Najberg | reference only |
| ps/A6-FKM_1827878.jpg | right side (climb) | A6-FKM | https://www.planespotters.net/photo/1827878/a6-fkm-flydubai-boeing-737-8-max | Shahaam Kayani | reference only |
| ps/A6-FKN_1582614.jpg | 3/4 front right (landing) | A6-FKN | https://www.planespotters.net/photo/1582614/a6-fkn-flydubai-boeing-737-8-max | Mukhammad-Rosul Mukhiddinov - Uzbekistan Spotters Team | reference only |
| ps/A6-FKO_1769265.jpg | left side | A6-FKO | https://www.planespotters.net/photo/1769265/a6-fko-flydubai-boeing-737-8-max | G. Najberg | reference only |
| ps/A6-FKR_1610511.jpg | left side | A6-FKR | https://www.planespotters.net/photo/1610511/a6-fkr-flydubai-boeing-737-8-max | Julian Maas | reference only |
| ps/A6-FKT_1702692.jpg | left side (taxi) | A6-FKT | https://www.planespotters.net/photo/1702692/a6-fkt-flydubai-boeing-737-8-max | Mukhammad-Rosul Mukhiddinov - Uzbekistan Spotters Team | reference only |
| ps/A6-FMA_1710481.jpg | right side (taxi) | A6-FMA | https://www.planespotters.net/photo/1710481/a6-fma-flydubai-boeing-737-8-max | Mario Ferioli | reference only |
| ps/A6-FMB_1974432.jpg | left side (taxi) | A6-FMB | https://www.planespotters.net/photo/1974432/a6-fmb-flydubai-boeing-737-8-max | Pavares Vijitakula | reference only |
| ps/A6-FMG_1908865.jpg | left side (taxi) | A6-FMG | https://www.planespotters.net/photo/1908865/a6-fmg-flydubai-boeing-737-8-max | Luba Ostrovskaya | reference only |
| ps/A6-FMH_1898465.jpg | right side | A6-FMH | https://www.planespotters.net/photo/1898465/a6-fmh-flydubai-boeing-737-8-max | Karl Dittlbacher | reference only |
| ps/A6-FMN_1813360.jpg | right side (taxi) | A6-FMN | https://www.planespotters.net/photo/1813360/a6-fmn-flydubai-boeing-737-8-max | Gianluca Mantellini | reference only |
| ps/A6-FMO_1971380.jpg | right side (climb) | A6-FMO | https://www.planespotters.net/photo/1971380/a6-fmo-flydubai-boeing-737-8-max | Alperen Yeni | reference only |
| ps/A6-FMZ_1929591.jpg | left side (taxi) | A6-FMZ | https://www.planespotters.net/photo/1929591/a6-fmz-flydubai-boeing-737-8-max | Niclas Karich | reference only |
| logos/Fly_Dubai_logo_2010_03.svg | wordmark (colour on transparent) | — | https://commons.wikimedia.org/wiki/File:Fly_Dubai_logo_2010_03.svg | flydubai | PD-textlogo (+trademark) |
| logos/Fly_Dubai_logo_2010_05.svg | wordmark reversed on blue box (not used on aircraft) | — | https://commons.wikimedia.org/wiki/File:Fly_Dubai_logo_2010_05.svg | flydubai | PD-textlogo (+trademark) |

Licences (verified: every Commons file page read through the API on 2026-09-29; licence, author and date match the
table and refs.json). About 11 MB in total. The raw API responses are in `api/<HEX>.json`. I did not download the tinted-window Commons
shots (Andy Mabbett DXB 2024 series) or the low-resolution `.webp` files.

## 3. Colours

**Official sources.** The flydubai newsroom stylesheet (press-cdn.prezly.com/press/new/css/flydubai/styles.min.css,
fetched 2026-09-29) uses **#FF8200** (orange) and **#006496** (blue) (verified: re-fetched; #006496 ×24, #FF8200 ×16,
plus a lighter web blue #009CDE ×38 that is not on the aircraft). The Commons wordmark SVG uses the same two fills
(verified in the SVG source). BrandColorCode / SchemeColor give Pantone 151 C for the orange and Pantone 7691 C for the blue. These are the
*digital/print* brand colours.

**The aircraft paint differs from these.** In 7 photos by different photographers, in different light, the paint
orange has a hue of 13–20° (red-orange), not 31° like #FF8200. The title blue has a hue of 214–217° (royal blue),
not 200° like the teal #006496. I trust the photo samples for the paint and give the brand values only for
reference. Each sample is the median of a patch, taken from sunlit or evenly overcast, non-specular areas.

Checker re-samples (median of the most saturated half of class-filtered pixels in each element): "fly" orange
A6-FML #F36733, A6-FNC #FC662D, A6-FMI #FE6C30, A6-FMW #FE7032, A6-FMK #FF8649, A6-FMA_right #EF4410, A6-FMD #DF4321
(hue 11–20°); "dubai" blue A6-FML #0D4596, A6-FNC #0B4795, A6-FMD #024CAD, A6-FMK #174C9A, A6-FMI #0B3E81,
A6-FMW #093C82 (hue 214–217°); navy on sunlit side skin A6-FML #062862, A6-FNC #022C68, right fin tip A6-FMH #06295A,
A6-FMA #04286E. All agree with the table below within photo spread (verified).

| Name | Paint hex (use) | Where | Evidence (photo: median sample) | Trust |
|---|---|---|---|---|
| White | **#F4F5F6** | fuselage base, radome, fin fillet, nacelles | A6-FMA_right_2018 (overcast, neutral WB): #E9E8E9; A6-FML_left_2022 (sun): #DEE0E3 | high |
| flydubai orange | **#F05A28** | "fly", the dot, fuselage stripe, fin orange, winglet outboard faces | A6-FML_left title #E9602E, dot #F26532; A6-FNC title #F25D23; A6-FMI title #FD652D; A6-FMH_below-left winglet #F35D1F, title #FF7E39; A6-FMA_right #DA3D12 (dull light); A6-FMD #D73F1F. Spread #D73F1F–#FF7E39, core #E9602E–#F35D1F. Brand digital #FF8200 | medium-high (hue very consistent) |
| Orange light (halftone tone) | **#F9A46A** | light tone of the dot screens on the fin orange and the winglet tip; upper part of the left fin's orange band | A6-FMH_below-left winglet dots: light #FEC596 / dark #AA5728; A6-FML fin TE band #D5713A (mixed). Checker: same winglet, dots #FFC598, gaps between dots #AB5A2A, plain orange lower down #F25C1F: the ground of the dot screen reads deeper than the plain orange, so the screen is light dots on a deeper orange, not on #F05A28 (corrected: was "#F9A46A on #F05A28") | medium |
| flydubai blue | **#0D4A9E** | "dubai" letters, winglet upper-element inboard face | A6-FML #0D4596; A6-FNC #0C4795; A6-FMD #1C5EB1 (overcast); A6-FMA #163C9A; A6-FMI #144E8E; A6-FMH_below-left #017AD0 (sunlit from below, too cyan); winglet inboard A6-FML #0E4A9A, A6-FMH_below-left #0A6FBB. Brand digital #006496 | medium-high |
| Navy | **#0B2C72** | lower aft fuselage and tail cone, right-side fin tip corner, ventral-fin inboard face | A6-FMA_right fin tip #042871 (vertical, lit like the title #163C9A, so clearly darker); A6-FMI fin tip #04285A; A6-FMD lower aft #002764; A6-FMA lower aft #011850 (shadow); A6-FMH_below-left (sun from below) #005FA6 | medium |
| Fin blue (mid) | **#3A93D3** | main fin colour, darkest swoosh band on the fuselage | A6-FML fin v0.7 #488CC0 (sun, slightly washed); A6-FMA_right fin #1763AE (overcast); A6-FMH_below-left fin #1AA4D5 / #0762A3; A6-FML fuselage band #225B8C (shade). Checker: sunlit A6-FML #3780BD / #3B86BE, A6-FNC #4390C9 / #3581BC; overcast A6-FMH_right #2462A0, A6-FMW #215F99. #3A93D3 is at the light end of the sunlit range; #3A88C8 fits the samples better (verified, value slightly light) | medium |
| Light blue | **#7CC2EA** | fin tip/upper-front area, fuselage swoosh bands | A6-FML fin top #77BBE4; A6-FMH_below-left #6FBDDD. Checker: A6-FML dotted upper-front fin #69B1DC / #6CB1DB, plain upper-aft fin #4D8AB4–#589DC8; A6-FNC #5C9EC6. The brightest samples are a little darker than #7CC2EA; #6FB6E0 is closer (verified, value slightly light) | medium |
| Pale blue | **#B6DAEE** | fin lower-front field (with dots), first fuselage swoosh | A6-FML fin LE #B8D1E2; A6-FMH_below-left #A2D0E4. Checker: A6-FNC #B6D7E3, A6-FML #BBD7DC / #A0C7DB (verified) | medium |
| Wing / tailplane grey | **#BABEC2** | wings (both surfaces), horizontal stabiliser | A6-FML wing upper #BCC0C2 (sun); stabiliser visibly the same grey in A6-FMA_right, A6-FMN_belly, A6-FED tail | medium (standard Boeing grey) |
| Nacelle white | **#E8EAEC** | nacelle cowls, thrust-reverser sleeve | A6-FML nacelle #D0D2D5 against fuselage #DEE0E3 in the same sun | medium |
| Inlet lip / metal | **#C9C9C6** | polished inlet lip ring, slat leading edges | A6-FML lip #CFC9BF (specular, varies #A09D94–#F6F7F0) | medium |
| Stripe light edge (new) | **#F5823A** | outer third of the fuselage orange stripe (forward edge of the vertical part, upper edge of the level part) | Checker: A6-FNC stripe at h ≈ 1.9: forward edge #E4752E / #E0762C, rest #D2440E / #D3480F; A6-FMN_belly ring: forward edge #61331C, rest #54190B (shade); A6-FED tail (hazy): upper band #C67759, lower band #A73C36. Always lighter and yellower than the inner part | medium-low |

## 4. Elements (side elevation)

737-8 landmarks, measured on A6-FML (left) and A6-FMA (right):

| Landmark | Position |
|---|---|
| Length | 39.52 m |
| Fuselage height | 4.01 m |
| Window-line centre | h ≈ 2.35 |
| Door 1 (L1/R1) | L1 z 4.9–5.8 (centre ≈ 5.35), h 1.4–3.3 (verified, A6-FML x 170–195 px). R1 (galley door) is narrower (≈0.72 m) and sits ≈0.6 m further forward: z ≈ 4.4–5.1 (added: A6-FMH_right, A6-FMK_right, A6-FMW_right, nose-tip to R1 aft edge = 0.28–0.30 of nose-tip to title aft end, against 0.32 for L1 on A6-FML) |
| Two overwing exits | z ≈ 16.9–18.5 (verified: A6-FML x 507–520 and 533–548 px) |
| Aft door L2/R2 | centre z ≈ 32.4 (z 32.0–32.8), h 1.6–3.45 (verified) |
| Dorsal fillet begins at the crown | z ≈ 29.2 (verified) |
| Fin LE kink | z 32.8, h 5.1 (verified: the straight LE through the measured points below extends to it) |
| Fin LE tip | z 38.0, h 11.3 (corrected: was z 38.7). A6-FML row scans: LE at h 11.2 → z 37.95, h 8.0 → z 35.2, h 6.6 → z 34.05; tip chord ≈ 1.5–1.7 m (A6-FML 44 px, A6-FMH_right 46–49 px), not 0.8 m |
| Fin TE tip | z 39.5, h 11.2 (verified) |
| Fin TE root (tail-cone top) | z 37.9, h 4.4 (corrected: was z 38.3). A6-FML TE: h 8.0 → z 38.7, h 6.6 → z 38.3, h 5.1 → z 38.0, h 4.4 → z 37.9; A6-FMH_right TE just above the stabiliser ≈ z 38.0 |
| Aft-body upsweep: the bottom line rises | h ≈ 0 at z 30 → 1.0 (z 33) → 1.3 (z 34.6) → 1.9 (z 36) → 2.4 (z 37.4) → 2.8 (z 38.5) → tail-cone tip ≈ 3.4 at z 39.5 |

- **Fuselage base:** white #F4F5F6 from the radome to the orange stripe (z ≈ 28). There is no cheatline and no
  forward belly colour: the lower fuselage and the belly are white as far aft as the stripe
  (A6-FMN_belly: the whole forward belly and the wing-body fairing are the fuselage white).
- **Belly / aft wrap:** the only belly colour is the aft wrap. The orange stripe and the swoosh bands run right
  round the underside as rings, and the underside aft of z ≈ 31 is navy (A6-FMN_belly).
- **Orange stripe (both sides; the "J" swoosh):** it starts under the belly as a ring about 0.6 m wide at
  z ≈ 27.9 (A6-FMN_belly, calibrated to door R2) (verified: ring 26 px ≈ 0.6 m at 43.7 px/m; z 27.7–27.9).
  - Two tones (added): the outer third of the stripe (the forward edge of the vertical part, the upper edge of the
    level part) is a lighter, yellower orange (≈#F5823A); the inner two-thirds are the deep paint orange. Seen on
    A6-FNC (forward edge #E4752E vs #D2440E), A6-FMN_belly (forward edge of the ring lighter) and A6-FED (upper band
    lighter than lower band along the level run).
  - On the side it rises and leans slightly aft. Its centreline passes (z 28.3, h 1.0), (28.7, 1.9) and
    (29.1, 2.4) (window line), about 3.5 m ahead of the door-2 centre on both sides. Measured at h 1.9 it spans
    z 28.45–29.0 on A6-FML (left) and 3.4–3.9 m ahead of R2 on A6-FMA (right). Width is 0.5–0.6 m (verified: A6-FML
    row scan at h 1.9, orange z 28.45–28.98).
  - It then bends aft through (29.6, 2.9) to (30.3, 3.2). Here it thins to about 0.15 m.
  - It runs aft almost level at h ≈ 3.2–3.35, crossing the top of door 2 and slowly thickening: 0.2 m at z 31,
    0.4 m at z 33, 0.65 m at z 34.6–36 (verified: A6-FML row scans at h 3.2 and 3.4).
  - Left: it swells and rises into the fin's trailing-edge orange band (z 35.5 → 36.3, h 3.5 → 3.9 → fin root).
  - Right: it stays about 0.3 m wide and at z ≈ 35 turns sharply up into the diagonal orange band of the right
    fin art (A6-FMA_right, A6-FMI_right) (verified on A6-FMH_right: the curve up starts just aft of door R2,
    z ≈ 33.5, and is near-vertical by z ≈ 34.8).
- **Swoosh bands (both sides):** between the vertical part of the orange stripe and the navy there is a stack of
  bands parallel to the stripe. Each rises from the belly, leans aft and bends aft into thin near-level lines at
  h 2.0–3.0, just under the orange line. They die out by z ≈ 34, where only a 0.1 m white hairline is left between
  the orange line and the navy. Measured at h 1.9 on A6-FML, going aft:

  | Band | z | Width |
  |---|---|---|
  | White gap | 29.0–30.0 | 1.0 m |
  | Pale/light blue #B6DAEE | 30.0–30.5 | 0.5 m |
  | White | 30.5–30.7 | 0.2 m |
  | Light blue #7CC2EA | 30.7–31.3 | 0.6 m |
  | White | 31.3–31.55 | 0.25 m |
  | Fin blue #3A93D3 | 31.55–32.1 | 0.55 m |
  | Thin white | — | 0.1–0.3 m |
  | Navy | from 32.45 | — |

  On the belly (A6-FMN_belly) the same stack is orange / white / 2 × teal-light blues / white / mid blue / white /
  navy. The right side is the mirror image (A6-FMA_right, A6-FMH_right) (verified: A6-FML row scan at h 1.9 gives
  pale 30.27–30.48, light 30.80–31.12, fin blue 31.73–32.05, navy from 32.52).
- **Navy (lower tail):** front edge (31.0, 0), (31.2, 1.0), (32.4, 1.9), (33.2, 2.4). Top edge (34.6, 2.75),
  (36.0, 3.2), (37.4, 3.3), (39.5, 3.4). It fills everything below that down to the upswept bottom line and covers
  the whole lower tail cone to the tip (A6-FML vertical scans; A6-FED tail; A6-FMN_belly) (verified: navy at h 1.9
  from z 32.5, at h 2.4 from z 33.3; A6-FMN_belly navy from z ≈ 30.8 on the underside).
  - Right side only: the tail cone above the stabiliser and the fin's trailing-edge root corner
    (u > 0.75, v < 0.08) are also navy (A6-FMA_right) (verified on A6-FMH_right).
  - Left side: the area above the stabiliser at the fin trailing-edge root is the deep end of the orange TE band
    (A6-FML, A6-FED tail).
  - APU exhaust: bare metal (verified: A6-FMN_belly, A6-FMH_right).
- **Titles:** "flydubai". "fly" is a lowercase thin monoline in orange; "dubai" is a lowercase heavy rounded
  geometric face with an Arabic-calligraphy-style "a", in blue; the dot of the "i" is replaced by an orange disc
  set to the upper right. It is identical to `logos/Fly_Dubai_logo_2010_03.svg`: I compared the zoomed title of
  A6-FML with the rendered SVG. It reads normally (left to right) on both sides, so it is not mirrored (verified:
  rendered the SVG with rsvg-convert and compared with A6-FML and A6-FMH_right zooms; the disc sits beside the top
  of the "i" stem, level with the x-height band, not above it).
  - Height, projected in side elevation (checker's colour-class pixel extents on A6-FML, 28 px/m): ascender top
    ("f", "l", "d", "b") h 3.50 (corrected: was 3.55); x-height top h 3.15 ("u" 3.14, "a" 3.21, "i" 3.18)
    (corrected: was 2.95); baseline h 1.75–1.80 (verified, was 1.72); "y" descender bottom h 1.36 (corrected: was
    1.30); total ≈ 2.15 m (corrected: was 2.25 m). The window line (window centres h ≈ 2.36) runs through the lower
    half of the lowercase letters, 0.6 m above the baseline (verified). Orange disc: centre h 2.93, diameter ≈ 0.5 m
    (verified, 13–14 px). On the curved skin the letters are taller than their ≈ 2.15 m projection.
  - Left: z 6.0 ("f", 0.2 m aft of the L1 door's aft edge) → 18.2 (disc edge, over the second overwing exit).
    "fly" z 6.0–9.3, "dubai" z 9.6–17.4, disc centre 17.9 (A6-FML_left) (verified: "f" 5.98, "fly" to 9.27,
    "dubai" 9.70–17.34, disc 17.73–18.20).
  - Right: the disc is nearest the nose. Disc forward edge ≈ 0.7 m aft of the R1 aft edge; the "f" crossbar ends
    over the aft overwing exit, 0.1–0.3 m forward of its aft edge, exactly as the disc does on the left. In z the
    right title spans **z ≈ 5.9–18.2**, the same stretch as the left (corrected: was z 6.45 → 19.0). Why the old
    numbers were wrong: 19.0 came from one global px/m scale on A6-FMA_right, which is shot from ahead of the
    aircraft (strong perspective), and it contradicted the dossier's own overwing-exit position (z 16.9–18.5); 6.45
    assumed R1 sits where L1 does, but R1 is ≈ 0.6 m further forward (landmark table). Evidence: title length is
    23.3 ± 0.4 window pitches on every photo (A6-FML 342 px / 14.7, A6-FMH_right 339 / 14.5, A6-FMA_right 328 /
    14.1, A6-FMK 337 / 14.8, A6-FMW 325 / 13.7, A6-FMI 341 / 14.6), so the artwork is the same size on both sides;
    nose-tip-referenced positions on A6-FMH_right / A6-FMK / A6-FMW put the disc edge at z 5.8 / 5.9 / 6.1.
  - Both sides: ±0.2 m; use the same box, z 6.0–18.2, on both sides.
  - The same language on both sides (no Arabic title). Registration (navy, rear fuselage below the windows) and the
    small UAE flag under the cockpit windows: skip.
- **Fin (see §5 for the drawing):** white dorsal fillet; blue banded art with white arcs and halftone dot screens;
  orange. Left and right art differ:
  - Left: an orange wedge along the trailing edge from the root to v ≈ 0.33 (corrected: was 0.42; A6-FML row scans
    lose the orange between v 0.30 and 0.35, A6-FNC and A6-FED give 0.34–0.37 of the fin height); no navy; the tip
    area is light blue (A6-FML, A6-FMD, A6-FNC, A6-FED tail, A6-MAX, all left-side ps photos) (verified).
  - Right: a diagonal orange band from the mid-root to the leading edge; its upper end reaches the LE at v ≈ 0.47
    (verified: row scans give 0.46 on A6-FMH_right, 0.42 on A6-FMA_right) and, being ~15 % of the chord wide, the band
    touches the LE over v ≈ 0.31–0.46 (added); a navy tip corner at the trailing edge (A6-FMA_right, A6-FMI, A6-FMK, A6-FMW, A6-FMH_right, A6-FMY, ps FKK/FKM/FMA/FMH/FMN/FMO) (verified).
  - Nothing continues onto the fuselage under the fin except the orange line and, on the right, the navy tail cone.
- **Tail cone:** navy (both sides); on the left, orange above the stabiliser at the fin root; APU nozzle metal
  (verified: A6-FML, A6-FNC, A6-FED left; A6-FMH_right right).
- **Horizontal stabiliser:** plain grey #BABEC2, both surfaces, no markings (A6-FMA_right, A6-FMN_belly, A6-FED).
- **Wings:** grey #BABEC2 upper and lower; slats and leading edges bare metal (A6-FML, A6-FMN_belly,
  A6-FMG_front). The registration is on the lower surface of the left wing (A6-FMN_belly, A6-FMH_below-left).
- **Engine nacelles (CFM LEAP-1B):** plain white #E8EAEC cowls with a polished metal inlet lip #C9C9C6 (a ring
  about 0.2–0.3 m deep). The chevron (serrated) trailing edge of the fan-duct sleeve is white; the core
  nozzle/plug is grey metal. There are no bands, logos or titles, only the small red maintenance stencils/hinge
  lines. Both engines are alike (A6-FMH_below-left zoom, A6-FML, A6-FMG_front/3q) (verified, also A6-FMW right
  engine; A6-FMI/A6-FMK carried a temporary decal in 2022, see §1).
- **Wingtip devices (Boeing AT "dual-feather" winglet):**
  - Outboard face, upper and ventral elements: flydubai orange #F05A28 (verified: A6-FMH_below-left plain part
    #F25C1F; ventral outboard face orange on the A6-FML and A6-FMA near winglets). The upper ~55 % of the upper
    element carries a square-grid halftone of lighter orange dots, about 50 % coverage, pitch about 8 cm
    (verified: A6-FMH_below-left left tip, A6-FMN_belly right tip). The ground between the dots is a deeper orange
    than the plain lower part (A6-FMH_below-left: dots #FFC598, gaps #AB5A2A, plain #F25C1F), so the screened tip
    does not read lighter overall: in the side shots it reads slightly darker and less saturated (A6-FML near
    winglet screen #955536 vs plain #AB310A; A6-FMA #6B2C19 vs #991800) (corrected: was "#F9A46A on #F05A28 … so
    the tip looks lighter").
  - Inboard face, upper element: flydubai blue #0D4A9E, carrying the wordmark laid along the span. "fly" and the
    disc are orange; "dubai" is white. The letter tops face the winglet leading edge. Because of that it reads
    root→tip on the right winglet (A6-FMH_below-left right tip; A6-FML far winglet) and tip→root on the left
    winglet (A6-FMA_right far winglet). The wordmark fills about 25 % → 80 % of the element height, with letter
    height about 35 % of the local chord (verified: A6-FMH_below-left right tip reads root→tip with letter tops to
    the LE; A6-FMA far winglet reads tip→root, "fly" above "dubai"; A6-FML far winglet shows "dubai" rising from the
    root; wordmark spans ≈ 28 %→80 % of the element height).
  - Inboard face, ventral element: navy #0B2C72 (A6-FMN_belly both tips, A6-FMH_below-left right tip) (verified).
- **Nose:** white radome, no nose band, standard dark cockpit window frames (A6-FMG_front, A6-FML).

## 5. Side-elevation drawing steps

Units in metres, (z, h) as defined above. Colours are the paint hexes of §3.

### LEFT side (nose at the left of the drawing)

1. Fill the whole fuselage outline (radome → tail cone) and the dorsal fillet white #F4F5F6.
2. **Orange stripe #F05A28.** Draw a variable-width ribbon on this centreline:
   (27.9, 0) → (28.3, 1.0) → (28.7, 1.9) → (29.1, 2.4) → (29.6, 2.9) → (30.3, 3.2) → (31.0, 3.33) → (32.4, 3.35)
   → (33.3, 3.15) → (34.6, 3.2) → (35.5, 3.5) → (36.3, 3.9) → join the fin TE band at the root (z 36.5–37.9 (corrected: was 38.3, see F4),
   h 4.0–4.4).
   Widths: 0.60 at h 0 → 0.50 at h 2 → 0.15 at (30.3, 3.2) → 0.20 at z 31 → 0.40 at z 33 → 0.65 from z 34.6
   onward. Give the upper part of the fillet-end section the light tone #F9A46A, blending to #F05A28 below.
   Paint the outer third of the ribbon's width (the forward edge of the vertical part, the upper edge of the level
   run) in the lighter stripe tone #F5823A and the inner two-thirds in #F05A28 (added; see §4 Orange stripe).
   Continue the ribbon under the belly (projected: it simply reaches the bottom outline).
3. **Swoosh bands.** Aft of the stripe, draw 3 coloured bands, each a copy of the stripe's vertical-to-level curve
   shifted aft:
   - pale blue #B6DAEE starting 1.0 m aft of the stripe (at h 1.9: z 30.0–30.5);
   - white 0.2 m;
   - light blue #7CC2EA (z 30.7–31.3 at h 1.9);
   - white 0.25 m;
   - fin blue #3A93D3 (z 31.55–32.1 at h 1.9);
   - white 0.1–0.3 m.

   Each band bends aft at h 2.0–3.0 into a thin level line under the orange stripe and tapers out by z ≈ 34.
4. **Navy #0B2C72.** Fill the region bounded by the front edge (31.0, 0) (31.2, 1.0) (32.4, 1.9) (33.2, 2.4),
   the top edge (34.6, 2.75) (36.0, 3.2) (37.4, 3.3) (39.5, 3.4), and below that the bottom outline of the aft
   body. Keep a 0.1 m white hairline between navy and orange from z 33 aft.
5. **Title.** Place `logos/Fly_Dubai_logo_2010_03.svg`, recoloured (fill #FF8200 → #F05A28, fill #006496 →
   #0D4A9E), in the box z 6.0–18.2, h 1.36–3.50 (corrected: was h 1.30–3.55). That is a non-uniform scale: 12.2 m
   wide, 2.15 m tall, which is 0.86 of the SVG's own aspect (corrected: was 2.25 m and 0.90; A6-FML pixel extents
   "f" top y 326, "y" bottom y 386, 342 px long), to allow for the projection onto a cylinder. With that box the
   SVG's own x-height lands at h ≈ 3.03; the photo shows ≈ 3.15 because the upper letters curve away, so a
   cylinder-mapped texture needs no further tweak. It reads normally.
6. **Fin, LEFT art.** Outline: F0 (29.2, 4.0) fillet start → F1 (32.8, 5.1) LE kink → F2 (38.0, 11.3) LE tip →
   F3 (39.5, 11.2) TE tip → F4 (37.9, 4.4) TE root (corrected: was F2 (38.7, 11.3) and F4 (38.3, 4.4); see the
   landmark table). Use v = (h − 4.2)/7.05 and u = LE→TE fraction.
   1. Fill fin blue #3A93D3.
   2. Light blue #7CC2EA over the region u < 0.55 for v > 0.8, blending to u < 0.2 at v = 0.7. Add a halftone of
      pale dots if wanted.
   3. Fillet and lower LE: white for u < 0.15 at v ≤ 0.1, and the fillet ahead of F1; then pale blue #B6DAEE for
      u 0.15–0.3 at v 0.1, widening forward to u 0.05–0.3 at v 0.3 (halftone dots of fin blue on pale).
   4. Three white arcs, each 0.20–0.30 m wide, starting at the root and curving up and forward to meet the LE:
      - **A:** root u 0.31 → (v 0.2, u 0.20) → LE at v ≈ 0.38.
      - **B:** root u 0.57 → (0.2, 0.54) → (0.3, 0.47) → (0.4, 0.36) → (0.5, 0.20) → LE at v ≈ 0.60.
      - **C:** root u 0.655 → (0.2, 0.65) → (0.3, 0.63) → (0.4, 0.58) → (0.5, 0.48) → (0.6, 0.33) → LE at v ≈ 0.72.
   5. Between A and B, light blue #7CC2EA with a fin-blue strip along B's forward side. Between B and C, fin blue
      with a light-blue strip.
   6. White arc D: root u 0.77 → (0.2, 0.87) → (0.3, 0.94) → TE at v ≈ 0.36 (corrected: was (0.2, 0.82) →
      (0.3, 0.89) → (0.4, 0.93) → TE at v ≈ 0.42; A6-FML row scans put the white just ahead of the orange at
      u ≈ 0.88 (v 0.2) and 0.94 (v 0.3)).
   7. Aft of D, the orange wedge: #F05A28 at the root, blending to #F9A46A near its top. Measured along the chord it
      is ≈ 1.1 m wide at v 0.05, 0.9 m at v 0.1 (u ≈ 0.83–1.0), 0.45 m at v 0.2 (u ≈ 0.91–1.0) and 0.15 m at v 0.3
      (u ≈ 0.97–1.0), tapering to a point on the TE at v ≈ 0.33 (corrected: was u 0.78 / 0.85 / 0.91 and a point at
      v ≈ 0.42; A6-FML row scans, cross-checked on A6-FNC and A6-FED). It continues down into the fuselage stripe
      (step 2).
7. Tail cone below the stabiliser: navy (already covered by step 4); the APU nozzle is metal grey.

### RIGHT side (differences from the left)

- **Title:** same artwork, reading normally, in the same box as the left, z 6.0–18.2 (disc nearest the nose),
  h 1.36–3.50 (corrected: was z 6.45–19.0, h 1.30–3.55; see §4 Titles). The disc then sits ≈ 0.7 m aft of the R1
  door's aft edge, because R1 is further forward than L1.
- **Orange stripe:** same belly/vertical part and the same level run at h 3.2–3.35, but it keeps a width of about
  0.3 m and, at z ≈ 35.0, turns up into the fin's diagonal band. There is no thick TE wedge.
- **Swoosh bands:** identical (mirror).
- **Navy:** identical, plus the tail cone above the stabiliser and the fin TE-root corner (u > 0.75, v < 0.08) are
  navy.
- **Fin, RIGHT art:**
  1. Fill fin blue #3A93D3; the fillet is white (u < 0.30 at v 0.1).
  2. Pale blue #B6DAEE for u 0.05–0.2 at v 0.2.
  3. The **orange band** runs diagonally. Its width is about 15 % of the chord. Centreline: root u 0.65 (joining
     the fuselage stripe) → (v 0.2, u 0.47) → (0.3, 0.30) → (0.4, 0.15) → ends at the LE at v ≈ 0.47. The upper
     half is a halftone of orange dots on light blue (verified on A6-FMH_right: centre u ≈ 0.45 at v 0.2 and 0.30 at
     v 0.3; A6-FMA_right, shot from ahead and above, reads ≈ 0.1 smaller, so treat these as ±0.1).
  4. White arcs 0.2–0.3 m wide: one just ahead of the band (v 0.2, u 0.37); two behind it, parallel, reaching the
     LE at v ≈ 0.6 and v ≈ 0.7.
  5. Light blue #7CC2EA fields beside the band and near the TE (u 0.88–0.96 at v 0.7).
  6. The **navy tip corner** #0B2C72 is bounded by a white arc that runs from the tip chord near the LE
     (u ≈ 0.1 at v 0.97; u ≈ 0.25 at v 0.9), curving down to the TE at v ≈ 0.64. Everything aft of it is navy:
     u 0.25–1.0 at v 0.9, u 0.70–1.0 at v 0.8, u 0.91–1.0 at v 0.7 (corrected: was TE at v ≈ 0.72 and u 0.57–1.0 at
     v 0.9, u 0.79–1.0 at v 0.8; row scans of A6-FMH_right and A6-FMA_right agree within 0.03).

### Flat colours

- Wings and horizontal stabiliser: #BABEC2.
- Nacelles: #E8EAEC, with an inlet lip ring #C9C9C6.
- Winglets: as in §4. The outboard face is orange with a light-dot halftone on a deeper-orange ground over the upper
  ~55 % of the upper element (corrected: was "a lighter halftone tip"). The inboard face is blue #0D4A9E
  with the wordmark ("fly" and disc orange, "dubai" white; letter tops toward the LE). The ventral inboard face is
  navy.

## 6. Logos and wordmarks

| Graphic | Commons file | Licence | Use |
|---|---|---|---|
| "flydubai" wordmark (fuselage titles, winglet inboard faces) | https://commons.wikimedia.org/wiki/File:Fly_Dubai_logo_2010_03.svg → `logos/Fly_Dubai_logo_2010_03.svg` | {{PD-textlogo}} + {{Trademark}} (verified: file-page wikitext read 2026-09-29) | **Usable.** Two fills: #FF8200 (fly + disc) and #006496 (dubai). Recolour to the paint colours (§3). For the winglet, set "dubai" to white. Commons (de) calls it the "former" logo, but the letterforms match the current aircraft titles exactly (checked against the A6-FML zoom). |
| Reversed wordmark on a blue box | https://commons.wikimedia.org/wiki/File:Fly_Dubai_logo_2010_05.svg → `logos/Fly_Dubai_logo_2010_05.svg` | {{PD-textlogo}} + {{trademark}} (verified: file-page wikitext read 2026-09-29) | This is the winglet inboard-face design: orange "fly" and disc (#F79234), white "dubai", on a blue rectangle (#3270AE). Usable for the winglets: drop the `<rect>` (or recolour it to #0D4A9E) and recolour the orange to #F05A28 (corrected: was "not used on the aircraft … reference only"). The "f" top curve differs slightly from 2010_03; on a 0.3 m-tall winglet wordmark this is invisible. |
| Fin art | none (abstract livery artwork, not on Commons) | — | Draw it as flat bands per §5. There is no emblem to omit. |

**Font fallback** (needed only if the SVG cannot be used):

- "fly": Quicksand Light (300), Google Fonts, OFL.
- "dubai": Baloo 2 ExtraBold (800), OFL. This is approximate; the real "a" is custom.
- Always prefer the PD SVG.

## 7. Geometry facts for the model

- **Type:** 737-8. Length 39.52 m, span 35.92 m, height 12.3 m, fuselage 3.76 m wide × 4.01 m tall. There is no
  mid-cabin exit door (these are not 737-8-200s): door 1, two overwing exits and door 2 per side (A6-FML).
- **Wingtip:** Boeing AT dual-feather winglet (not the NG blended winglet).
  - Upper element: about 2.2–2.4 m tall (A6-FML projection ≈ 2.1 m), canted slightly outboard, strongly swept
    leading edge, root chord about 1.6 m, tip chord about 0.3 m.
  - Ventral element: about 1.0 m, pointing down, outboard and aft.
  - Tip-to-tip height ≈ 2.9–3.1 m (corrected: was "about 1 m more than the NG winglet, so about 3.4 m"; the photos
    do not support 3.4: A6-FML near winglet, upper tip y 314.5 to ventral tip y 397.5 = 83 px = 2.96 m; A6-FMA near
    winglet 85.5 px ≈ 3.1 m after allowing for the wingtip being nearer the camera). Upper element projection
    ≈ 2.1 m (verified), ventral element ≈ 0.8 m vertical, swept ≈ 1.7 m aft of its root.
  - Estimates are from A6-FML and A6-FMA_right; ±0.3 m.
- **Engines:** CFM LEAP-1B.
  - Large round nacelle (fan about 1.76 m), mounted high and forward, with the inlet ahead of the wing leading
    edge.
  - Chevron (serrated) trailing edge on the fan-duct sleeve, clearly visible on every side shot.
  - Short exposed core nozzle and plug.
- **Tail cone:** 737 MAX tail cone, extended and more pointed, with the APU exhaust at its tip (A6-FMN_belly).
- **Nose gear:** taller MAX nose gear. It changes the ground attitude only.
- **Fin art is side-specific:** do not mirror one texture to both faces of the fin.
- **Title reading direction:** normal on both sides. If the texture is mirrored for the right side, the title must
  be un-mirrored.

## 8. Confidence and open questions

- **High:** the overall scheme and element placement; all 23 tracked aircraft carry it; the winglet face colours
  and the wordmark on the inboard face; plain white nacelles; grey wings and stabiliser; the asymmetric fin
  (confirmed on 6 right-side and 8 left-side Commons photos plus the ps thumbnails, and by a community report)
  (corrected: was 5 right-side; A6-FMY is a right-side view).
- **Medium:**
  - Exact paint hexes. They are photo-derived. The paint orange and blue are clearly redder and deeper than the
    brand digital #FF8200 / #006496, but no official paint spec was found.
  - Navy against title blue: the navy is darker in every photo, but a single blue might also have been used on
    both.
- **Medium-low:**
  - Exact fin band curves. They are traced from one good photo per side (A6-FML left, A6-FMA right) and are ±5 % of
    the chord.
  - Halftone patterns, which are simplified.
  - The right-side title z range (±0.3 m).
  - The winglet size.
- **Open questions:**
  - Do A6-FKA / A6-FKB still carry any Argentina AFA decals? The API photos show standard; their dates are unknown.
    For now they are painted standard.
  - The fin art is best checked against a close-up of the right side. A crop of `commons/A6-FMA_right_2018.jpg`
    (tail region) and the `A6-FMI` / `A6-FMK` images are the best available. Checker: A6-FMH_right_2024 is the
    sharpest right-side tail (fin ≈ 200 px tall, near-perpendicular) and the one to trace from; A6-FMA_right is shot
    from ahead and above and shifts right-fin u values by up to 0.1. Commons has no higher-resolution right-side
    tail close-up of this fleet (searched the flydubai 737 MAX categories on 2026-09-29; the other DXB 2022 shots,
    A6-FMM / A6-FMP / A6-FMR, are the same 1200 px side views).
  - R1 door position: measured ≈ 0.6 m forward of L1 from three right-side photos; no Boeing drawing was checked.
    This does not affect the livery (the title box is the same on both sides), only where the modeller cuts the
    R1 door outline.
  - Where exactly the swoosh bands end under the orange line (z 33–34) varies slightly between photos.

## 9. Independent check summary (2026-09-29)

Method: every Commons photo and all 23 planespotters thumbnails re-opened (full frame plus zoomed crops); colours
re-sampled with class-filtered medians; positions re-measured by row/column pixel scans and window-pitch
autocorrelation; Commons licences read from the file pages through the API; the newsroom CSS re-fetched; a web search
for any newer livery.

Verified as written: current scheme on all 23 tracked aircraft; fleet table (hexes, samples, photo ids, links,
photographers); A6-FKA/FKB AFA special history; A6-FPC special; brand colours in the CSS and SVG; paint orange, title
blue, navy and pale-blue hexes; white fuselage and belly forward of the aft wrap; orange-stripe and swoosh-band
positions at h 1.9; navy boundary; left title position (z 6.0–18.2); disc size and height; winglet face colours,
wordmark colours, reading direction and letter orientation; ventral inboard faces navy; plain nacelles; registration
under the left wing; all Commons licences and authors; both logo files PD-textlogo + trademark.

Corrected:
1. `A6-FMY` photo is a right-side view, not left (file renamed to `A6-FMY_right-far_2022.jpg`; refs.json fixed).
2. The 2022 "50 YEARS OF UNITY" nacelle decal was on A6-FMK as well as A6-FMI.
3. Right-side title box: z ≈ 5.9–18.2, the same as the left (was 6.45–19.0); R1 sits ≈ 0.6 m forward of L1.
4. Title heights: x-height top h 3.15 (was 2.95); overall h 1.36–3.50, 2.15 m (was 1.30–3.55, 2.25 m);
   non-uniform factor 0.86 (was 0.90).
5. Fin outline: LE tip z 38.0 (was 38.7); TE root z 37.9 (was 38.3); tip chord ≈ 1.5–1.7 m.
6. Left fin orange wedge ends on the TE at v ≈ 0.33 (was 0.42), with narrower widths; arc D moved aft accordingly.
7. Right fin navy corner reaches the TE at v ≈ 0.64 (was 0.72) and is much wider near the tip: u 0.25–1.0 at v 0.9
   (was 0.57–1.0), u 0.70–1.0 at v 0.8 (was 0.79–1.0).
8. Winglet dot screen: light dots on a deeper orange ground; the screened tip does not read lighter overall.
9. Winglet tip-to-tip height ≈ 2.9–3.1 m (was ≈ 3.4 m).
10. `Fly_Dubai_logo_2010_05.svg` is the winglet inboard-face artwork (was "not used on the aircraft").

Added: the two-tone fuselage stripe (lighter outer third, ≈ #F5823A); refined sunlit fin-blue and light-blue samples
(the listed #3A93D3 and #7CC2EA are at the light end; #3A88C8 and #6FB6E0 fit better); the right-fin orange band
touches the LE over v 0.31–0.46.

Not checked: Pantone codes from BrandColorCode / SchemeColor; the Infinite Flight forum quote; the exact aft-body
upsweep profile; left-fin arcs A–C (checked only by eye: they match the photos in shape and order).

