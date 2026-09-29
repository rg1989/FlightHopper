# El Al (ICAO ELY / IATA LY): livery dossier for the 737-800, 737-900ER, 787-8 and 787-9

Research date: 2026-09-29. Reference folder: `data/livery-refs/ELY/` (git-ignored). The file `refs.json` in that folder lists every downloaded file.
Tracked keys: `B738 ELY`, `B739 ELY`, `B789 ELY`, `B788 ELY` (from `regs-survey.json`). The LY-* wet-lease frames (LY-MGM, LY-PMI, LY-OEX, LY-LOC, LY-PEX, LY-TFS) are out of scope and ignored.

Conventions used in this document:

- **x** = metres aft of the nose tip. **z** = metres above the keel line (the lowest point of the constant-section fuselage).
- **L** = overall length and **H** = fuselage height (keel to crown). The type values used are:
  - 737-800: L 39.47 m.
  - 737-900ER: L 42.11 m.
  - 737, both variants: H ≈ 4.0 m (width 3.76 m).
  - 787-8: L 56.72 m.
  - 787-9: L 62.81 m.
  - 787, both variants: H 5.97 m (width 5.77 m).
- All positions were measured on the named photos. Unless a line says otherwise, the tolerance is ±0.5 m in x and ±0.05 H in z. The projection is orthographic from the side, so artwork on the upper fuselage is shown at its projected height, which is lower than its height along the skin.
- "Left side" = port side. When the nose points to the left of the picture, the viewer sees the left side.

---

## 1. Identity

Two El Al schemes are in service, plus two special liveries:

| Scheme | Name / year | Look |
|---|---|---|
| **A: "Ribbons" (classic)** | Introduced in 1998–1999 (El Al's 50th anniversary) as the "blue and silver ribbons" design with a swept Israeli flag on the tail; livery designer Ruth Rahat; first 737-800 was 4X-EKA "Tiberias" (Israel Airline Museum, chapter 9) (verified; designer and first frame added). | White aircraft. A diagonal blue band runs from the belly behind door 1 up to the crown above the wing, with a silver ribbon along its lower edge. The fin is white and carries the flag design: two blue stripes, each with a silver ribbon, and a blue Star of David. The titles are two-tone: Latin letters in navy, Hebrew letters in silver-grey. The rear fuselage and the tail cone are white. |
| A1: classic navy paint | The original 1999 colour. | Violet-navy (#262D70) with silver-grey ribbons. |
| A2: bright-blue repaint | Seen on every 787 (2017 onwards) and on the 737s repainted from 2018. | Same layout, but the blue is a brighter royal blue (#0848A0). It has a printed half-tone (dot) shading that darkens toward navy at the lower edge, and champagne-silver ribbons. The 787 half-tone is clearly visible in `commons/c_4X-ERB_2025-05-12_old_left.jpg` and `commons/c_4X-EDK_2025-08-20_old_right.jpg`. The start date is inferred from which frames carry it. (verified: the A2 half-tone band and fin are also visible on the 737 `commons/c_4X-EKO_2025-01-07_old_left34.jpg` and `commons/c_4X-EKU_2025-04-24_rear34_left.jpg`; the four A2 737s EKK, EKO, EKT, EKU are ex-UP frames, whose Commons photos from 2014–2016 show UP paint.) |
| **B: 2025 refresh (new)** | First seen on the brand-new 787-9 4X-EDN, spotted in the USA in August 2024 and delivered in May 2025 (airportspotting.com, dansdeals.com). The first 737 repaint was 4X-EKI, back in Tel Aviv on 10 March 2025 after a repaint in Ostrava (aerospaceglobalnews.com). | No silver or champagne. The titles are much larger and all blue. The band keeps the same path. The lower fin stripe is widened and runs down over the whole rear fuselage, the belly and the tail cone as one solid blue area. The Star of David is larger on the 737 (0.28 against 0.19 of the fin height) but not on the 787, where the A2 star is already 0.28 (corrected: was "The Star of David is larger", with no type given). The paint is a single medium blue (#0556A6). The press also reported that El Al "enhanced the Israeli flag colours on the tail" (AGN) (verified: dates and the 4X-EKI/Ostrava facts match AGN and Airways Magazine; AGN says three 737s had been repainted by 11 March 2025; 4X-EDN was photographed at Kelly Field, San Antonio, in August 2024). |

The press says the 737s carry "a lighter, brighter, more turquoise" blue than 4X-EDN (AGN). My sunlit samples cannot separate the two blues (see §3), so I treat them as one colour. (verified by re-sampling: after white correction the fins read about the same on both types, EKL fin #0D4285–#134A8D, EKH fin #08427E, EDN fin #064F85–#0F4D80. Airport Spotting and AGN both call the 787 blue "darker", but the photos do not show a difference larger than the lighting spread.)

### Tracked registrations

| Reg | Type | Scheme | Evidence photo | Photo date |
|---|---|---|---|---|
| 4X-EKA | B738 | A1 navy | `commons/c_4X-EKA_2025-05-13_old_right.jpg`; `planespotters/ps_4X-EKA.jpg` | 2025-05-13 |
| 4X-EKB | B738 | A1 navy | `commons/c_4X-EKB_2026-06-11_old_right34.jpg`; `planespotters/ps_4X-EKB.jpg` | 2026-06-11 |
| 4X-EKC | B738 | A1 navy | `planespotters/ps_4X-EKC.jpg` (photo id 1764681, the oldest photo in this set; Commons 2024-08-26 shows the same) | undated |
| 4X-EKK | B738 | A2 bright | `planespotters/ps_4X-EKK.jpg` | undated |
| 4X-EKO | B738 | A2 bright | `commons/c_4X-EKO_2025-01-07_old_left34.jpg`; `planespotters/ps_4X-EKO.jpg` | 2025-01-07 |
| 4X-EKT | B738 | A2 bright | `planespotters/ps_4X-EKT.jpg` | undated |
| 4X-EKU | B738 | A2 bright | `commons/c_4X-EKU_2025-04-24_rear34_left.jpg`; `planespotters/ps_4X-EKU.jpg` | 2025-04-24 |
| 4X-EKF | B738 | B new | `planespotters/ps_4X-EKF.jpg` (the Commons photo of 2024-11-03 still shows scheme A) | undated, after 2024-11 |
| 4X-EKH | B738 | B new | `commons/c_4X-EKH_2025-03-18_new_right.jpg`; `planespotters/ps_4X-EKH.jpg` | 2025-03-18 |
| 4X-EKI | B738 | B new | `planespotters/ps_4X-EKI.jpg`; AGN: first 737 repaint, March 2025 | undated |
| 4X-EKJ | B738 | B new | `planespotters/ps_4X-EKJ.jpg` | undated |
| 4X-EKL | B738 | B new | `commons/c_4X-EKL_2026-05-27_new_right34.jpg`; `planespotters/ps_4X-EKL.jpg` | 2026-05-27 |
| 4X-EKP | B738 | B new | `planespotters/ps_4X-EKP.jpg` (underside view, blue rear belly) | undated |
| 4X-EKS | B738 | B new | `planespotters/ps_4X-EKS.jpg` | undated |
| 4X-EHA | B739 | A1 navy | `commons/c_4X-EHA_2025-07-14_old_right.jpg`; `planespotters/ps_4X-EHA.jpg` | 2025-07-14 |
| 4X-EHB | B739 | A1 navy | `planespotters/ps_4X-EHB.jpg` | undated |
| 4X-EHC | B739 | A1 navy | `planespotters/ps_4X-EHC.jpg` | undated |
| 4X-EHD | B739 | A1 navy | `planespotters/ps_4X-EHD.jpg` | undated |
| 4X-EHE | B739 | A1 navy | `commons/c_4X-EHE_2024-09-02_old_right.jpg`; `planespotters/ps_4X-EHE.jpg` | 2024-09-02 |
| 4X-EHF | B739 | A1 navy | `planespotters/ps_4X-EHF.jpg` | undated |
| 4X-EHH | B739 | A1 navy | `planespotters/ps_4X-EHH.jpg` | undated |
| 4X-EHI | B739 | A1 navy | `commons/c_4X-EHI_2024-07-25_nose_right.jpg`; `planespotters/ps_4X-EHI.jpg` | 2024-07-25 |
| 4X-EDA | B789 | A2 bright | `commons/c_4X-EDA_2023-03-30_old_left.jpg`; `planespotters/ps_4X-EDA.jpg` | 2023-03-30 |
| 4X-EDB, EDC, EDD, EDE, EDH, EDI, EDJ, EDL | B789 | A2 bright | `planespotters/ps_4X-ED?.jpg`, one per registration | undated |
| (note) 4X-EDD | B789 | A2 bright | The Israel Airline Museum fleet page (updated 9 July 2025) lists EDD with "city promotional liveries (San Francisco & Las Vegas)". No such decals are visible on the right side in `planespotters/ps_4X-EDD.jpg`, so treat EDD as standard A2 (added). | — |
| 4X-EDK | B789 | A2 bright | `commons/c_4X-EDK_2025-08-20_old_right.jpg`; `planespotters/ps_4X-EDK.jpg` | 2025-08-20 |
| 4X-EDN | B789 | B new | `commons/c_4X-EDN_2025-05-16_new_left.jpg`; `planespotters/ps_4X-EDN.jpg` | 2025-05-16 |
| 4X-EDF | B789 | Special: 1960s retro | `commons/c_4X-EDF_2022-01-12_retro.jpg`; `planespotters/ps_4X-EDF.jpg` | 2022-01-12 |
| 4X-EDM | B789 | Special: "Jerusalem of Gold" | `commons/c_4X-EDM_2026-08-25_special.jpg`; `planespotters/ps_4X-EDM.jpg` | 2026-08-25 |
| 4X-ERA | B788 | A2 bright | `planespotters/ps_4X-ERA.jpg` | undated |
| 4X-ERB | B788 | A2 bright | `commons/c_4X-ERB_2025-05-12_old_left.jpg`; `planespotters/ps_4X-ERB.jpg` | 2025-05-12 |
| 4X-ERC | B788 | A2 bright | `commons/c_4X-ERC_2024-10-29_old_left34.jpg`; `planespotters/ps_4X-ERC.jpg` | 2024-10-29 |
| 4X-ERD | B788 | A2 bright | `planespotters/ps_4X-ERD.jpg` | undated |
| 4X-EKM, 4X-EKR, 4X-EKV | B738 | **Not El Al paint: Sun d'Or** (El Al subsidiary, flies under ELY callsigns) | `planespotters/ps_4X-EKM.jpg`, `ps_4X-EKR.jpg`; `ps_4X-EKV.jpg` shows ex-Southwest paint before conversion. Commons shows EKV in Sun d'Or livery in 2026. | — |

The planespotters API does not return a photo date, and the photo it returns is the one currently featured for the airframe. A frame shown in scheme A may therefore have been repainted since. The repaint programme is ongoing (AGN, March 2025).

(verified, all 42 thumbnails re-checked: every scheme assignment in the table matches the thumbnail. I also searched Commons by registration for newer dated photos. The newest dated evidence for each scheme-A 737-800 is: EKB 2026-06-11 (A1), EKA 2025-05-13, EKU 2025-04-24, EKO 2025-01-07, EKK 2024-09-05, EKC 2024-08-26, EKT 2023-05-19 (Commons), plus the undated featured thumbnails. For EKC, EKK and EKT the newest dated evidence is more than a year old, so these three are the most likely to have been repainted since. On the other types, all 737-900ER and 787 thumbnails show scheme A, and the Commons photos EHA 2025-07-14 and EDK 2025-08-20 confirm this.)

**Majority now:** of the 37 standard-liveried El Al frames tracked, **scheme A has 29** (11 in A1 navy, 18 in A2 bright) and **scheme B has 8**. The classic Ribbons scheme is the majority (verified: counts re-made from the thumbnails). By type, A is the majority on the 737-900ER, 787-9 and 787-8. The 737-800 is a **7 : 7 tie** on the evidence available, and the balance tips to B with any further repaint, so a 737-800 default should be scheme B if only one livery is built (added). By type:

| Type | Scheme A | Scheme B | Other |
|---|---|---|---|
| B738 | 7 | 7 | — |
| B739 | 8 | 0 | — |
| B789 | 10 | 1 (4X-EDN) | 2 specials |
| B788 | 4 | 0 | — |

**Exceptions:**

- **4X-EDF (1960s retro):** white upper fuselage, a blue window cheatline with thin pinstripes, small "EL AL · אל על" titles, and a blue fin with a white top and a small flag. (verified on `commons/c_4X-EDF_2022-01-12_retro.jpg`; added: the fin also has a white band along its leading edge, a winged emblem sits on the nose, and "ISRAEL AIRLINES" is written on the rear fuselage. The museum describes it as the design of the 1961 Boeing 707.)
- **4X-EDM ("Jerusalem of Gold", since 2019):** scheme A layout. The ribbons are gold, and the **whole title is gold**, including the Latin letters and the flag emblem (corrected: was "gold replacing the silver ribbons and the grey Hebrew letters", which implied that the Latin letters stay navy; see `commons/c_4X-EDM_2026-08-25_special.jpg`). The band and fin stripes are a very dark navy (raw #0E152F–#16263F, darker than A1). The gold reads raw #937E69–#9B7F57. The 2026-08-25 photo also shows a decal below the forward windows: a blue "LA", the text "2028 OFFICIAL AIRLINE" with a Hebrew line, a small Israeli flag and the Olympic rings (added). The frame was delivered in September 2019.
- **Sun d'Or frames:** white fuselage, yellow sun-ray fin and rear fuselage, cyan "SUNDOR" titles with an "EL AL GROUP" subtitle. They need their own dossier. The fallback is a plain white model.
- The Israel Airline Museum fleet page still lists 4X-EKI as Sun d'Or. That entry is out of date: AGN and the planespotters photo show it in El Al scheme B.

---

## 2. Reference images

Author and licence are copied from the source. Planespotters photos are reference only: they must not be redistributed or used as textures.

| File (relative to `data/livery-refs/ELY/`) | View | Reg | Source | Photographer / author | Licence |
|---|---|---|---|---|---|
| `planespotters/ps_4X-EDA.jpg` | 3/4 front right (from below) | 4X-EDA | https://www.planespotters.net/photo/1936510/4x-eda-el-al-israel-airlines-boeing-787-9-dreamliner | Kaan Can Ozdemir | reference only |
| `planespotters/ps_4X-EDB.jpg` | 3/4 front right (from below) | 4X-EDB | https://www.planespotters.net/photo/1938811/4x-edb-el-al-israel-airlines-boeing-787-9-dreamliner | Ronen fefer | reference only |
| `planespotters/ps_4X-EDC.jpg` | right side | 4X-EDC | https://www.planespotters.net/photo/1981831/4x-edc-el-al-israel-airlines-boeing-787-9-dreamliner | WJh | reference only |
| `planespotters/ps_4X-EDD.jpg` | right side | 4X-EDD | https://www.planespotters.net/photo/1925601/4x-edd-el-al-israel-airlines-boeing-787-9-dreamliner | Mukhammad-Rosul Mukhiddinov - Uzbekistan Spotters Team | reference only |
| `planespotters/ps_4X-EDE.jpg` | right side | 4X-EDE | https://www.planespotters.net/photo/1954246/4x-ede-el-al-israel-airlines-boeing-787-9-dreamliner | Z Song | reference only |
| `planespotters/ps_4X-EDF.jpg` | right side | 4X-EDF | https://www.planespotters.net/photo/1903348/4x-edf-el-al-israel-airlines-boeing-787-9-dreamliner | Gianluca Mantellini | reference only |
| `planespotters/ps_4X-EDH.jpg` | left side (from below) | 4X-EDH | https://www.planespotters.net/photo/1902119/4x-edh-el-al-israel-airlines-boeing-787-9-dreamliner | Daniel Pilkington | reference only |
| `planespotters/ps_4X-EDI.jpg` | right side | 4X-EDI | https://www.planespotters.net/photo/1950658/4x-edi-el-al-israel-airlines-boeing-787-9-dreamliner | HuoMingxiao | reference only |
| `planespotters/ps_4X-EDJ.jpg` | right side (from below) | 4X-EDJ | https://www.planespotters.net/photo/1944266/4x-edj-el-al-israel-airlines-boeing-787-9-dreamliner | Tejas Sandhu-PTSImages | reference only |
| `planespotters/ps_4X-EDK.jpg` | right side | 4X-EDK | https://www.planespotters.net/photo/1892102/4x-edk-el-al-israel-airlines-boeing-787-9-dreamliner | Rogerman747 | reference only |
| `planespotters/ps_4X-EDL.jpg` | left side | 4X-EDL | https://www.planespotters.net/photo/1860318/4x-edl-el-al-israel-airlines-boeing-787-9-dreamliner | Leon Cai | reference only |
| `planespotters/ps_4X-EDM.jpg` | right side | 4X-EDM | https://www.planespotters.net/photo/1974017/4x-edm-el-al-israel-airlines-boeing-787-9-dreamliner | Yuto Kiuchi | reference only |
| `planespotters/ps_4X-EDN.jpg` | right side (slight 3/4 rear) | 4X-EDN | https://www.planespotters.net/photo/1969208/4x-edn-el-al-israel-airlines-boeing-787-9-dreamliner | Elias Dieckert | reference only |
| `planespotters/ps_4X-EHA.jpg` | right side | 4X-EHA | https://www.planespotters.net/photo/1961974/4x-eha-el-al-israel-airlines-boeing-737-958er-wl | Demo Borstell | reference only |
| `planespotters/ps_4X-EHB.jpg` | right side | 4X-EHB | https://www.planespotters.net/photo/1917498/4x-ehb-el-al-israel-airlines-boeing-737-958er-wl | Gábor Szabados | reference only |
| `planespotters/ps_4X-EHC.jpg` | right side | 4X-EHC | https://www.planespotters.net/photo/1936333/4x-ehc-el-al-israel-airlines-boeing-737-958er-wl | Marvin Knitl | reference only |
| `planespotters/ps_4X-EHD.jpg` | right side | 4X-EHD | https://www.planespotters.net/photo/1964126/4x-ehd-el-al-israel-airlines-boeing-737-958er-wl | Christoph Flink | reference only |
| `planespotters/ps_4X-EHE.jpg` | left side | 4X-EHE | https://www.planespotters.net/photo/1976510/4x-ehe-el-al-israel-airlines-boeing-737-958er-wl | Gerrit Griem | reference only |
| `planespotters/ps_4X-EHF.jpg` | left side | 4X-EHF | https://www.planespotters.net/photo/1927572/4x-ehf-el-al-israel-airlines-boeing-737-958er-wl | Swisse | reference only |
| `planespotters/ps_4X-EHH.jpg` | left side | 4X-EHH | https://www.planespotters.net/photo/1929913/4x-ehh-el-al-israel-airlines-boeing-737-958er-wl | Marco Wolf | reference only |
| `planespotters/ps_4X-EHI.jpg` | left side | 4X-EHI | https://www.planespotters.net/photo/1980372/4x-ehi-el-al-israel-airlines-boeing-737-958er-wl | Jan Seler | reference only |
| `planespotters/ps_4X-EKA.jpg` | right side | 4X-EKA | https://www.planespotters.net/photo/1937060/4x-eka-el-al-israel-airlines-boeing-737-858-wl | Marvin Knitl | reference only |
| `planespotters/ps_4X-EKB.jpg` | left side | 4X-EKB | https://www.planespotters.net/photo/1895743/4x-ekb-el-al-israel-airlines-boeing-737-858-wl | Jan Seler | reference only |
| `planespotters/ps_4X-EKC.jpg` | 3/4 front right (from below) | 4X-EKC | https://www.planespotters.net/photo/1764681/4x-ekc-el-al-israel-airlines-boeing-737-858-wl | Ernest Leung | reference only |
| `planespotters/ps_4X-EKF.jpg` | right side | 4X-EKF | https://www.planespotters.net/photo/1950154/4x-ekf-el-al-israel-airlines-boeing-737-8hx-wl | Andrzej Makowski | reference only |
| `planespotters/ps_4X-EKH.jpg` | left side | 4X-EKH | https://www.planespotters.net/photo/1967953/4x-ekh-el-al-israel-airlines-boeing-737-85p-wl | Kees Marijs | reference only |
| `planespotters/ps_4X-EKI.jpg` | left side | 4X-EKI | https://www.planespotters.net/photo/1980236/4x-eki-el-al-israel-airlines-boeing-737-86n-wl | Markus Pichler | reference only |
| `planespotters/ps_4X-EKJ.jpg` | left side | 4X-EKJ | https://www.planespotters.net/photo/1979470/4x-ekj-el-al-israel-airlines-boeing-737-85p-wl | Wolfgang Kaiser | reference only |
| `planespotters/ps_4X-EKK.jpg` | right side | 4X-EKK | https://www.planespotters.net/photo/1843735/4x-ekk-el-al-israel-airlines-boeing-737-85r-wl | Mario Ferioli | reference only |
| `planespotters/ps_4X-EKL.jpg` | left side | 4X-EKL | https://www.planespotters.net/photo/1867746/4x-ekl-el-al-israel-airlines-boeing-737-85p-wl | Josh Knights | reference only |
| `planespotters/ps_4X-EKM.jpg` | right side | 4X-EKM | https://www.planespotters.net/photo/1926844/4x-ekm-sundor-boeing-737-804-wl | Mario Ferioli | reference only |
| `planespotters/ps_4X-EKO.jpg` | 3/4 front left | 4X-EKO | https://www.planespotters.net/photo/1942065/4x-eko-el-al-israel-airlines-boeing-737-86q-wl | Striteczky László | reference only |
| `planespotters/ps_4X-EKP.jpg` | 3/4 front left (from below) | 4X-EKP | https://www.planespotters.net/photo/1953338/4x-ekp-el-al-israel-airlines-boeing-737-8q8-wl | Stefano Beltrami | reference only |
| `planespotters/ps_4X-EKR.jpg` | right side | 4X-EKR | https://www.planespotters.net/photo/1912816/4x-ekr-sundor-boeing-737-804-wl | BjörnD | reference only |
| `planespotters/ps_4X-EKS.jpg` | 3/4 front left | 4X-EKS | https://www.planespotters.net/photo/1904204/4x-eks-el-al-israel-airlines-boeing-737-8hx-wl | Thomas Shum | reference only |
| `planespotters/ps_4X-EKT.jpg` | right side | 4X-EKT | https://www.planespotters.net/photo/1908076/4x-ekt-el-al-israel-airlines-boeing-737-8bk-wl | Menyhért Kristóf Bence | reference only |
| `planespotters/ps_4X-EKU.jpg` | left side | 4X-EKU | https://www.planespotters.net/photo/1946224/4x-eku-el-al-israel-airlines-boeing-737-8z9-wl | Daniel Filipe Francisco Silva | reference only |
| `planespotters/ps_4X-EKV.jpg` | 3/4 front left | 4X-EKV | https://www.planespotters.net/photo/1902480/4x-ekv-sundor-boeing-737-8h4-wl | Thomas Shum | reference only |
| `planespotters/ps_4X-ERA.jpg` | left side | 4X-ERA | https://www.planespotters.net/photo/1917751/4x-era-el-al-israel-airlines-boeing-787-8-dreamliner | Richard Toft | reference only |
| `planespotters/ps_4X-ERB.jpg` | right side | 4X-ERB | https://www.planespotters.net/photo/1980686/4x-erb-el-al-israel-airlines-boeing-787-8-dreamliner | Māuruuru | reference only |
| `planespotters/ps_4X-ERC.jpg` | right side | 4X-ERC | https://www.planespotters.net/photo/1908159/4x-erc-el-al-israel-airlines-boeing-787-8-dreamliner | Gianluca Mantellini | reference only |
| `planespotters/ps_4X-ERD.jpg` | left side (from below) | 4X-ERD | https://www.planespotters.net/photo/1922413/4x-erd-el-al-israel-airlines-boeing-787-8-dreamliner | Vince Hendriks | reference only |
| `commons/c_4X-EKH_2025-03-18_new_right.jpg` | right side (slight 3/4 rear) | 4X-EKH | https://commons.wikimedia.org/wiki/File:4X-EKH_Micha.jpg | LLHZ2805 | CC BY-SA 4.0 |
| `commons/c_4X-EKL_2026-05-27_new_right34.jpg` | 3/4 front right | 4X-EKL | https://commons.wikimedia.org/wiki/File:4X-EKL_B737-800,_El_Al,_Luton_05-27-26.jpg | DUNCAN KIRK | CC BY 4.0 |
| `commons/c_4X-EDN_2025-05-16_new_left.jpg` | 3/4 front left (from below) | 4X-EDN | https://commons.wikimedia.org/wiki/File:4X-EDN_Micha.jpg | LLHZ2805 | CC BY-SA 4.0 |
| `commons/c_4X-EKU_2025-04-24_rear34_left.jpg` | 3/4 rear left | 4X-EKU | https://commons.wikimedia.org/wiki/File:4X-EKU_El_Al_Israel_Boeing_737-800_24.04.2025_01.jpg | Wiki leylek | CC BY-SA 4.0 |
| `commons/c_4X-EKA_2025-05-13_old_right.jpg` | right side | 4X-EKA | https://commons.wikimedia.org/wiki/File:Boeing_737-858_(c-n_29957,_4X-EKA)_2025-05-13_Andre_Gerwing_Collection_ID_023619.jpg | André Gerwing | CC BY-SA 4.0 |
| `commons/c_4X-EKO_2025-01-07_old_left34.jpg` | 3/4 front left (from below) | 4X-EKO | https://commons.wikimedia.org/wiki/File:Boeing_737-86Q_(c-n_30287,_4X-EKO)_2025-01-07_Andre_Gerwing_Collection_ID_022723.jpg | André Gerwing | CC BY-SA 4.0 |
| `commons/c_4X-EKB_2026-06-11_old_right34.jpg` | 3/4 front right (from below) | 4X-EKB | https://commons.wikimedia.org/wiki/File:Boeing_737-858_(c-n_29958,_4X-EKB)_2026-06-11_Andre_Gerwing_Collection_ID_029726.jpg | André Gerwing | CC BY-SA 4.0 |
| `commons/c_4X-EHA_2025-07-14_old_right.jpg` | right side (from below) | 4X-EHA | https://commons.wikimedia.org/wiki/File:Boeing_737-958ER_(c-n_41552,_4X-EHA)_2025-07-14_Andre_Gerwing_Collection_ID_024414.jpg | André Gerwing | CC BY-SA 4.0 |
| `commons/c_4X-EHE_2024-09-02_old_right.jpg` | right side | 4X-EHE | https://commons.wikimedia.org/wiki/File:Boeing_737-958ER_(cn_41556,_4X-EHE)_2024-09-02_Andre_Gerwing_Collection_ID_021860.jpg | André Gerwing | CC BY-SA 4.0 |
| `commons/c_4X-EDK_2025-08-20_old_right.jpg` | right side | 4X-EDK | https://commons.wikimedia.org/wiki/File:Boeing_787-9_Dreamliner_(55004485125).jpg | Samson Ng . D201@EAL | CC BY-SA 4.0 |
| `commons/c_4X-EDA_2023-03-30_old_left.jpg` | left side | 4X-EDA | https://commons.wikimedia.org/wiki/File:4X-EDA_JFK_Taxiing_Out_22R_LY_B787_9_Ashdod_Beacon_Small_(52781213803).png (converted from PNG to JPEG) | Mark Bess | CC BY-SA 2.0 |
| `commons/c_4X-ERB_2025-05-12_old_left.jpg` | left side | 4X-ERB | https://commons.wikimedia.org/wiki/File:El_Al_Boeing_787-8_4X-ERB_at_Boston_May_2025.jpg | 4300streetcar | CC BY 4.0 |
| `commons/c_4X-ERC_2024-10-29_old_left34.jpg` | 3/4 front left (from below) | 4X-ERC | https://commons.wikimedia.org/wiki/File:20241029_141255_El_Al_Boeing_787-8_Dreamliner_%E2%80%93_4X-ERC.jpg | Mitchul Hope | CC BY-SA 2.0 |
| `commons/c_4X-EHA_2014-01-22_tail_left.jpg` | tail close-up (left side) | 4X-EHA | https://commons.wikimedia.org/wiki/File:4X-EHA_Boeing_739WL_ELAL_Tail_(12325792033).jpg | Aeroprints.com | CC BY-SA 3.0 |
| `commons/c_737_2012-08-19_winglet_inner.jpg` | winglet (inner face) | El Al 737-800, flight LY343; registration not identified | https://commons.wikimedia.org/wiki/File:El_Al_%D7%9B%D7%A0%D7%A4%D7%95%D7%9F.JPG | Michaelg2588 | CC BY-SA 3.0 |
| `commons/c_4X-EHI_2024-07-25_nose_right.jpg` | nose / forward fuselage close-up, right side | 4X-EHI (identified by the nose-gear door "HI" and the Hebrew name "Kiryat Malakhi") | https://commons.wikimedia.org/wiki/File:Israel_El_Al_Air_(53928809878).jpg | Tony Webster | CC BY 2.0 |
| `commons/c_4X-EDM_2026-08-25_special.jpg` | 3/4 front left (from below) | 4X-EDM | https://commons.wikimedia.org/wiki/File:4X-EDM.jpg | Liam Thompson | CC BY-SA 4.0 |
| `commons/c_4X-EDF_2022-01-12_retro.jpg` | right side | 4X-EDF | https://commons.wikimedia.org/wiki/File:4X-EDF_Boeing_787-9_EL_AL_(Retro)_LHR_12.1.22.jpg | Colin Cooke Photo | CC BY-SA 2.0 |
| `commons/c_4X-EKJ_2019_wing_winglet_inner.jpg` | wing top + winglet inner face (cabin view) | 4X-EKJ | https://commons.wikimedia.org/wiki/File:TLV_from_LY542,_2019_(03).jpg | Bahnfrend | CC BY-SA 4.0 |
| `logos/ELAL2023Logo.svg` | logo | — | https://commons.wikimedia.org/wiki/File:ELAL2023Logo.svg | El Al (trademark); uploaded by רונאלדיניו המלך | Public domain: {{PD-TEXT}}, which is also tagged {{self\|cc-by-4.0}} by the uploader, and {{trademarked}} (corrected: was "PD text logo; trademarked" without the CC BY 4.0 tag) |
| `logos/El_Al_logo_wordmark.svg` | logo | — | https://commons.wikimedia.org/wiki/File:El_Al_logo_wordmark.svg | El Al Israel Airlines Limited | Public domain ({{PD-logo}}, which redirects to PD-textlogo; {{Trademark}}) (verified) |
| `logos/El_Al_logo.svg` | logo | — | https://commons.wikimedia.org/wiki/File:El_Al_logo.svg | El Al | Public domain ({{PD-logo}}, which redirects to PD-textlogo), with {{tm}} and {{Israeli insignia}} (corrected: the insignia warning was missing) |
| `logos/El_Al.svg` | logo | — | https://commons.wikimedia.org/wiki/File:El_Al.svg | El Al | Public domain (PD-textlogo; trademarked) |
| `logos/El_Al_logo_1971–2007.svg` | logo | — | https://commons.wikimedia.org/wiki/File:El_Al_logo_1971%E2%80%932007.svg | El Al Israel Airlines Limited | Public domain (PD-textlogo; trademarked) |
| `logos/Flag_of_Israel.svg` | logo | — | https://commons.wikimedia.org/wiki/File:Flag_of_Israel.svg | Israel Belkind and Fanny Abramovitch (original design) | Public domain (insignia restrictions) |
| `commons/c_4X-EKH_2009-06-22_winglets_pushback.jpg` | 3/4 front right from above; the far (left) winglet's inner face; view over the crown | 4X-EKH (A1, 2009, with the old "ISRAEL AIRLINES / www.elal.com" subtitles, which are no longer carried) | https://commons.wikimedia.org/wiki/File:EL-AL-B737-800-with-winglets-during-pushback-at-zurich-airport.jpg | Roland Kemer | CC BY-SA 3.0 (added by the checker) |
| `commons/c_737_2012-08-19_LY343_wing.jpg` | wing root upper surface from the cabin (same flight as the winglet photo) | El Al 737-800, flight LY343 | https://commons.wikimedia.org/wiki/File:El_Al_LY343_%D7%9B%D7%A0%D7%A3.JPG | Michaelg2588 | CC BY-SA 3.0 (added by the checker) |

(verified: the checker read the licence and author of every Commons photo and logo through the Commons API, and they match this table. The 1600 px files are really 1920 px wide.)

Totals: 42 planespotters thumbnails (1.2 MB), 21 Commons photos at 1920 px (6.6 MB) and 6 SVG logos. The folder is about 7.9 MB (corrected: was 19 photos, "1600 px", 7.1 MB, before the checker added two files). One thumbnail was downloaded per tracked registration, so every frame has a scheme check.

---

## 3. Colours

I found no official El Al colour specification. The Commons wordmark SVGs are drawn by users. `ELAL2023Logo.svg` uses #193193, which does **not** match the paint on the aircraft. All values below were sampled on photos by me. I took the median of about 5×5-pixel patches, or the median of all blue pixels inside a region.

Where a photo's white fuselage was not close to white, I corrected the sample by the ratio (paint ÷ local white) × 245. This is labelled "corr." below.

| # | Name | Use | sRGB | Evidence (photo: raw → corrected) | Trust |
|---|---|---|---|---|---|
| 1 | **Fuselage white** | Base of fuselage, fin, nacelles, radome, winglets | **#F4F5F7** | ERB sunlit forward fuselage #F4F3F9; EKL #F7F7F9; EDK #F7F6FB; ERB nacelle #ECEBF2 | high |
| 2 | **New blue (scheme B)** | 2025 titles, band, rear fuselage, fin stripes, star, winglet stripe (737 and 787) | **#0556A6** | EKL rear upper fuselage median #0F57A1 (brightest 20% #0463B3), point #0762B2. Sunny planespotters thumbnails: EKF #0250A3, EKJ #0353A9, EKI #024F9A, EKS #1361B7, EDN fin #03549C. Shaded: EKL fin #165395, EDN Commons fin corr. #134E7F. Spread #024F9A–#0762B2. (verified by the checker's re-sampling. Sunlit fuselage near the window line: EKL #0F66B7, with local white #F0F3F4. Upper rear fuselage: EKH #0260A2 → corr. #0262AA; EDN #01467A → corr. #014F8A. Fins after white correction: EKL #0D4285–#134A8D, EKH #08427E, EDN #064F85–#0F4D80, and the sunlit EKJ thumbnail fin #0468BC. The fin reads darker than the upward-facing fuselage in most photos, and the checker judges this to be lighting, not a second paint. #0556A6 is a fair midpoint.) | medium-high |
| 3 | **Classic navy (A1)** | 1999-paint band, fin stripes, star, Latin letters, title flag emblem | **#262D70** | EHE band raw #222663 → corr. #2A2E72; EHE fin median #1B2158 → corr. #29317C; EKA band raw #2A3C6B (sky-lit, no correction); EHA thumbnail #1C2B6B; EHF thumbnail #132678; EHI title corr. #273550. Spread #1C2B6B–#2A3C6B. (verified; the checker's re-samples are slightly bluer: EKA band corr. #213172, EHE band corr. #293482, EHE fin corr. #282F80, hue 228–236°. A value of #282F78 would sit in the middle of all the samples, but #262D70 is within tolerance.) | medium |
| 4 | **Silver ribbon (A1)** | Ribbon under the band and on the fin (A1) | **#9DA1A8** | EHE ribbon ≈0.65 × local white → ≈#9EA4B2; EHI close-up ribbon 0.6–0.7 × white; EKA fin upper ribbon raw #9DA0A7. The paint is metallic, so its brightness changes with the angle. | medium-low |
| 5 | **Hebrew-letter grey (A)** | Hebrew letters of the classic title | **#A6A8AE** | EHE corr. #AAACB6; EKA raw #BBBBC3; the Commons 2007 wordmark uses a warmer #A39F91. (verified as a midpoint of a wide spread: the checker measured the EHI close-up per-channel corr. #B1B6BB (A1) and the sunlit ERB 787-8 (A2) at #98969B, core #8E8C91, which is a darker and slightly warm grey. On A2 frames #9A989D is the better match.) | medium-low |
| 6 | **Bright royal blue (A2)** | Band, fin stripes and star on the 787s and on EKK, EKO, EKT, EKU | **#0848A0** flat, or as a gradient from #2E7FD0 at the upper edge through #0848A0 to #0A2A66 at the lower edge | ERB (sunlit, well exposed) solid band #043E95, #07449D, #013989; the band's upper part #356ECE; the half-tone lower edge #032561; EDK fin (overcast) #025194. Thumbnails: ERC #0752A2, ERD #064592, EDD #04478D, EKO #023485, EKU #0B6EB5. (verified on ERB in sun: highlight on the upper band #6191E2, solid mid #1552AF, lower #033F90–#023581, fin upper stripe solid #084495. Added: on the fin stripes the half-tone runs *along* each stripe, from solid navy at one end to a light cyan-blue in the dotted part. EDK overcast reads #1FACD5 in the dotted part of the lower stripe and ERB reads #4174AE, so a flat texture needs a lighter dotted zone mid-stripe, not only a dark lower edge.) | medium |
| 7 | **Champagne ribbon (A2)** | Ribbons on the 787s and on EKK, EKO, EKT, EKU | **#BFB6A7** | EDK upper fin ribbon raw #A0988B, fin white #C8C8C6 → corr. ≈#C4BAAC. ERB fuselage ribbon (in shade) reads as neutral grey #74757B, so this could be a lighter silver. (verified as metallic and angle-dependent. The checker's samples: ERB in full sun, fin ribbon #B6B6B4–#CEC9C7 and fuselage ribbon #B4B1AF, which is warm silver with little yellow; EDK overcast, fin ribbons #BBB3AA–#C9C3BC and a darker patch #8C857B, which is beige. #BFB6A7 is a usable midpoint. Use #BCB9B7 if the sunlit look is wanted.) | low-medium |
| 8 | **Wing / tailplane grey** | Wings, horizontal stabiliser | **#D2D4D6** (Boeing light grey) | EKJ wing top in hard sun #DFDBDA / #E6DEDB (warm white balance); the ERB 787 stabiliser top reads near-white #DDE1F2 in sun. (Checker: not verifiable. Every ground-level photo shows only the underside of the stabiliser, in shadow, so its top colour is still an assumption. The 737 wing top is light grey in `c_4X-EKJ_2019_wing_winglet_inner.jpg`, raw #E3DAD2–#E7E0DD in hard sun with a warm white balance. Added: the 737 wing top has the standard black walkway outline and escape arrows behind the overwing exits, see `c_737_2012-08-19_LY343_wing.jpg`.) | low |
| 9 | **787 tail cone grey** | 787 APU tail cone | **#2E2E2E** | ERB #2E2E2D; EDN tail cone also dark (verified: ERB #303030) | medium |
| 10 | **Bare metal** | Nacelle inlet lips, winglet leading edge, 737 APU exhaust | **#B8BCC0** | Assumed. The winglet leading edge in `c_737_2012-08-19_winglet_inner.jpg` is unpainted metal. | low |

Notes:

- Colours 2 and 6 are close in hue (both about 208°). The A1 navy (#262D70) is clearly more violet (hue about 230°). My median blue hue per thumbnail was 222–230° for all 737-900ERs and for EKA and EKB, and 203–213° for all 787s and for the scheme-B 737s. (corrected: the checker's re-run on dark saturated pixels gives 222–236° for the 737-900ERs, 218° for EKA, 226° for EKB and 218° for EKC; 204–213° for the 787s; 207–214° for the scheme-B 737s; and 207–217° for the A2 737s. The two groups are still clearly separate.)
- For a single "El Al blue" per scheme, use #0556A6 for scheme B, #262D70 for A1 frames and #0848A0 for A2 frames.

---

## 4. Elements (side elevation)

### 4.0 Measured landmarks

These were measured on the photos. The model's own values are authoritative where they differ.

| Landmark | 737-800 (EKA, broadside right) | 737-900ER (EHE, broadside right) | 787-8 (ERB, broadside left) |
|---|---|---|---|
| Door 1 (L1/R1) | x 4.7–5.6 m | x 4.5–5.3 m (EHI close-up) | x 4.6–5.8 m |
| Window centreline | z ≈ 0.64 H ≈ 2.55 m (EHE) | same | z 3.67 m = 0.615 H |
| Door 2 / aft door | 737 aft door x 33.0–33.9 m | +2.6 m | 787-8 door 2 x 13.3–14.6 m, top z 4.63 m |
| Engine inlet lip | x ≈ 15 m | — | — |
| Dorsal fin start | x ≈ 30 m | — | — |
| Fin leading-edge root | x ≈ 34 m | — | — |
| Fin height above rear crown | ≈ 7 m | ≈ 7 m | ≈ 9.4 m |
| Fin tip trailing edge | x ≈ 40.4 m (overhangs the tail cone) | — | — |

For the 787-9, add 3.05 m forward of the wing and 3.05 m aft of it. These are the commonly cited plug lengths; I did not check them against a Boeing drawing. The forward plug sits between door 1 and door 2: the 787-8 has about 9 windows between those doors and the 787-9 about 14. So on the 787-9, door 2 is at about x 16.35–17.6 m.

For the 737-900ER, the commonly cited plugs are 1.57 m forward of the wing and 1.07 m aft of it.

### 4.1 Scheme A: "Ribbons" (29 frames)

**Fuselage base:** white #F4F5F7 everywhere, including the radome, belly, rear fuselage and tail cone. There is no separate belly colour and no nose band. The radome is the same white (EKA, EHI close-up).

**Fuselage band (the swoosh).** It is the same on both sides, mirrored. It is a single diagonal band, concave upward:

- It starts as a hairline on the crown above the wing's trailing edge.
- It widens as it runs forward and down.
- It crosses the window line ahead of the wing.
- It ends on the keel line just behind door 1, cut off by the keel.
- In the photos it reaches the keel on both sides. I assume it meets its mirror image under the belly, but no belly view was available to check. (Partly checked: the from-below views `commons/c_4X-EKO_2025-01-07_old_left34.jpg` (A2) and `planespotters/ps_4X-EKP.jpg` (B) show the band and its dotted ribbon running on across the visible part of the belly with no end cut. This is consistent with a wrap-under join. No photo shows the keel line itself.)
- (verified: the path is the same on A1 and B. The top edge crosses the window row ≈17.5 window pitches aft of door 1R on EKA (A1) and ≈16.7 on EKH (B), which is within one window. On EKA this is x ≈ 14.5 m, matching the table.)

737-800 band polyline, navy part (EKA, right side). Fractions of L and H are given so the table can be rescaled:

| x (m) | x/L | top edge z/H | bottom edge z/H |
|---|---|---|---|
| 27.1 | 0.687 | 1.00 (tip on crown) | 1.00 |
| 22.5 | 0.570 | 0.96 | 0.88 |
| 19.9 | 0.505 | 0.90 | 0.77 |
| 17.35 | 0.440 | 0.81 | 0.61 |
| 15.0 | 0.380 | 0.68 | 0.39 |
| 13.5 | 0.342 | 0.57 | 0.27 |
| 12.2 | 0.309 | 0.46 | 0.14 |
| 10.9 | 0.277 | 0.35 | 0.04 |
| 10.4 | 0.264 | 0.30 | 0 (bottom edge meets keel) |
| 9.6 | 0.243 | 0.23 | 0 |
| 8.35 | 0.212 | 0.11 | 0 |
| 7.3 | 0.186 | 0 (top edge meets keel) | 0 |

- The band's vertical depth is about 1.2 m (0.30 H) at mid-height. Its perpendicular width is about 1.0 m.
- **Silver ribbon:** a strip about 0.3 m deep (0.07 H) lies directly under the band's bottom edge, touching it. It runs from the keel (x ≈ 10.4–11.6 m) up to about x 19 m, where it tapers to nothing (EHE, EHI close-up, EHA). On the EHI close-up the band is 0.95 m deep and the ribbon 0.3 m deep, both measured vertically.
- On A2 frames the band has a half-tone shading that darkens toward the lower edge, plus a champagne ribbon (§3, colours 6 and 7).
- **737-900ER (EHE):** the same shape, moved aft by about 1.6 m. The top edge meets the keel at x ≈ 9.0 m, crosses the window line at about 17.3 m, and the tip reaches the crown at about 30–31.6 m. Precision is ±1 m.

787-8 band polyline, blue part (ERB, left side; H = 5.97 m):

| x (m) | x/L | top z/H | bottom z/H of blue plus half-tone |
|---|---|---|---|
| 37.5 | 0.66 | 1.00 (tip; the band runs along the crown from about 33.7 m) | 1.00 |
| 33.7 | 0.594 | 1.00 | 0.98 |
| 30.4 | 0.536 | 0.97 | 0.92 |
| 27.0 | 0.476 | 0.92 | 0.84 |
| 23.7 | 0.418 | 0.86 | 0.75 |
| 20.3 | 0.358 | 0.79 | 0.67 |
| 16.9 | 0.298 | 0.68 | 0.51 |
| 13.6 | 0.240 | 0.54 | 0.33 |
| 10.2 | 0.180 | 0.37 | 0.13 |
| 7.9 | 0.139 | 0.21 | 0 |
| 5.9 | 0.104 | 0 (front tip on keel, about 0.1 m aft of door 1) | 0 |

- The ribbon (A2 champagne, with dots) runs along the bottom edge. It is about 0.6 m deep (0.10 H) near the belly, with its aft end on the keel at x ≈ 10.5 m. It tapers out by about x 16 m.
- At door 2 the band's top edge is at z ≈ 3.3 m, so it covers the lower third of the door.
- **787-9 (EDK):** the same band, stretched by the forward plug. The front tip is on the keel at about 7.5 m (about 1.7 m aft of door 1). (verified on EDA: the front tip is ≈2.3 window pitches ≈1.4 m aft of door 1L, against ≈0 on the 787-8 ERB. The 787-9 forward artwork is laid out separately from the -8, and the title is larger too, see below.) The band still covers the lower third of door 2R, now at 16.35–17.6 m. The tip on the crown is at about 40 m (0.64 L). For polyline points aft of door 2, add 3.05 m to the 787-8 x values.

**Titles (both types).** The text is the bilingual El Al wordmark. From left to right it reads: Latin "EL", Hebrew "על" ("al"), Latin "AL", Hebrew "אל" ("el"), then the flag emblem (two horizontal bars with a small six-pointed star between them). This is the layout of `El_Al_logo_wordmark.svg`.

- **Colours:** Latin letters and flag emblem in classic navy #262D70 (the same on A2 frames). Hebrew letters in silver-grey #A6A8AE. (verified on the EHI close-up and on ERB: both Hebrew groups are grey, and "EL", "AL" and the flag are navy. On the A2 787 ERB the letter cores read very dark, #0A1232 in sun.) (corrected: was "There is a hairline white outline around the letters". An outline cannot be seen on white paint in any photo, so ignore it.)
- **Font:** a bold, heavy, slightly slanted geometric logotype (Dan Reisinger design). (verified in part: Commons files the El Al wordmark under the Dan Reisinger category. The 1999 *livery* is by Ruth Rahat, per the museum.)
- **The wordmark reads the same way on both sides; it is not mirrored.** (verified: right side on EKA, EHI, EHE, EDK, EKH and EKL; left side on ERB, EDA, EKO, EDN and EDM.)
  - Left side: the "EL" end starts just aft of door 1L and the flag emblem is at the aft end.
  - Right side: the flag emblem sits just aft of door 1R and "EL" is at the aft end.
  - The x-range is the same on both sides.
- **737-800 (EKA, EHI):**
  - x 6.1 to 12.4 m (length ≈ 6.2 m), starting about 0.5 m aft of door 1. (verified as fractions: 0.155–0.314 of the nose-to-tail-cone length on EKA. Note: scaling by the 20 in (0.508 m) window pitch instead gives a shorter 5.6–5.7 m on both EKA and the EHI close-up. The quoted L may not equal the nose-to-tail-cone length in a photo, so place the box by x/L or by windows (≈11 window pitches long, starting ≈1 pitch aft of door 1), not by absolute metres.)
  - The letter baseline is about 0.15 m above the window tops, at z ≈ 0.71 H.
  - Cap ("E") top at 0.84 H; Hebrew lamed ascenders reach 0.87 H (EHE, projected).
  - Projected cap height ≈ 0.55 m.
  - The side-view aspect (length ÷ E height) is about 11. The SVG's aspect is 9.8, so compress the SVG to about 0.9 of its height.
- **737-900ER (EHE):** the same box; measured x 6.9–13.3 m, within the ±0.7 m tolerance.
- **787-8 (ERB):**
  - x 6.1 to 13.2 m (length ≈ 7.1 m); on the 787-8 it ends just before door 2L. (verified: ERB title 212 px = 11.9 window pitches; it ends at door 2L.)
  - Baseline z ≈ 4.1 m (0.69 H), E top ≈ 4.75 m (0.80 H), ascenders ≈ 4.87 m (0.82 H).
- **787-9 (EDA left, EDK right): a larger box.** (corrected: was "The 787-9 uses the same box; door 2 is further aft, so the gap to door 2 is larger".) On the 787-9 the title fills almost the whole space between door 1 and door 2.
  - On EDA it is 285 px = 14.8 window pitches long, against 11.9 on the 787-8 ERB. On EDK it is 234 px = about 15 pitches.
  - x ≈ 6.7 to 15.7 m (length ≈ 9.0 m, ±0.5 m). It starts ≈1 m aft of door 1 and ends ≈0.6 m before door 2 (16.35 m). Both gaps are ≈1.3–1.9 window pitches on EDA and EDK.
  - Height ≈1.35× the 787-8 title: EDA 1.7 pitches against 1.24 on ERB. The baseline stays ≈0.2 m above the window tops (z ≈ 4.1 m). E top ≈ 5.0 m (≈0.84 H); ascenders ≈ 5.1 m (≈0.86 H), ±0.15 m.
  - Scale the same wordmark by about 1.25 in length and 1.35 in height from the 787-8 box.

**Fin (both types).** White base. Each stripe runs as a band across the fin, sloping down toward the leading edge. Each edge's leading-edge end is about 0.16–0.19 × fin height lower than its trailing-edge end.

Positions below are fractions of the fin height along the trailing edge, from the tip (0) to the root (1):

| Band | 737 A1 (EKA, EHA tail close-up) | 787 A2 (ERB, EDK) |
|---|---|---|
| White tip | 0–0.05 | 0–0.04 |
| Upper ribbon (silver or champagne) | 0.05–0.11 | 0.04–0.11 |
| Upper blue stripe | 0.11–0.265 | 0.11–0.24 |
| White field with star | 0.265–0.63 | 0.24–0.67 |
| Lower blue stripe | 0.63–0.76 | 0.67–0.79 |
| Lower ribbon | 0.76–0.82 | 0.79–0.85 |
| White | 0.82–1.00 | 0.85–1.00 |
| Star of David (blue outline hexagram) | height 0.19 of the fin, centred at 0.54, at about 62% of the local chord from the trailing edge | height 0.28 of the fin, centred at 0.52 |
| Forward extension | The lower blue stripe and its ribbon keep going forward along the dorsal fillet as a tapering double line, ending in a point on the crown at x ≈ 30.6 m (0.775 L) on the -800 and about 33.9 m (0.805 L) on the -900ER. (-800 verified on EKA: 0.774 L. -900ER corrected: the checker measures 0.785 L ≈ 33.0 m on EHE, where the tail cone is at px 253 and the nose at px 1866. The band's own crown end on EHE is at 0.754 L ≈ 31.7 m, which is at the aft end of the dossier's 30–31.6 m range.) | The lower pair tapers to a point about 1.4 m ahead of the fin's leading-edge root (x ≈ 45 m on the -8). |

The 787 star is larger than the 737 A1 star, and on the 787 the stripes and star carry the half-tone shading. On EDK the 787 fin leading edge looks champagne along its whole length. This is possibly a painted leading-edge strip, but confidence is low. (verified by the checker's trailing-edge colour scan on EKA: upper navy ≈0.13–0.25, lower navy ≈0.63–0.74/0.79, and star 0.19 of the fin height centred at 0.53. All are within ±0.02 of the table. Added: on the left side of ERB (sunlit) the fin leading edge is white, not champagne, so the EDK look is probably a reflection. Leave it white.)

**Tail cone:** 737 white, with a bare-metal APU exhaust. 787: the white fuselage ends in a dark grey cone (#2E2E2E), about the last 2 m.

**Horizontal stabiliser and wings:** Boeing light grey #D2D4D6. (corrected: was "No markings were seen". The 737 wing top carries the standard black walkway outline and two large black escape arrows behind the overwing exits, see `commons/c_737_2012-08-19_LY343_wing.jpg`. These are generic Boeing stencils, so they are optional. There are no El Al marks.)

**Engine nacelles:**
- 737 (CFM56-7B): white, with a bare-metal inlet lip. There are no titles or logos, and both engines look alike (EKA, EHE, EKO).
- 787 (Trent 1000): white, with a bare-metal inlet lip. The chevron trailing edge is white-grey with dark gaps. A small Rolls-Royce badge on the outboard side is the manufacturer's mark; skip it. There are no El Al marks. (verified on both faces: the outboard face on ERB and EDA (left side) and on EDK (right side), and the inboard face of the far engine on EDN. All show white nacelles with no airline marks. ERB nacelle white reads #ECEBF1 in sun. The 737 nacelles are also verified on EKA, EHE, EKH and EKL.)

**Winglet (737 blended winglet):**
- **Outer face:** white, with one diagonal blue stripe about 0.15 m wide at about 0.75–0.82 of the winglet height. It slopes down toward the leading edge. On A1 frames it is navy with a thin silver line under it (EKA, EKO). (verified on EKA: a pixel profile shows navy, then a ≈3 px grey band, then the winglet white.)
- **Inner face:** a miniature fin flag: white, with a ribbon over the upper blue stripe, a blue Star of David in the middle, and the lower blue stripe with a ribbon under it. It fills the **upper ≈40%** of the winglet, measured along the trailing edge from the tip; below that the face is plain white down to the root (corrected: was "upper 60%". In `c_4X-EKJ_2019_wing_winglet_inner.jpg` the tip is at y≈85, the lower ribbon ends at y≈200 and the blend into the wing is at y≈375). Also seen on the far winglet in `c_4X-EKH_2009-06-22_winglets_pushback.jpg`.
- The leading edge is bare metal (verified: a light metallic strip runs the full length of the leading edge in `c_737_2012-08-19_winglet_inner.jpg`).

**Other:**
- The aircraft name in small type sits under the cockpit windows. Skip it, along with the registration and the small "BOEING 737-800 / 787" and "DREAMLINER" texts. (corrected: was "in small Hebrew type". The museum says the names are in English on one side and in Hebrew on the other. The photos show Latin on the left side: ERB "HOD HASHARON", EDA "ASHDOD", EDM "JERUSALEM OF GOLD". They show Hebrew on the right side: EKA, EHI, EHE, EDK, EKL. The scheme-B EDN shows Hebrew on the left.)

### 4.2 Scheme B: 2025 refresh (8 frames: 737-800 EKF, EKH, EKI, EKJ, EKL, EKP, EKS; 787-9 EDN)

**Fuselage base:** white #F4F5F7. Radome white.

**Fuselage band:** the same path as the scheme A band, in new blue #0556A6. There is no ribbon and no half-tone.

- **737 (EKH, EKJ):**
  - Hairline tip on the crown at x ≈ 27.2 m (0.69 L).
  - The top edge crosses the window line at about 15–15.5 m.
  - The top edge meets the keel at x ≈ 6.9–7.3 m (0.18 L), about 1.5 m aft of door 1.
  - The bottom edge meets the keel at about 10.4 m.
  - Use the same z/H table as the 737 A band (§4.1).
- **787-9 (EDN):**
  - The front tip meets the keel about 0.8 m aft of door 1L (x ≈ 6.6 m).
  - The band covers the lower third of door 2.
  - It is visibly deeper than the scheme A blue: it fills the scheme A blue-plus-ribbon envelope (§4.1 787-8 table, bottom edge extended by the ribbon depth) and is solid blue throughout.
  - Its tip on the crown sits above the wing root, the same as on the 787-9 scheme A. It is partly hidden by the wing in both EDN photos.

**Rear-fuselage blue (new element):** everything below and aft of a single boundary is solid new blue: the belly, the rear fuselage, the tail cone and the lower fin. EKP's underside view shows the rear belly is blue, so the two sides join underneath.

- **Boundary on the 737-800:**
  - It meets the keel at x ≈ 28.4 m (0.72 L), about 4.5 m ahead of the aft door.
  - It rises aft as a nearly straight line, slightly concave (EKL), at about 40° to the horizontal.
  - It crosses the window line at about 32.1 m.
  - It reaches the crown at about 33.6 m (0.85 L). The aft door L2/R2 (33.0–33.9 m) therefore sits wholly inside the blue.
  - It then joins the fin's leading-edge root at about 34.1 m.
  - The white dorsal fin fillet (x 30–34 m) stays white (EKH, EKJ, EKL).
  - (verified on EKH by pixel scan. The aft door R2 outline is at px 535–567. The boundary crosses the aft window row ≈35 px (≈1.75 window pitches ≈0.9 m) ahead of the door. It reaches the belly ≈178 px (≈4.5 m) ahead of the door and the crown just aft of the door's forward edge. The line is straight to slightly concave at ≈37° and continues to the fin's leading edge. All match the numbers above.)
- **Boundary on the 787-9 (EDN):**
  - It meets the keel about 18.6 m forward of the tail-cone tip (x ≈ 44.2 m, 0.70 L).
  - It curves up, concave and steepening, and passes just forward of door 4L, so door 4 is inside the blue.
  - It reaches the crown and the fin's leading-edge root about 10.5 m forward of the tail tip (x ≈ 52.3 m, 0.83 L).
  - For a 787-8 it would be about 18.6 m and 10.5 m forward of the tail tip. This is an estimate: no 787-8 wears scheme B yet.
- **From the fin's leading-edge root**, the boundary follows the top edge of the lower fin stripe, rising aft to the fin's trailing edge.

**Fin (EKH, EKJ, EKL; EDN):** white. Positions are fractions of the fin height along the trailing edge, from the tip:

- **737:**
  - White tip 0–0.09.
  - New-blue upper stripe 0.09–0.24. Its edges slope down toward the leading edge by about 0.19 of the fin height across the chord.
  - White field 0.24–0.69.
  - Blue from 0.69 to the root, continuous with the rear-fuselage blue.
  - Star of David: a blue outline hexagram with thick lines, height 0.28 of the fin (about 1.9 m on the 737), centred at 0.55, at about 38% of the local chord from the leading edge. It is clearly larger and bolder than on 737 A1 frames.
  - (verified by a trailing-edge scan on EKH: white tip 0–0.09/0.10, upper stripe to 0.235, white field to 0.66, blue below. The star spans 0.27 of the fin, centred at 0.53. The 0.69 lower-blue start measured 0.66 here, which is inside the ±0.03 tolerance; use 0.67.)
- **787-9 (EDN):**
  - White tip 0–0.06.
  - Upper stripe 0.06–0.24.
  - White field to about 0.64.
  - Blue below.
  - Star height about 0.27, centred at about 0.47.

**Titles:** the same bilingual wordmark and non-mirrored reading as in scheme A, but **all in new blue**, including the Hebrew letters and the flag emblem. Use `ELAL2023Logo.svg`, recoloured from #193193 to #0556A6. The titles are much larger:

- **737-800 (EKJ left, EKH right):**
  - x ≈ 6.2 to 14.0 m (length ≈ 7.8 m), starting about 0.6 m aft of door 1. (verified as a ratio: the scheme-B title is 14.1 window pitches long on EKH, against 10.95 for the A1 title on EKA, so it is ≈1.29× longer.)
  - Baseline z ≈ 0.71 H, just above the windows (verified).
  - E top ≈ 0.86 H; highest point (the Hebrew lamed and the flag bar) ≈ 0.89 H (projected) (corrected: was E top 0.90 H and ascenders 0.94 H. The checker measured EKH at x = 1500 px, fuselage 621–787 px, title 640–669 px: baseline 0.71, E top 0.855, top 0.885. The EKF thumbnail gives baseline 0.70 and top 0.86.)
- **787-9 (EDN, both sides):**
  - x ≈ 6.6 to 19.0 m (length ≈ 12.5 m, ±0.5 m). It runs from about 0.8 m aft of door 1 to about 1.5 m past door 2, so the Hebrew "אל" and the flag pass over door 2.
  - The baseline is level with the top of door 2 (z ≈ 4.4–4.6 m, about 0.75 H).
  - Projected top ≈ 5.5 m (0.92 H). (not verified. The only large EDN photo is taken from below, which distorts z. The 737 heights above proved ≈0.04 H too high, so treat this as ≤0.90 H.)
  - (verified in x on `commons/c_4X-EDN_2025-05-16_new_left.jpg`: the title starts ≈0.7 m aft of door 1L, and the flag passes over door 2L, ending ≈1.8 m past it.)
  - In side projection the letters look vertically compressed (aspect about 13:1 against the SVG's 8.3:1) because they sit on the upper curve of the fuselage.

**Tail cone:**
- 737: new blue up to the bare-metal APU exhaust.
- 787-9: new blue, with a dark grey cone (#2E2E2E) at the tip (EDN).

**Stabiliser and wings:** Boeing light grey, unchanged.

**Nacelles:** white with bare-metal lips. No markings on either type.

**Winglet (737):** the outer face is white with one new-blue diagonal stripe at about 0.75–0.82 of its height, with no silver (EKH). The inner face shows the flag design: blue stripes and a Star of David (visible on the far winglet in EKL). (verified on EKH and EKL: a pixel profile shows no grey band under the stripe, unlike A1. The EKL inner face shows two stripes and a star and no ribbons. Note: the winglet stripes read as dark as the fin, EKL outer face corr. #133B76 and inner face #193B71–#1E4679. Use the same blue as the fin.)

---

## 5. Side-elevation drawing steps

Nose at x = 0, drawn to the left; z up from the keel. The steps are for the 737-800; notes for the other types follow each list. The colour numbers refer to §3.

### Scheme A (classic; 29 frames), LEFT side

1. Fill the whole fuselage, fin and tail cone with white #F4F5F7.
2. Band: fill the polygon bounded by the §4.1 top-edge polyline, from the keel at x 7.3 m to the crown tip at x 27.1 m, and back along the bottom-edge polyline to the keel at x 10.4 m. Close it along the keel between 7.3 m and 10.4 m.
   - A1 frames: navy #262D70.
   - A2 frames: #0848A0, optionally shaded to #0A2A66 in the lower third of the band.
3. Ribbon: fill a 0.3 m-deep strip hugging the band's bottom edge from the keel (10.4 m to about 11.6 m) up to about x 19 m, tapering to zero width.
   - A1 frames: silver #9DA1A8.
   - A2 frames: champagne #BFB6A7.
4. Title box: x 6.1 to 12.4 m, z 0.71 H to 0.87 H. Place the classic wordmark with "EL" at x 6.1 m and the flag emblem at the aft end. Latin letters and flag in #262D70, Hebrew letters in #A6A8AE.
5. Fin, using the trailing-edge fractions in §4.1, each edge sloping down toward the leading edge:
   - white tip;
   - ribbon;
   - upper blue stripe;
   - white field with a blue outline Star of David (0.19 of the fin height, centred at 0.54);
   - lower blue stripe;
   - ribbon.
6. Carry the lower stripe and its ribbon forward along the dorsal fillet as two tapering lines. They end in one point on the crown at x ≈ 30.6 m.
7. Tail cone: white. Registration and small texts: skip.

**Right side:** mirror steps 1–3 and 5–6. For step 4, do **not** mirror the text: the wordmark reads left to right in the image, with the flag emblem at the forward end (x 6.1 m, next to door 1R) and "EL" at the aft end (x 12.4 m).

**Other types:**
- **737-900ER:** the same steps. Shift the band and ribbon aft by about 1.6 m; the dorsal point is at about 33.0 m, 0.785 L (corrected: was 33.9 m; measured on EHE). The title box does not move.
- **787-8:**
  - Use the 787 band table: keel tip at 5.9 m, crown tip at 37.5 m.
  - Ribbon about 0.6 m deep, from the keel (8–10.5 m) up to about 16 m.
  - Title box x 6.1–13.2 m, z 4.1–4.87 m.
  - Fin: the 787 fractions, with a star of 0.28 fin height.
  - Tail cone: the last about 2 m in dark grey #2E2E2E.
  - All blues are A2.
- **787-9:** the same as the 787-8, with every band point aft of door 2 shifted aft by 3.05 m. The front tip is on the keel at about 7.5 m and the crown tip at about 40 m. The title box is **larger**: x 6.7–15.7 m, z 4.1–5.1 m, about 1.25× longer and 1.35× taller than on the 787-8 (corrected: was "The title box does not move"; see §4.1).

### Scheme B (2025 refresh; 8 frames), LEFT side

1. Fill everything with white #F4F5F7.
2. Band: the same polygon as scheme A step 2, in new blue #0556A6. There is no ribbon.
3. Rear blue: fill new blue #0556A6 below and aft of a line from the keel at x 28.4 m through the window line at x 32.1 m to the crown at x 33.6 m, curving very slightly concave. Continue it to the fin's leading-edge root at x 34.1 m, then up and aft along the top edge of the lower fin stripe, which reaches the trailing edge at 0.69 of the fin height from the tip. The blue covers the whole fuselage cross-section there, including the belly and the tail cone.
4. The dorsal fillet (x 30–34 m) stays white.
5. Fin:
   - white tip 0–0.09;
   - blue stripe 0.09–0.24, sloping down toward the leading edge;
   - white field with a thick-lined blue outline Star of David (0.28 of the fin height, centred at 0.55);
   - blue from 0.67–0.69 down to the root (part of step 3) (verified; EKH measures 0.66).
6. Title box: x 6.2 to 14.0 m, z 0.71 H to 0.89 H (corrected: was 0.72 H to 0.94 H). Use the all-blue wordmark in #0556A6, with "EL" at the forward end on the left side.
7. Tail cone: blue, with a bare-metal APU exhaust.

**Right side:** mirror everything except the title. On the right side the flag emblem is at the forward end (x 6.2 m) and "EL" at the aft end (x 14.0 m).

**787-9:**
- Band front tip on the keel at about 6.6 m. The band is deeper: it covers the scheme A blue-plus-ribbon envelope and the lower third of door 2.
- Rear blue: from the keel at x ≈ 44.2 m to the crown and fin leading-edge root at x ≈ 52.3 m.
- Fin: star 0.27 of the fin height, centred at 0.47; upper stripe 0.06–0.24; white field to about 0.64.
- Title box x 6.6–19.0 m, z 4.5–5.5 m (x verified; the top z is not verified and is probably ≤0.90 H, see §4.2).
- Tail cone tip dark grey.

---

## 6. Logos and wordmarks

| Graphic | Commons file | Licence | Downloaded to | Use |
|---|---|---|---|---|
| All-blue bilingual wordmark with flag emblem (scheme B titles) | https://commons.wikimedia.org/wiki/File:ELAL2023Logo.svg | Public domain {{PD-TEXT}}; the uploader also added {{self\|cc-by-4.0}}; {{trademarked}} (corrected: the CC BY 4.0 tag was missing. The file is free either way, and crediting "רונאלדיניו המלך, CC BY 4.0" covers the CC reading.) | `logos/ELAL2023Logo.svg` | Yes. Recolour #193193 to #0556A6. (verified: single fill #193193 in the file; the render matches the scheme-B titles.) |
| Two-tone wordmark (scheme A titles: Latin plus flag in one colour, Hebrew in grey) | https://commons.wikimedia.org/wiki/File:El_Al_logo_wordmark.svg | Public domain ({{PD-logo}}, which redirects to PD-textlogo; {{Trademark}}) (verified) | `logos/El_Al_logo_wordmark.svg` | Yes. Recolour black to #262D70 and grey #A39F91 to #A6A8AE. The same glyph layout as ELAL2023Logo. (verified by rendering: the paths draw only black and #a39f91. The file also declares unused fills #51678e and #90cdf0.) |
| Navy plus light-blue wordmark variant | https://commons.wikimedia.org/wiki/File:El_Al_logo.svg | Public domain ({{PD-logo}}), with {{tm}} and {{Israeli insignia}} (corrected: the insignia tag was missing) | `logos/El_Al_logo.svg` | Not needed. It is a backup source of the glyph shapes. (Its Latin letters are light blue #63C7EF and its Hebrew letters and flag navy #1B358F.) |
| Small two-tone wordmark | https://commons.wikimedia.org/wiki/File:El_Al.svg | Public domain (PD-textlogo; {{Trademarked}}) (verified) | `logos/El_Al.svg` | Not needed. (Dark slate #264756 Latin, light blue #008BD0 Hebrew, on a square canvas.) |
| 1971–2007 blue and gold wordmark | https://commons.wikimedia.org/wiki/File:El_Al_logo_1971%E2%80%932007.svg | Public domain ({{PD-logo}}; {{Trademark}}) (verified) | `logos/El_Al_logo_1971–2007.svg` | Only for the 4X-EDF retro, if it is ever modelled. |
| Star of David, from the Israeli flag (fin and winglet) | https://commons.wikimedia.org/wiki/File:Flag_of_Israel.svg | Public domain ({{PD-Israel}}, {{PD-flag}}; {{Israeli insignia}} restrictions) (verified) | `logos/Flag_of_Israel.svg` | Yes. Take the hexagram path. The flag blue #0038B8 is *not* the aircraft blue. On the aircraft the star is an outline hexagram: the flag's own interlaced-triangle outline, stroke about 1/9 of the star's height. |
| "Logo of El Al Israel Airlines" (blue and gold) | https://commons.wikimedia.org/wiki/File:Logo_of_El_Al_Israel_Airlines.svg | CC BY-SA 3.0; {{trademarked}} (verified) | not downloaded | Not needed. |
| Boeing "DREAMLINER" and Rolls-Royce badges | — | Trademarks, not free | — | Leave out. |

All the wordmark files are free (PD-textlogo), so no font substitution is needed. If a typeset fallback is ever needed, the closest OFL Google Font covering Latin and Hebrew is **Rubik Bold Italic** (700). The real logotype is a custom, slanted, heavy geometric design that no font reproduces exactly.

---

## 7. Geometry facts for the model

- **737-800 / 737-900ER wingtips:** Aviation Partners **blended winglets** (single upward surface) on every El Al 737 photographed: EKA, EKH, EKL, EHA, EHE and others.
  - Height about 2.5 m above the wing tip; root chord about 1.5 m, tapering to about 0.6 m at the tip; leading edge swept about 45°. These figures are generic for the type, not measured.
  - No split-scimitar winglets were seen.
  - The -900ER has the same winglet.
  - (verified: every 737-800 and 737-900ER thumbnail and Commons photo shows the single blended winglet.)
- **737 engines:** CFM56-7B with the flattened-bottom nacelle. Plain nacelle trailing edge with no chevrons, white with a bare inlet lip.
- **787-8 / 787-9 engines:** **Rolls-Royce Trent 1000.** The Rolls-Royce badge is visible on the nacelles of ERB (787-8), EDK and EDN (787-9) (verified, and also on EDA and EDM). They have the serrated chevron trailing edge on the fan cowl. If the generic 787 model uses GEnx-1B nacelles, the chevrons still match, but the Trent's longer core exhaust cone and plug differ slightly.
- **787 wingtips:** raked wingtips with no winglet device. Paint them wing grey.
- **787 tail cone:** the dark grey APU cone is a standard 787 feature. It is dark on both schemes.
- **737-900ER:** has the extra mid-cabin exit door pair aft of the wing (visible on EHE). This is a model detail, not paint.
- **787-9 versus 787-8 stretch:**
  - The forward plug lies between door 1 and door 2 (window count 9 → about 14).
  - The -9 therefore has the same door-1 position as the -8, with door 2 about 3 m further aft.
  - The artwork anchored to door 1 (titles, band front) does not move. The band's crown tip moves with the wing. (corrected: on the 787-9 the forward artwork is **not** simply the 787-8 artwork. The scheme-A title is ≈1.25× longer and ≈1.35× taller and fills the space between the doors, and the band's front tip sits ≈1.4–1.7 m further aft of door 1. See §4.1.)

---

## 8. Confidence and open questions

**Confident:**
- Scheme identification per frame, from one current planespotters thumbnail per registration plus dated Commons photos.
- Element layout and colour roles for both schemes.
- The non-mirrored title on the right side.
- The blended winglets on the 737s and the Trent 1000 engines on the 787s.
- The majority figure: 29 classic against 8 new among the tracked standard frames. (verified. The 737-800 alone is 7 : 7.)

**Medium:**
- Band polylines: ±0.5 m in x, ±0.05 H in z. They come from a few broadside photos, and some of those photos carry perspective error.
- Title boxes: ±0.5 m.
- Fin fractions: ±0.03.
- New blue #0556A6 and A1 navy #262D70: about ±10 in each channel.

**Low:**
- Silver and champagne ribbon colours (metallic paint).
- Wing grey.
- The exact depth of the new 787 band. Only one Commons photo exists (EDN, taken from below), plus one planespotters thumbnail.

**Open questions:**

1. Planespotters photo dates are unknown. Scheme A frames (EKA, EKB, EKC, EKK, EKO, EKT, EKU, the 737-900ERs, the 787s) may be repainted into scheme B at their next heavy check. Re-check this dossier every few months.
2. Is the 787 scheme B blue really darker than the 737's, as AGN reports? My sunlit samples cannot separate them (EDN fin #03549C against 737 #0250A3–#0762B2).
3. No belly or top photos. Does the band cross under the belly to meet its mirror image? Does it wrap over the crown to meet the other side's tip? (Partly answered: the from-below EKO and EKP views show the band continuing across the belly, and EKP shows the scheme-B rear belly solid blue. The crown question is still open, with a lead. In the from-above 3/4 photo `c_4X-EKH_2009-06-22_winglets_pushback.jpg` (A1), the band's aft tip and the forward point of the fin-stripe dorsal extension meet at the same spot on the crown, so the ribbon reads as one line from belly to fin. In the side view EHE there is a ≈50 px (≈1.3 m) white gap on the crown line between the band's end (x ≈ 0.754 L) and the dorsal extension's point (x ≈ 0.785 L). This suggests the two join along the top centreline, which is invisible from the side. Low confidence: a model seen from above may need a thin blue line on the centreline between the two points.)
8. (added) 787-9 scheme-B title height: only a from-below photo exists. The 737-B title top was measured at ≈0.89 H, not 0.94 H, so the 787-9 value of 0.92 H is probably also high.
9. (added) Horizontal stabiliser top colour on both types: no photo shows it.
4. Is the A2 "bright-blue" sub-variant a deliberate 2017 revision of the classic scheme? It is inferred from the 787 deliveries and the ex-UP 737 repaints; no press source was found.
5. No 787-8 wears scheme B yet. The rear-blue position for a future 787-8 repaint is extrapolated from EDN.
6. Sun d'Or frames 4X-EKM, 4X-EKR and 4X-EKV fly under ELY callsigns but wear the Sun d'Or livery. They need their own dossier, or should fall back to plain white.
7. Horizontal stabiliser colour: I assumed Boeing grey. No top view was available.

### Sources (web)

- Israel Airline Museum, Chapter 9 "Blue and Silver Ribbons…" (1999 livery): https://www.israelairlinemuseum.org/el-al-israels-flying-star/chapter-9-blue-and-silver-ribbons-on-the-path-to-privatization-1996-2004/
- Israel Airline Museum, current fleet and liveries: https://www.israelairlinemuseum.org/el-al-fleet/el-al-fleet-current/
- Aerospace Global News, "El Al introduces a modified livery" (4X-EKI, Ostrava, March 2025): https://aerospaceglobalnews.com/news/el-al-introduces-a-modified-livery/
- Airport Spotting, "El Al quietly introduces updated livery" (4X-EDN): https://www.airportspotting.com/el-al-quietly-introduces-updated-livery/
- DansDeals, first 787 in the updated livery, arrived 16 May 2025: https://www.dansdeals.com/more/news/airline-news/el-al-receives-first-dreamliner-in-updated-livery-named-acheinu-kol-beit-yisrael-via-air-china/
- AirlineGeeks, "Livery of the Week: El Al": https://airlinegeeks.com/2024/11/29/livery-of-the-week-el-al-israel-airlines/
- Wikipedia, "El Al" (fleet counts; 4X-EDF retro): https://en.wikipedia.org/wiki/El_Al
- (added by the checker) Airways Magazine on X, 4X-EKI rolled out of Ostrava on 10 March 2025: https://x.com/airwaysmagazine/status/1899409889736155526
- (added by the checker) Airways Magazine on Threads, 4X-EDN at Kelly Field, August 2024: https://www.threads.com/@airwaysmag/post/C_OKOKMKX5-
- (added by the checker) Wikimedia Commons licence templates for the logo files, read through the Commons API (PD-logo redirects to PD-textlogo).

### Checker's note (2026-09-29)

An independent check re-opened every photo in `data/livery-refs/ELY/`, re-sampled the colours, traced edges by pixel scans on EKA, EKH, EHE, ERB, EDA and EDK, and read every Commons licence through the API. Every scheme assignment and the 29 : 8 count held. The largest corrections were these:

- The 787-9 scheme-A title is larger than the 787-8's (§4.1).
- The winglet inner-face flag fills ≈40% of the winglet, not 60%.
- The scheme-B 737 title top is ≈0.89 H, not 0.94 H.
- The 4X-EDM title is all gold.
- The ELAL2023Logo licence also carries CC BY 4.0.
- The aircraft names are in English on the left side and Hebrew on the right.

Two files were added: `commons/c_4X-EKH_2009-06-22_winglets_pushback.jpg` and `commons/c_737_2012-08-19_LY343_wing.jpg`. Commons has no further 2025–2026 photos of scheme-B frames: the checker listed the categories for 4X-EDN, EKF, EKH, EKI, EKJ, EKL, EKP and EKS, and the only such photos are the EKH, EKL and EDN files already here. So a large left-side photo of a scheme-B 737 and a right-side photo of 4X-EDN are still available only as planespotters thumbnails.
