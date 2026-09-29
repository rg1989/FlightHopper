# Wizz Air (WZZ / WMT / WUK): Airbus A321neo (A21N) livery dossier

Research date: 2026-09-29. Refs folder: `data/livery-refs/WZZ/` (git-ignored). All paths that start with
`commons/`, `ps/`, `logos/` or `api/` are relative to that folder. Wizz Air Hungary (WZZ), Wizz Air Malta (WMT) and
Wizz Air UK (WUK) use the same paint. I looked at each photo (the full frame plus zoomed crops). I measured the
positions and colours from the pixels.

**Independent check (2026-09-29):** a second agent re-opened every stored photo, re-traced L1, L2 and the fin line
by pixel scan on `9H-WDX_left` and `HA-LZW_right`, re-sampled the colours, read every Commons licence through the
API, re-viewed all 42 Commons fleet photos and the 23 "viewed, not stored" planespotters thumbnails (scratch copies,
not stored), and checked fleet histories on planelogger.com. Each checked claim is marked "(verified)"; each fix is
marked "(corrected: was ...)". One file was renamed: `commons/G-WUKR_top-3q-front-left_2025-08-11.jpg` →
`commons/G-WUKR_top-3q-front-right_2025-08-11.jpg` (the photo shows the right side, see section 2).

Coordinate convention (the same as the other dossiers in this folder; side elevation, the same for both sides):

- **z** = metres aft of the nose tip (0 = radome tip; 44.51 = tip of the APU exhaust at the end of the tail cone).
- **h** = metres above the keel of the constant-section fuselage (0 = lowest line of the main fuselage;
  crown = 4.14). The fuselage is 3.95 m wide and 4.14 m high.
- Window row: window centres at h ≈ 2.6 (the windows are about 0.3 m high, h 2.45 to 2.75).

Scale sources:

- **Left side:** `commons/9H-WDX_left_2025-11-01.jpg` (1920 px copy; long-lens taxi shot from level ground, almost
  perpendicular). The nose tip is at x = 311.5 px and the tail-cone tip at x ≈ 1838 px. 1526.5 px = 44.51 m, so the
  scale is 34.3 px/m. The keel is at y = 812 px and the crown at y = 671 px. 141 px = 4.11 m (4.14 m expected), so
  the photo is true side-on.
- **Right side:** `commons/HA-LZW_right_2022-08-18.jpg` (nose tip at 1161 px, tail at 31 px, 25.4 px/m; keel at
  y = 419, crown at y = 313, 106 px = 4.17 m) and `commons/G-WUKU_right_2022-10-30.jpg` (nose tip at 1172 px, tail
  at 41 px, 25.4 px/m).

The left and right measurements agree to within 0.4 m. The right-side values are about 0.4 m further aft for every
landmark, which is most likely a bias in where I put the nose and tail tips. The values below are the means.
(verified: the doors show the same shift on `HA-LZW_right`: door 1 +0.2 m, door 3 +0.5 m, door 4 +0.4 m against
`9H-WDX_left`, so the offset is a scale/reference bias of the right photo, not an asymmetric paint scheme.)

---

## 1. Identity

**Scheme:** the Wizz Air livery introduced in 2015, together with the new "WIZZ" outline logo (verified: Wizz Air
press release of 19 May 2015, "refreshed brand and livery", 11th anniversary). It replaced the
2003–2015 scheme, which had filled purple and magenta "W!ZZ" letters. It is the standard scheme of the Wizz A321neo
fleet since the first delivery (HA-LVA, March 2019), and the 2026 photos (`9H-WNR` 2026-09-15, `9H-WMD` 2026-02-25)
show it unchanged (corrected: was "the only scheme on every Wizz A321neo"; a few A321neos wear specials, listed
below). The parts are (verified on `9H-WDX_left`, `HA-LZW_right`, `G-WUKU_right`, `9H-WNR_below-left`,
`9H-WMD_below-right`):

- a white forward fuselage with the large outline **WIZZ** logo (magenta-to-blue gradient outline, white inside)
  between door 1 and the wing;
- a straight diagonal line near the wing. Aft of it the fuselage is **magenta** all round (crown, sides and belly);
- a second straight diagonal line, less steep. Aft of it everything is **royal blue**. The same line continues up
  across the fin, which leaves a magenta triangle at the top and leading edge of the fin;
- a white **"wizzair.com"** title above the windows, between door 3 and the blue;
- a large white "wizzair.com" belly title;
- magenta engine nacelles with white "wizzair.com" titles;
- magenta Sharklets (wingtip devices), with "wizzair.com" on the inner face.

**Operators:** Wizz Air Hungary (HA- register), Wizz Air Malta (9H-) and Wizz Air UK (G-) are identical except for
the small flag above the registration (Hungarian, Maltese or British, which follows the register). Registrations and
flags are ignored here. (corrected: was "WZZ (HA-), WMT (9H-) and WUK (G-)". The tracked callsign prefix does not
follow the register: many 9H- aircraft fly as WZZ, e.g. 9H-WNF, and HA-LDL, HA-LGI and HA-LVW fly as WMT; see the
table below and `regs-survey.json`.)

**Exceptions among the tracked aircraft:**

- **HA-LDC:** special **"ABU DHABI"** livery (ex-Wizz Air Abu Dhabi). It has the standard base, but very large
  magenta and blue "ABU DHABI" letters run over the fin and the rear fuselage ("ABU" on the blue part of the fin,
  "DHABI" on the blue rear fuselage) (verified on the zoomed thumbnail). Evidence: `ps/HA-LDC.jpg` (the
  current planespotters API photo, id 1975007, Jost Gruchel). History (added): MSN 9503, delivered 2020-09-09 as
  **A6-WZA** to Wizz Air Abu Dhabi, re-registered HA-LDC for Wizz Air on 2025-10-15
  ([planelogger](https://www.planelogger.com/aircraft/Registration/HA-LDC/1216810)), so the photo (which shows
  "HA-LDC") dates from October 2025 or later. No free artwork exists for this livery, so paint HA-LDC with the
  standard scheme.
- **HA-LGI:** wore the **Team Hungary** (Paris 2024) special in 2024. See
  `commons/HA-LGI_right-TeamHungary_2024-09-02.jpg`: a gold fin with the Olympic rings, gold diagonal bands along
  the L1 and L2 lines, "TEAM HUNGARY" in white above the windows and "wizzair.com" moved below the windows
  (corrected: was "a gold fin, a 'TEAM HUNGARY' title and gold/blue rear fuselage"). Its current planespotters API
  photo (id 1965397, re-viewed) shows the **standard** scheme, so I treat it as standard (verified).
- (corrected: was "The other HA-LD\* aircraft (HA-LDB, LDG, LDI, LDK, LDL, LDP, LDU) are also ex-Abu-Dhabi
  A321neos".) HA-LD\* is simply Wizz Air Hungary's 2025–26 registration block. At least two of them are new-build
  aircraft, not ex-Abu-Dhabi: **HA-LDG** (MSN 12850, first flight 2025-11-17, delivered new 2025-11-26,
  [planelogger](https://www.planelogger.com/aircraft/Registration/HA-LDG/1219722)) and **HA-LDI** (MSN 12983,
  delivered new 2026-01-22, [planelogger](https://www.planelogger.com/Aircraft/Registration/HA-LDI/1222662)); HA-LDB
  is MSN 12891 (airfleets.net, from a search result; MSNs near 12850 first flew in late 2025, so it is probably
  new-build too). The histories of HA-LDK, LDL, LDP and LDU were not checked. All seven show the
  **standard** scheme in their current planespotters API photos (verified: re-viewed all seven).
- Other known specials are not tracked: 9H-WNM (20th-anniversary "Fly the Greenest" interwoven-leaves livery,
  July 2024; verified, Wizz Air press release) and 9H-WMR (250th aircraft, delivered 2025-11-20, "250" + logo and
  coloured ribbons; verified, AirlineGeeks 2025-12-05). Added: **9H-WDV** (not tracked) also wears the "ABU DHABI"
  fin/rear-fuselage letters (Commons "Wizz Air Malta Airbus A321neo 9H-WDV Milan Malpensa 2024 (01).jpg", viewed,
  not stored), so the Abu Dhabi variant is not limited to HA-LDC; an untracked aircraft may show it.

All 68 tracked registrations were checked. The "Commons" links are the newest Wikimedia Commons photo of that
aircraft. I viewed every one on contact sheets, and all show the standard scheme except where noted. "planespotters
(viewed, not stored)" means that I looked at the current API thumbnail but did not keep it (only 15 thumbnails are
stored in `ps/`). (verified: the table has exactly the 68 tracked registrations with the right callsign operator;
all 42 Commons links resolve and their EXIF dates match the "Evidence date" column; the 42 Commons photos and the
23 unstored planespotters thumbnails were re-viewed on contact sheets and all are standard. The planespotters photo
ids in the links match the current API answers. For 9H-WDX the link is `GDN_9H-WDX_1.jpg` while the stored file is
its sibling `GDN_9H-WDX_2.jpg`; both are 2025-11-01.)

| Registration (operator) | Scheme | Evidence photo(s) | Evidence date |
|---|---|---|---|
| 9H-WNF (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:9H-WNF_-_Airbus_A321-271NX_-_Wizz_Air_LGW_110225.jpg); `ps/9H-WNF.jpg` (+6 more) | 2025-03-02 |
| HA-LGH (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(cn_11709,_HA-LGH)_2024-07-14_Andre_Gerwing_Collection_ID_020688.jpg); `ps/HA-LGH.jpg` | 2024-07-14 |
| 9H-WNB (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_11748,_9H-WNB)_2026-03-01_Andre_Gerwing_Collection_ID_027978.jpg); `ps/9H-WNB.jpg` (+1 more) | 2026-03-01 |
| HA-LGO (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_11909,_HA-LGO)_2025-05-22_Andre_Gerwing_Collection_ID_023745.jpg); `ps/HA-LGO.jpg` | 2025-05-22 |
| 9H-WDI (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(cn_11303,_9H-WDI)_2023-11-20_Andre_Gerwing_Collection_ID_001916.jpg); `ps/9H-WDI.jpg` | 2023-11-20 |
| HA-LDC (WZZ) | **exception**: standard base + large "ABU DHABI" titles over fin and rear fuselage (ex-Wizz Air Abu Dhabi A6-WZA) | `ps/HA-LDC.jpg` | planespotters, undated (after 2025-10-15, when it became HA-LDC) |
| HA-LDB (WZZ) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1955622/ha-ldb-wizz-air-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WDK (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Wizz_Air_Malta,_9H-WDK,_Airbus_A321-271NX_(53209670577).jpg) | 2023-08-22 |
| HA-LVH (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:HA-LVH.jpg); `ps/HA-LVH.jpg` | 2022-04-09 |
| 9H-WDP (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_11291,_9H-WDP)_2026-04-16_Andre_Gerwing_Collection_ID_028473.jpg); `ps/9H-WDP.jpg` (+1 more) | 2026-04-16 |
| HA-LDG (WZZ) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1969062/ha-ldg-wizz-air-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| HA-LZU (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Wizz_Air,_HA-LZU,_Airbus_A321-271NX_(53210862405).jpg); `ps/HA-LZU.jpg` | 2023-08-24 |
| 9H-WNT (WZZ) | standard 2015 | `ps/9H-WNT.jpg` | planespotters, undated |
| HA-LDI (WZZ) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1924469/ha-ldi-wizz-air-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| HA-LZT (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_10893,_HA-LZT)_2026-01-18_Andre_Gerwing_Collection_ID_027750.jpg) | 2026-01-18 |
| HA-LVI (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_9333,_HA-LVI)_2025-12-17_Andre_Gerwing_Collection_ID_027581.jpg) | 2025-12-17 |
| HA-LDU (WZZ) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1980745/ha-ldu-wizz-air-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| HA-LDP (WZZ) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1958894/ha-ldp-wizz-air-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| HA-LGV (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_12575,_HA-LGV)_2026-05-22_Andre_Gerwing_Collection_ID_028953.jpg) | 2026-05-22 |
| 9H-WNR (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_12146,_9H-WNR)_2026-09-15_Andre_Gerwing_Collection_ID_031119.jpg); `commons/9H-WNR_below-left_2026-09-15.jpg` | 2026-09-15 |
| 9H-WMQ (WZZ) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1957232/9h-wmq-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| HA-LVK (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(cn_9444,_HA-LVK)_2024-08-25_Andre_Gerwing_Collection_ID_021779.jpg) | 2024-08-25 |
| HA-LGX (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_9429,_HA-LGX)_2026-01-24_Andre_Gerwing_Collection_ID_027837.jpg) | 2026-01-24 |
| HA-LZP (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_10875,_HA-LZP)_2025-12-08_Andre_Gerwing_Collection_ID_027539.jpg) | 2025-12-08 |
| 9H-WAS (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_11651,_9H-WAS)_2025-03-12_Andre_Gerwing_Collection_ID_022954.jpg) | 2025-03-12 |
| HA-LGN (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_11869,_HA-LGN)_2025-12-08_Andre_Gerwing_Collection_ID_027551.jpg) | 2025-12-08 |
| HA-LGT (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_12607,_HA-LGT)_2026-01-20_Andre_Gerwing_Collection_ID_027783.jpg) | 2026-01-20 |
| 9H-WDX (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:GDN_9H-WDX_1.jpg); `commons/9H-WDX_left_2025-11-01.jpg` | 2025-11-01 |
| HA-LZW (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_10929,_HA-LZW)_2026-04-06_Andre_Gerwing_Collection_ID_028227.jpg); `commons/HA-LZW_right_2022-08-18.jpg` | 2026-04-06 |
| HA-LGZ (WZZ) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1927277/ha-lgz-wizz-air-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WNX (WZZ) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1926973/9h-wnx-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WMB (WZZ) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Wizz_Air,_9H-WMB,_Airbus_A321-271NX_(54431445657).jpg); `commons/9H-WMB_left_2025-03-29.jpg` | 2025-03-29 |
| 9H-WAD (WZZ) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1969656/9h-wad-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| HA-LDK (WZZ) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1899709/ha-ldk-wizz-air-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WDL (WZZ) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1953186/9h-wdl-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| HA-LDL (WMT) | standard 2015 | `ps/HA-LDL.jpg` | planespotters, undated |
| 9H-WDU (WMT) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_11580,_9H-WDU)_2025-04-09_Andre_Gerwing_Collection_ID_023412.jpg) | 2025-04-09 |
| 9H-WMP (WMT) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1939762/9h-wmp-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WDH (WMT) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_11217,_9H-WDH)_2025-09-18_Andre_Gerwing_Collection_ID_025875.jpg) | 2025-09-18 |
| 9H-WMD (WMT) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_12567,_9H-WMD)_2026-02-25_Andre_Gerwing_Collection_ID_027930.jpg); `commons/9H-WMD_below-right_2026-02-25.jpg` | 2026-02-25 |
| 9H-WAT (WMT) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_10508,_9H-WAT)_2026-02-27_Andre_Gerwing_Collection_ID_027952.jpg); `ps/9H-WAT.jpg` (+1 more) | 2026-02-27 |
| 9H-WAQ (WMT) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_10393,_9H-WAQ)_2026-09-12_Andre_Gerwing_Collection_ID_031111.jpg) | 2026-09-12 |
| 9H-WML (WMT) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1967298/9h-wml-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WAI (WMT) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Wizz_Air,_9H-WAI,_Airbus_A321-271NX_(52728378243).jpg) | 2023-02-23 |
| 9H-WDJ (WMT) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(cn_11388,_9H-WDJ)_2024-07-13_Andre_Gerwing_Collection_ID_020642.jpg) | 2024-07-13 |
| 9H-WNH (WMT) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_11778,_9H-WNH)_2026-08-14_Andre_Gerwing_Collection_ID_030798.jpg) | 2026-08-14 |
| 9H-WAX (WMT) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1958522/9h-wax-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WAY (WMT) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1912673/9h-way-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WDM (WMT) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1967297/9h-wdm-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| HA-LGI (WMT) | standard 2015 now (current planespotters photo); **Team Hungary** special in 2024 | [planespotters](https://www.planespotters.net/photo/1965397/ha-lgi-wizz-air-airbus-a321-271nx) (viewed, not stored); `commons/HA-LGI_right-TeamHungary_2024-09-02.jpg` (2024 special) | planespotters, undated |
| HA-LVW (WMT) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_10509,_HA-LVW)_2026-09-09_Andre_Gerwing_Collection_ID_031054.jpg); `commons/HA-LVW_nose_2022-09-18.jpg` | 2026-09-09 |
| 9H-WMA (WMT) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1946835/9h-wma-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WAW (WMT) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1916562/9h-waw-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WMF (WMT) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1864903/9h-wmf-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WMI (WMT) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1950931/9h-wmi-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| 9H-WAP (WMT) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Wizz_Air_Malta,_9H-WAP,_Airbus_A321-271NX_(52599550802).jpg) | 2023-02-23 |
| 9H-WNQ (WMT) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1945261/9h-wnq-wizz-air-malta-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| G-WUKX (WUK) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Hamburg-Finkenwerder_Airport_Wizz_Air_UK_Airbus_A321-271NX_G-WUKX_(DSC09942).jpg); `ps/G-WUKX.jpg` | 2023-09-06 |
| G-WUNA (WUK) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:G-WUNA.jpg); `ps/G-WUNA.jpg` (+1 more) | 2025-02-15 |
| G-WUNC (WUK) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:G-WUNC_A321_WIZZ_AIR_(55113846261).jpg); `ps/G-WUNC.jpg` (+1 more) | 2026-02-24 |
| G-WUKM (WUK) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:G-WUKM,_Airbus_A321neo_of_Wizz_Air_UK_at_London_Luton_Airport_2025_001.jpg) | 2025-05-01 |
| G-WUKV (WUK) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:G-WUKV_Airbus_A321-271NX_-_Wizz_Air_UK_LGW_Approach_030525.jpg) | 2025-05-04 |
| G-WUNB (WUK) | standard 2015 | [planespotters](https://www.planespotters.net/photo/1842759/g-wunb-wizz-air-uk-airbus-a321-271nx) (viewed, not stored) | planespotters, undated |
| G-WUKO (WUK) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Wizz_Air_UK,_G-WUKO,_Airbus_A321-271NX.jpg) | 2022-10-11 |
| G-WUKW (WUK) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:G-WUKW_-_Airbus_A321-271NX_-_Wizz_Air_UK_LGW_Approach_030525.jpg) | 2025-05-04 |
| G-WUKU (WUK) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Wizz_Air_UK,_G-WUKU,_Airbus_A321-271NX_(52531902668).jpg); `commons/G-WUKU_right_2022-10-30.jpg` | 2022-10-30 |
| G-WUKR (WUK) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:At_Wikimania_2025_173.jpg); `commons/G-WUKR_top-3q-front-right_2025-08-11.jpg` (corrected: file was `..._top-3q-front-left_...`) | 2025-08-11 |
| G-WUNE (WUK) | standard 2015 | [Commons](https://commons.wikimedia.org/wiki/File:Wizz_Air_UK,_G-WUNE,_Airbus_A321-271NX_(53667239130).jpg) | 2024-04-16 |

---

## 2. Reference images

All 38 files are in `data/livery-refs/WZZ/` (verified: 15 `ps/` + 20 `commons/` + 3 `logos/`). The raw planespotters
API answers are in `api/*.json` (corrected: `api/9H-WDU.json` and `api/9H-WMP.json` held only "429 Too Many
Requests"; the checker replaced them with real answers, photo ids 1923020 and 1939762, both standard scheme). The Commons
images are the 1200–1920 px copies that Wikimedia served for the requested thumbnail. Commons dates are the EXIF
"taken" dates. (verified: every Commons licence, author and date below was re-read through the Commons API;
all match. The side labels of all 15 `ps/` thumbnails were re-checked and are right.)

| File | View | Registration | Source | Photographer / author | Licence | Date |
|---|---|---|---|---|---|---|
| `ps/9H-WAT.jpg` | right side (ground, low warm sun) | 9H-WAT | https://www.planespotters.net/photo/1729122/9h-wat-wizz-air-malta-airbus-a321-271nx | Jan Jurecka | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/9H-WDI.jpg` | left side (taxiing) | 9H-WDI | https://www.planespotters.net/photo/1946139/9h-wdi-wizz-air-malta-airbus-a321-271nx | Ben Yu | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/9H-WDP.jpg` | right side (taxiing) | 9H-WDP | https://www.planespotters.net/photo/1893291/9h-wdp-wizz-air-malta-airbus-a321-271nx | Tekler Zsolt | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/9H-WNB.jpg` | left side (taxiing) | 9H-WNB | https://www.planespotters.net/photo/1966838/9h-wnb-wizz-air-malta-airbus-a321-271nx | Rafal Pruszkowski | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/9H-WNF.jpg` | left side (take-off roll) | 9H-WNF | https://www.planespotters.net/photo/1928932/9h-wnf-wizz-air-malta-airbus-a321-271nx | Horváth Gábor | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/9H-WNT.jpg` | left side (taxiing) | 9H-WNT | https://www.planespotters.net/photo/1982206/9h-wnt-wizz-air-malta-airbus-a321-271nx | Michael Stappen | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/G-WUKX.jpg` | right side (flying) | G-WUKX | https://www.planespotters.net/photo/1956543/g-wukx-wizz-air-uk-airbus-a321-271nx | Severin Hackenberger | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/G-WUNA.jpg` | left side (climbing, from below) | G-WUNA | https://www.planespotters.net/photo/1941298/g-wuna-wizz-air-uk-airbus-a321-271nx | ALEXANDRU CHIRILA | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/G-WUNC.jpg` | left side (taxiing) | G-WUNC | https://www.planespotters.net/photo/1985922/g-wunc-wizz-air-uk-airbus-a321-271nx | José António Martins | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/HA-LDC.jpg` | right side (take-off) - special Abu Dhabi livery, exception | HA-LDC | https://www.planespotters.net/photo/1975007/ha-ldc-wizz-air-airbus-a321-271nx | Jost Gruchel | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/HA-LDL.jpg` | left side (flying, from below) | HA-LDL | https://www.planespotters.net/photo/1934315/ha-ldl-wizz-air-airbus-a321-271nx | Severin Hackenberger | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/HA-LGH.jpg` | left side (flying, from below) | HA-LGH | https://www.planespotters.net/photo/1903312/ha-lgh-wizz-air-airbus-a321-271nx | Hanjo Schrenk | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/HA-LGO.jpg` | right side (flying) | HA-LGO | https://www.planespotters.net/photo/1932202/ha-lgo-wizz-air-airbus-a321-271nx | Björn Huke | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/HA-LVH.jpg` | left side (flying, from below) | HA-LVH | https://www.planespotters.net/photo/1981479/ha-lvh-wizz-air-airbus-a321-271nx | Tekler Zsolt | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `ps/HA-LZU.jpg` | left side (flying) | HA-LZU | https://www.planespotters.net/photo/1974689/ha-lzu-wizz-air-airbus-a321-271nx | Borut Smrdelj | reference only (planespotters.net API thumbnail) | unknown (API gives no date) |
| `commons/9H-WDX_left_2025-11-01.jpg` | left side | 9H-WDX | https://commons.wikimedia.org/wiki/File:GDN_9H-WDX_2.jpg | Andrzej Otrębski | CC BY-SA 4.0 | 2025-11-01 |
| `commons/9H-WMB_left_2025-03-29.jpg` | left side | 9H-WMB | https://commons.wikimedia.org/wiki/File:Wizz_Air,_9H-WMB,_Airbus_A321-271NX_(54431445657).jpg | Anna Zvereva | CC BY-SA 2.0 | 2025-03-29 |
| `commons/9H-WDP_left_2025-03-23.jpg` | left side | 9H-WDP | https://commons.wikimedia.org/wiki/File:Wizz_Air,_9H-WDP,_Airbus_A321-271NX_(54430149703).jpg | Anna Zvereva | CC BY-SA 2.0 | 2025-03-23 |
| `commons/9H-WAT_left_2022-11-16.jpg` | left side | 9H-WAT | https://commons.wikimedia.org/wiki/File:Wizz_Air,_9H-WAT,_Airbus_A321-271NX.jpg | Anna Zvereva | CC BY-SA 2.0 | 2022-11-16 |
| `commons/HA-LZW_right_2022-08-18.jpg` | right side | HA-LZW | https://commons.wikimedia.org/wiki/File:Wizz_Air,_HA-LZW,_Airbus_A321-271NX.jpg | Anna Zvereva | CC BY-SA 2.0 | 2022-08-18 |
| `commons/G-WUKU_right_2022-10-30.jpg` | right side | G-WUKU | https://commons.wikimedia.org/wiki/File:Wizz_Air_UK,_G-WUKU,_Airbus_A321-271NX_(52531902668).jpg | Anna Zvereva | CC BY-SA 2.0 | 2022-10-30 |
| `commons/9H-WNB_right_2024-08-25.jpg` | right side | 9H-WNB | https://commons.wikimedia.org/wiki/File:Wizz_Air,_9H-WNB,_Airbus_A321-271NX_(54009695405).jpg | Anna Zvereva | CC BY-SA 2.0 | 2024-08-25 |
| `commons/G-WUNA_right_2025-02-15.jpg` | right side | G-WUNA | https://commons.wikimedia.org/wiki/File:G-WUNA.jpg | Mike Burdett | CC BY-SA 2.0 | 2025-02-15 |
| `commons/G-WUNC_3q-front-right_2026-02-24.jpg` | 3/4 front right | G-WUNC | https://commons.wikimedia.org/wiki/File:G-WUNC_A321_WIZZ_AIR_(55113846261).jpg | Jonathan Payne from Ayr, United Kingdom | CC BY-SA 4.0 | 2026-02-24 |
| `commons/9H-WNR_below-left_2026-09-15.jpg` | left side (from below: belly, outer face of left winglet) | 9H-WNR | https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_12146,_9H-WNR)_2026-09-15_Andre_Gerwing_Collection_ID_031119.jpg | André Gerwing | CC BY-SA 4.0 | 2026-09-15 |
| `commons/9H-WMD_below-right_2026-02-25.jpg` | right side (from below: belly, left engine inboard face, inner face of left winglet (its upper part is hidden by the fuselage), outer face of right winglet) | 9H-WMD | https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_12567,_9H-WMD)_2026-02-25_Andre_Gerwing_Collection_ID_027930.jpg | André Gerwing | CC BY-SA 4.0 | 2026-02-25 |
| `commons/G-WUKR_top-3q-front-right_2025-08-11.jpg` | top, 3/4 front **right**, from above: right side (logo "W" aft), right engine outboard face, inner face of the **left** Sharklet on the far wing (corrected: was `..._top-3q-front-left_...`, "3/4 front left"; the logo reads with the "W" at the aft end, which only happens on the right side) | G-WUKR | https://commons.wikimedia.org/wiki/File:At_Wikimania_2025_176.jpg | Mike Peel (www.mikepeel.net) | CC BY-SA 4.0 | 2025-08-11 |
| `commons/9H-WNF_3q-front-left_2024-07-14.jpg` | 3/4 front left | 9H-WNF | https://commons.wikimedia.org/wiki/File:9H-WNF_aircraft_at_Kutaisi_Airport,_2024_(01).jpg | Draceane | CC BY-SA 4.0 | 2024-07-14 |
| `commons/9H-WNF_engine_2024-07-14.jpg` | left engine from behind and above (exhaust, pylon, wing top, magenta belly fairing) | 9H-WNF | https://commons.wikimedia.org/wiki/File:9H-WNF_aircraft_at_Kutaisi_Airport,_2024_(10).jpg | Draceane | CC BY-SA 4.0 | 2024-07-14 |
| `commons/9H-WNF_tailcone_2024-07-14.jpg` | tail close-up (tail cone, stabiliser root) | 9H-WNF | https://commons.wikimedia.org/wiki/File:9H-WNF_aircraft_at_Kutaisi_Airport,_2024_(11).jpg | Draceane | CC BY-SA 4.0 | 2024-07-14 |
| `commons/9H-WNF_fin-tip_2024-07-14.jpg` | tail close-up (fin tip) | 9H-WNF | https://commons.wikimedia.org/wiki/File:9H-WNF_aircraft_at_Kutaisi_Airport,_2024_(12).jpg | Draceane | CC BY-SA 4.0 | 2024-07-14 |
| `commons/9H-WNF_winglet-inner_2024-07-14.jpg` | winglet (inner face, left wing) | 9H-WNF | https://commons.wikimedia.org/wiki/File:9H-WNF_aircraft_at_Kutaisi_Airport,_2024_(05).jpg | Draceane | CC BY-SA 4.0 | 2024-07-14 |
| `commons/9H-WNF_winglet-front_2024-07-14.jpg` | winglet (left wing from front, leading edge) | 9H-WNF | https://commons.wikimedia.org/wiki/File:9H-WNF_aircraft_at_Kutaisi_Airport,_2024_(02).jpg | Draceane | CC BY-SA 4.0 | 2024-07-14 |
| `commons/HA-LVW_nose_2022-09-18.jpg` | nose close-up (right side; strongly blue-tinted processing, not usable for colour) | HA-LVW | https://commons.wikimedia.org/wiki/File:DAV_2794-HA-LVW_-_Wizz_Air_Airbus_A321_NEO.jpg | DavidivardiIL | CC BY 4.0 | 2022-09-18 |
| `commons/HA-LGI_right-TeamHungary_2024-09-02.jpg` | right side (special Team Hungary livery, 2024; exception) | HA-LGI | https://commons.wikimedia.org/wiki/File:Wizz_Air_(Team_Hungary_Livery),_HA-LGI,_Airbus_A321-271NX_(54008581919).jpg | Anna Zvereva | CC BY-SA 2.0 | 2024-09-02 |
| `logos/Wizz_Air_logo_2015.svg` | logo (current 2015 outline Wizz wordmark, magenta-to-blue gradient) | - | https://commons.wikimedia.org/wiki/File:Wizz_Air_logo_2015.svg | Wizz Air | PD-textlogo (public domain) (verified; the page carries `{{PD-textlogo}}` and `{{SVG-Logo}}` but no `{{Trademarked}}` tag; the mark is still Wizz Air's) | 2015 |
| `logos/Wizz_Air_Logo_pressoffice.png` | logo + wizzair.com wordmark (press-office file; colour reference #D40F8C / #2E3192) | - | https://commons.wikimedia.org/wiki/File:Wizz_Air_Logo.png | Wizz Air Hungary Ltd. (press office) | Copyrighted free use (Wizz Air press office permission) | 2016-01-01 |
| `logos/Wizz_Air_logo_former.svg` | logo (FORMER 2003-2015 filled wordmark - NOT the current livery; kept only to document what the app uses today) | - | https://commons.wikimedia.org/wiki/File:Wizz_Air_logo.svg | Wizz Air | PD-textlogo (public domain, trademarked) | ~2003 |

Most useful: `commons/9H-WDX_left_2025-11-01.jpg` (the measurement master for the left side),
`commons/HA-LZW_right_2022-08-18.jpg` and `commons/G-WUKU_right_2022-10-30.jpg` (right side),
`commons/9H-WNR_below-left_2026-09-15.jpg` and `commons/9H-WMD_below-right_2026-02-25.jpg` (belly title, both engines,
both Sharklet faces), `commons/G-WUKR_top-3q-front-right_2025-08-11.jpg` (crown and the inner face of the left
Sharklet from above; corrected: was "...front-left..."), and `commons/9H-WNF_fin-tip_2024-07-14.jpg` / `commons/9H-WNF_tailcone_2024-07-14.jpg` (colour close-ups).

---

## 3. Colours

Official digital brand values come from Wizz Air's own press-office logo file (`logos/Wizz_Air_Logo_pressoffice.png`,
from wizzair.com's press-office "logos" page, on Commons as "copyrighted free use"). I counted the pixels: the two
flat colours are **#D40F8C** (magenta, "wizzair") and **#2E3192** (blue, ".com") (verified: 134 850 and 105 868
opaque pixels). The 2015 vector logo on Commons has a gradient from **#CD2B86** (top) to **#161998** (bottom)
(verified in the SVG source). A third-party site (brandcolorcode.com, "not given explicitly in the brand
guidelines") gives Pink **#D3007F** (Pantone 233 C) and Purple #312782 (Pantone 3591 C) (corrected: was "Pantone
233 C (≈ #C6007E)"; #C6007E is Pantone's own sRGB value for 233 C, not the site's hex). No official paint
specification was found.

Photo samples: medians of hand-placed boxes on flat, non-reflective areas. Where two boxes are given for a photo,
they were pooled. Hue (H) is in degrees.

| Paint | Recommended sRGB | Evidence and spread | Trust |
|---|---|---|---|
| **Wizz Magenta** (fuselage, fin top, nacelles, Sharklets) | **#D40F8C** | Official press file #D40F8C (H 322°). Pantone 233 C ≈ #C6007E (H 322°, the app's current value) is the same colour for practical purposes. Photos: fuselage in sun #E54498 (`HA-LZW_right`, H 329°), #CA3285 (`G-WUKU_right`, H 327°); overcast #E34FA6 (`9H-WMB_left`), #95345F (`9H-WDX_left`, dim light); in flight #A60872 (`9H-WMD_below-right`). (verified by re-sampling: #E8469A `HA-LZW_right` above the windows, #CC3386 `G-WUKU_right`, #E552AA `9H-WMB_left`, #D65AA5 `9H-WAT_left`, #D74B8F `9H-WNB_right`, #CA518D `G-WUNC_3q-front-right`; added: in-flight sunlit fin #D224A4 (`9H-WNR_below-left`, H 316°) and #A80876 (`9H-WMD_below-right`, H 319°).) Fin: #E35297, #B22F74, #B13073, #843456, #A80876, #BA5596 (`9H-WNF_fin-tip`, dusk). Photo hue 319–334°, median about 328°. | High. The photos are a few degrees pinker than the brand value, which is inside the lighting spread. |
| **Wizz Blue** (rear fuselage, lower fin, tail cone) | **#1E3394** | Official press file #2E3192 (H 238°); SVG logo bottom #161998 (H 239°). Photos: fin in sun #2840A3 (`HA-LZW_right`, H 228°), #061B8B (`G-WUKU_right`, H 231°), #192E88 (`9H-WMB_left`, H 229°), #161B8F (`9H-WMD_below-right`, H 238°), #1B294E (`9H-WDX_left`, overcast); close-ups #3E4D95 (`9H-WNF_fin-tip`, H 231°), #2E428D (`9H-WNF_tailcone`, H 227°). Photo hue 224–238°, median 229°, S ≈ 0.8. (verified by re-sampling: sunlit fin #2942A7 `HA-LZW_right` H 228°, #061B8B `G-WUKU_right` H 231°, #22409A `9H-WNB_right` H 225°, #2B43AC `9H-WMB_left` H 229°; added: the two in-flight photos against blue sky come out more violet, fin #3236B4 (`9H-WNR_below-left`, H 238°) and #14188C (`9H-WMD_below-right`, H 238°), i.e. at the brand hue. Ground photos give 221–231°, so the hue depends on the light; the all-photo median is still 229°.) | Medium-high. The paint is a saturated **royal blue**, slightly less violet than the brand's digital #2E3192. #1E3394 is the photo median (H 229°, S 0.80, V 0.58). #2E3192 is an acceptable alternative. The app's current `fin2` #3a1e6e (purple) is too violet. |
| **White** (forward fuselage, radome) | **#F4F5F2** | #F0F1EC (`HA-LZW_right`, sun), #DCE2DF (`G-WUKU_right`, sun), #C9BFB6 (`9H-WDX_left`, overcast), #B3AEAC (`9H-WMB_left`, overcast). | High (plain white). |
| **Logo outline gradient** | **#CD2B86 → #161998** (top → bottom) | From the official vector `logos/Wizz_Air_logo_2015.svg`. On the aircraft the top strokes are magenta and the bottom strokes are navy (`9H-WDX_left`, `HA-LVW_nose`). | High. Use the SVG as it is. |
| **Wing and tailplane grey** | **#B6BBBF** | Standard Airbus light grey (not a Wizz colour). The samples are contaminated by reflections: #80878A (tailplane top, `G-WUKR_top-3q-front-right`; corrected file name, was `...front-left`), #728AAD (wing top, which reflects the blue sky). | Low-medium (an estimate). |
| **Light-grey fairings** (tailplane root fairing, Sharklet leading-edge band) | **#D2D4D6** | Close-up `9H-WNF_tailcone` (tailplane root fairing, very light grey); `9H-WMD_below-right` and `9H-WNR_below-left` (Sharklet leading edge, white/light grey). | Medium. |
| **Inlet lip** (bare metal) | **#C5C3C0** | #C5BEB7 (`HA-LZW_right`, lip in sun). | Medium. |
| **Engine core, exhaust, APU nozzle** | **#4A4D52** | Dark metal in `9H-WNF_engine` and `9H-WDX_left`. | Medium (an estimate). |
| **Cockpit window surround** | **#16181C** | Near-black band around the cockpit windows, `HA-LVW_nose`. (verified as near-black with a slight blue cast: darkest-fifth samples #0F1326 `9H-WNR_below-left`, #020710 `G-WUKU_right`, #01030E `9H-WMD_below-right`. `HA-LVW_nose` renders it navy #0A3860, but that photo is strongly blue-processed: its white radome samples #C3D2EA.) | High. |

---

## 4. Elements (side elevation)

Type landmarks that I measured (mean of the left and right sides):

| Landmark | z (m aft of nose) | h (m above keel) |
|---|---|---|
| Cockpit windows | 1.4 – 3.0 | 2.2 – 2.9 |
| Door 1 (L1/R1) | 4.3 – 5.4 | 1.45 – 3.45 |
| Engine inlet lip / rear of the fan cowl and reverser | 14.2 / 18.2 | nacelle from +1.1 down to −1.45 (it hangs below the keel) |
| Over-wing exits (2 per side, Type III) | 17.9 – 18.6 and 18.7 – 19.4 | 1.9 – 3.2 |
| Door 3 (aft of the wing) | 26.2 – 27.1 | 1.6 – 3.3 |
| Door 4 (rear) | 35.9 – 36.8 | 1.6 – 3.3 |
| Fin leading edge where it leaves the dorsal fillet | about 37.0 | 4.7 |
| Fin tip (leading-edge corner / trailing-edge corner) | 41.9 / 43.7 (corrected: was "42.0 – 42.7 / 43.7"; pixel scan of `9H-WDX_left` gives a 1.8 m tip chord from z 41.9 to 43.7 at h 10.2, which matches the 1.8 m tip chord in section 7) | about 10.2 (verified: 10.25) |
| Fin trailing-edge root | about 42.2 | about 4.0 |
| Tailplane (seen in side view) | 39.0 – 42.8 | 2.3 – 3.5 |

**Fuselage base colour:** white #F4F5F2 from the radome tip (z 0) to line L1. There is no cheatline and no grey
belly (verified). The white covers the full circumference forward of L1, including the belly and the forward part of the belly
fairing (`9H-WNR_below-left`, `9H-WMD_below-right`).

**Line L1 (white to magenta):** a straight line, the same on both sides. It runs from the keel at **z 16.2 (h 0)**
to the crown at **z 20.1 (h 4.14)**, so **z = 16.2 + 0.94·h** (about 47° from horizontal, with the top leaning aft).
Measured points (`9H-WDX_left`): h 3.85 → z 19.7; h 3.27 → 19.1; h 2.68 → 18.6; h 2.10 → 18.0; h 1.52 → 17.5. The
right side (`HA-LZW_right`, `G-WUKU_right`) has the same slope (0.92) and is 0.4 m further aft. (verified by pixel
scan: left h 3.97 → 19.84, 3.27 → 19.11, 2.10 → 18.00, 1.40 → 17.39, i.e. z ≈ 16.06 + 0.95·h; right z ≈ 16.55 +
0.91·h.) The line cuts across
the over-wing exits: the forward exit is split white/magenta, and the aft exit is almost all magenta. Below h ≈ 1.1 it is hidden behind the engine in side views. Seen from
below, it reaches the keel under the rear half of the nacelle (`9H-WNR_below-left`). From above it crosses the crown
as the same straight cut (`G-WUKR_top-3q-front-right`; corrected file name, was `...front-left`). It has no curve, no border and no pinstripe.

**Magenta zone:** everything aft of L1 and forward of L2, all round (sides, crown and belly), is magenta #D40F8C.

**Line L2 (magenta to blue):** a straight line from the keel at **z 29.9 (h 0)** to the crown at **z 36.1
(h 4.14)**, so **z = 29.9 + 1.50·h** (33.7° from horizontal). Measured points (`9H-WDX_left`): h 3.85 → z 35.3;
h 3.27 → 34.4; h 2.68 → 33.6; h 2.10 → 32.7; h 1.0 → about 31.0. The right side (`HA-LZW_right`) has slope 1.55 and
is 0.4 m further aft. (verified by pixel scan: left z ≈ 29.5 + 1.54·h, right z ≈ 30.1 + 1.52·h; the mean line
above sits between them.) Aft of and below this line everything is blue #1E3394: the lower rear fuselage, the tail cone,
the dorsal fillet and the lower part of the fin.

**Fin:** L2 continues **as the same straight line** across the fin (verified: the fin boundary on `9H-WDX_left`
fits z = 29.55 + 1.553·h from h 5.3 to 8.8, the same line as L2 on the fuselage, z = 29.5 + 1.54·h). It crosses the fin leading edge at **h ≈ 5.1
(z ≈ 37.6)**, about 1 m above the crown, and reaches the trailing edge at **h ≈ 8.8 (z ≈ 43.3)**, about 1.4 m below
the tip (verified on `9H-WDX_left`: leading-edge crossing h 5.0–5.2 at z 37.3–37.5, trailing-edge crossing h 8.85 at
z 43.3, tip at h 10.25). The formula gives z 43.1 there, and the measured point is 0.2 m aft of that. The fin is therefore a
**magenta triangle** (the whole tip chord, the leading edge down to h 5.1, and the trailing edge down to h 8.8) over
**blue** (everything below and aft of the line, and the whole root). Both sides are identical (`9H-WDX_left`,
`HA-LZW_right`, `9H-WNF_fin-tip`). There is no logo or art on the fin. The fin tip cap is magenta. Colour does not
change at the fin root: the blue of the fin continues onto the dorsal fillet and the tail cone.

**Tail cone:** blue to the end. The APU exhaust nozzle (z 44.2–44.51) is bare dark metal.

**Titles (fuselage):**

- **Forward logo "WIZZ"** (the 2015 outline logo: a "W", an "i" drawn as a stroke with a circular dot below, and
  "zz"; outline only, transparent inside): box **z 6.65 – 12.2** (5.55 m long), **h 1.4 – 3.65**. The measured
  sides are left 6.55–12.03 × 1.30–3.59 and right 6.77–12.36 × 1.47–3.74. The top of the box is the upper "z"
  flag. The bottom is the round dot under the "i". The window row (h ≈ 2.6) runs **through** the logo, and the
  windows show inside the letters and between them. The logo starts about 1.25 m aft of door 1. Seen side-on, the
  painted logo is about 2.4:1 (width:height). The SVG is 2.17:1, and fuselage curvature shortens the height in
  projection, so stretch the SVG to the box. The outline stroke is about 7 cm wide, with a vertical gradient from
  magenta at the top to navy at the bottom (`HA-LVW_nose`, `9H-WDX_left`). The logo is the **same on both sides and
  never mirrored**. On the left the "W" is nearest the nose. On the right the "W" is at the aft end (z ≈ 12.2).
  (verified: `9H-WDX_left` box 6.57–12.0 × 1.31–3.6; `HA-LZW_right` 6.8–12.3; the right-side "W" is aft on
  `HA-LZW_right`, `G-WUKU_right` and `G-WUKR_top-3q-front-right`.)
- **"wizzair.com"** in white, bold lowercase geometric sans (double-storey "a"), **above the windows** in the
  magenta zone: box **z 27.5 – 32.9** (5.4 m long), baseline **h 3.0**, **x-height 0.52 m** (to h 3.52), i-dots
  up to h ≈ 3.62. It starts about 0.45 m aft of door 3 and ends about 1.5 m forward of L2 at the baseline. Left side:
  reads nose to tail ("w" at z 27.5). Right side: reads tail to nose ("w" at z ≈ 32.9, ".com" nearest door 3).
  Evidence: `9H-WDX_left` 27.3–32.7, `HA-LZW_right` 27.8–33.2, `G-WUKU_right`. (verified: left 27.3–32.7, baseline
  h 3.06, x-height ≈ 0.5 m; right 27.8–33.1; double-storey "a" on `9H-WMD_below-right`.)
- **Belly title:** a large white "wizzair.com" along the keel in the magenta zone, **z ≈ 17.5 – 25.3** (≈ 7.8 m),
  x-height ≈ 0.75 m. (verified within the stated ±1 m: on `9H-WMD_below-right` the upside-down title runs from
  x 1166 ("w") to x 839 ("m"), z ≈ 16.9–25.5, so the "w" starts right at L1 where L1 meets the keel; an x-height
  of 0.75–0.85 m fits a title of that length with the fuselage title's proportions.) It reads nose to tail, with the **tops of the letters toward the left (port) side**, so it is
  readable from below-left (`9H-WNR_below-left`) and upside down from below-right (`9H-WMD_below-right`). A
  side-elevation projection cannot show it. Leave it out unless the model gets a belly decal. The position is
  estimated from oblique photos (±1 m).
- Registration (white on blue, **just aft of door 4** at window-top height, z ≈ 37.0–38.5, h ≈ 3.1–3.5, with the
  small national flag above it) and "AIRBUS A321neo" (small, under the windows below the aft end of the title, z ≈
  31.1–32.6, h ≈ 2.25, on both sides): skip. (corrected: was "registration ... above door 4"; `9H-WDX_left`,
  `HA-LZW_right` and `9H-WMD_below-right` all show it aft of door 4, on both sides.)

**Tailplane:** light grey #B6BBBF on the upper and lower surfaces, with a bare-metal leading edge. The root fairing
on the tail cone is very light grey #D2D4D6 (`9H-WNF_tailcone`). There is no livery colour on the tailplane.

**Wings:** Airbus light grey #B6BBBF on the upper and lower surfaces. The flap-track fairings and the pylons are the
same grey (`9H-WNF_engine`, `9H-WDX_left`).

**Engine nacelles (both engines alike, PW1100G):**

- The fan cowl and thrust reverser (0 to 4.0 m aft of the inlet lip) are magenta #D40F8C all round.
- The inlet lip is bare silver metal #C5C3C0 (the rounded front ring, about 0.15 m). The inside of the inlet is grey.
- **"wizzair.com"** is in white, the same font as the fuselage title, x-height ≈ 0.23 m. It runs from 0.65 m to
  3.0 m aft of the inlet lip (2.35 m long), centred about 0.1 m above the horizontal centreline of the nacelle
  (verified: 0.04 m above on `9H-WDX_left`, 0.08 m on `HA-LZW_right`; treat it as on the centreline). It is
  on **both faces of both nacelles**:
  - left engine outboard (`9H-WDX_left`, `9H-WMB_left`, `9H-WNF_3q-front-left`);
  - right engine outboard (`HA-LZW_right`, `G-WUKU_right`, `G-WUNC_3q-front-right`);
  - right engine inboard (`9H-WNR_below-left`);
  - left engine inboard (`9H-WMD_below-right`).

  The text is always upright, so it reads nose to tail on left-facing sides and tail to nose on right-facing sides.
  (verified: all four faces carry the title. On `9H-WNR_below-left` the upper engine in the frame is the left engine
  (outboard face) and the lower one the right engine (inboard face); on `9H-WMD_below-right` it is the reverse.
  Title 0.61–2.94 m aft of the lip on `9H-WDX_left`, 0.67–3.03 m on `HA-LZW_right`; nacelle 2.54 m tall.)
- Small maintenance stencils sit below the title (skip).
- The core cowl, exhaust nozzle and plug aft of the reverser are dark metal #4A4D52.

**Wingtip devices (Airbus Sharklets):**

- The curved lower transition (the "knee", the bottom ≈ 0.4 m) is wing grey.
- The blade from the top of the knee to the tip is **magenta** on both faces, with a **light grey/white
  leading-edge band** (#D2D4D6, about 15% of the chord) along the whole blade.
- **Outer face:** magenta and the leading-edge band only. It has **no text** (`9H-WNR_below-left` for the left
  Sharklet, `9H-WMD_below-right` for the right) (verified on zoomed crops of both).
- **Inner face:** magenta with a white **"wizzair.com"** along the span, in the **lower half of the blade**: it
  starts at about mid-height and ends just above the grey knee (corrected: was "in the middle and upper part of the
  blade"). On `9H-WNF_winglet-inner` the text runs from 51% to 94% of the way down from the tip, and on
  `G-WUKR_top-3q-front-right` from 46% to 91%; the upper part of the far Sharklet that shows above the fuselage in
  `9H-WDX_left` and `HA-LZW_right` has no text. It reads from the tip down toward the root, with the tops of the
  letters toward the leading edge (verified: the static wicks on `9H-WNF_winglet-inner` mark the trailing edge, and
  the letter tops point away from them). The x-height is about 0.1–0.12 m (estimate; the text is about 1 m long).
  Evidence: `9H-WNF_winglet-inner` (left Sharklet), `G-WUKR_top-3q-front-right` (**left** Sharklet, the far wing;
  corrected: was "`G-WUKR_top-3q-front-left` (right Sharklet)"), `9H-WMD_below-right` (the left Sharklet seen under
  the fuselage; only its lower part shows). No photo shows the **right** Sharklet's inner face; assume it is the
  mirror image of the left one.

**Nose:** the radome is white like the fuselage. There is no nose band. The cockpit windows sit in the standard
near-black surround (`HA-LVW_nose`) (verified; see the colour table).

**Other:**

- Door and exit outlines are thin white lines in the magenta and blue zones, and grey in the white zone (verified).
- The belly fairing takes the fuselage colours: white forward of L1 and magenta aft of it (verified on
  `G-WUKR_top-3q-front-right`, `9H-WNF_engine`, `9H-WMD_below-right`).
- Under the left wing, the registration is painted in large black letters (`9H-WNF_winglet-front`): skip.
  (verified; also "9H-WNR" under the left wing on `9H-WNR_below-left`.)

---

## 5. Side-elevation drawing steps

### LEFT side (nose at the left of the drawing, z increasing to the right)

1. **Fill** the whole elevation white #F4F5F2: the fuselage from z 0 to z 44.51, including the radome, and the fin.
2. **Magenta:** fill every point with **z > 16.2 + 0.94·h** magenta #D40F8C, for all h from the keel to the fin tip.
   The edge is one straight line from (z 16.2, h 0) to (z 20.1, h 4.14), extended below the keel if the model's
   belly falls below h 0 near the wing.
3. **Blue:** fill every point with **z > 29.9 + 1.50·h** blue #1E3394, for all h (verified: this mean line lies
   between the left and right pixel fits): the lower rear fuselage, the tail
   cone and the fin. The edge is one straight line through (z 29.9, h 0), (z 36.1, h 4.14), the fin leading edge at
   (z ≈ 37.6, h ≈ 5.1) and the fin trailing edge at (z ≈ 43.1–43.3, h ≈ 8.8). What stays magenta on the fin is the
   triangle at the tip and the leading edge. If the model's fin is a little taller or shorter, keep the line and let
   it cut the trailing edge about 1.4 m below the tip.
4. **APU nozzle:** paint z 44.2–44.51 dark metal #4A4D52.
5. **Cockpit surround:** paint the near-black #16181C band around the cockpit windows (z 1.4–3.0, h 2.2–2.9), if
   the model's texture does not already have one.
6. **Logo:** place `logos/Wizz_Air_logo_2015.svg` unchanged (gradient outline, empty inside) in the box
   **z 6.65–12.2, h 1.4–3.65**, stretched to fill it. It reads left to right, with the "W" at z 6.65.
7. **Title:** "wizzair.com" in white Montserrat Bold (700), lowercase, from **z 27.5 to z 32.9**, baseline
   **h 3.0**, x-height **0.52 m** (set the font size so that the x-height is 0.52 m; that is about 1.0 m in Montserrat). It reads nose to tail.
8. Skip the registration, the flag, the "AIRBUS A321neo" text and the door outlines, or draw the door outlines as
   0.03 m white lines aft of L1.

### RIGHT side (differences from the left)

- The colour fields are **identical** (the scheme is symmetric): the same L1, the same L2, and the same fin
  triangle. The right-side photos place both lines about 0.4 m further aft, but I treat that as measurement bias.
  Use the same numbers.
- **Logo:** the same box, z 6.65–12.2, h 1.4–3.65, but **not mirrored**. Viewed from the right with the nose on the
  right, it reads "WIZZ" left to right, so the **"W" is at the aft end (z ≈ 12.2)** and the dot and "zz" are
  toward the nose.
- **Title:** the same box, z 27.5–32.9, h 3.0 baseline, **not mirrored**. The "w" is at the aft end (z ≈ 32.9) and
  ".com" ends near door 3.
- **Warning for the renderer:** if one side artwork is simply projected across the span, the right side shows the
  logo and title **mirrored**. That is wrong. The colour fields can be shared, but the right side needs its own
  text/logo layer, or text UVs that are flipped for faces with a negative y normal.

### Flat colours

- Wings: #B6BBBF. Tailplane: #B6BBBF (root fairing #D2D4D6 if the model has one).
- Pylons: #B6BBBF.

### Nacelle artwork (both engines, all faces)

Base magenta #D40F8C. Inlet-lip ring #C5C3C0 (front 0.15 m). White "wizzair.com" (Montserrat Bold, x-height 0.23 m)
from 0.65 m to 3.0 m aft of the lip, centred 0.1 m above the nacelle centreline, on the outboard **and** inboard
faces, always upright. Aft of 4.0 m: exhaust #4A4D52.

### Wingtip artwork (Sharklets)

Knee (the bottom ≈ 0.4 m) is wing grey. The blade is magenta #D40F8C, with a leading-edge band #D2D4D6 (15% of the
chord) on both faces. The inner face adds white "wizzair.com", reading tip to root, tops toward the leading edge,
x-height about 0.1–0.12 m, covering the lower half of the blade from about mid-height down to just above the knee
(corrected: was "covering about the middle 60% of the blade"). The outer face has no text.

---

## 6. Logos and wordmarks

| Graphic | Commons file | Licence | Downloaded | Use |
|---|---|---|---|---|
| **WIZZ outline logo (2015, current)**, forward fuselage | https://commons.wikimedia.org/wiki/File:Wizz_Air_logo_2015.svg | **PD-textlogo** (public domain; the trademark still applies) (verified on the file page: `{{PD-textlogo}}` + `{{SVG-Logo}}`; this page has no `{{Trademarked}}` tag, but the mark is still Wizz Air's) | `logos/Wizz_Air_logo_2015.svg` (130×60 viewBox, one path, linear gradient #CD2B86 → #161998) (verified) | **Usable.** Paint it as it is, in the gradient, not recoloured white. |
| **"wizzair.com" wordmark** (fuselage, belly, nacelle and Sharklet titles) | Part of https://commons.wikimedia.org/wiki/File:Wizz_Air_Logo.png (logo with the "wizzair.com" line; magenta #D40F8C and blue #2E3192) | **Copyrighted free use** (Commons quotes Wizz Air's press office: "free to share … adapt … for any purpose, even commercially") (verified: `{{copyrighted free use}}`, source the wizzair.com press-office logos page, author Wizz Air Hungary Ltd., 2016-01-01) | `logos/Wizz_Air_Logo_pressoffice.png` (2272×1510 raster) | Usable if cropped and recoloured white. However, the press file is a medium weight and the aircraft titles are **bold**. **Recommended:** typeset it in **Montserrat Bold (700)**, lowercase (Google Fonts, OFL). Montserrat has the same geometric o/c/m and a double-storey "a". |
| Former 2003–2015 logo (filled "W!ZZ") | https://commons.wikimedia.org/wiki/File:Wizz_Air_logo.svg | PD-textlogo + Trademarked (verified) | `logos/Wizz_Air_logo_former.svg` | **Do not use** on the A321neo. The app's current `WZZ-title.png` is made from this file, so it shows the old logo (verified: `public/liveries/WZZ-title.png` is the filled purple/magenta "W!ZZ"). Replace it with the 2015 SVG. |
| "ABU DHABI" letters (HA-LDC special) | none | not on Commons | – | Leave out. Paint HA-LDC standard. |
| Team Hungary artwork (HA-LGI, 2024) | none | – | – | No longer worn. Ignore. |

---

## 7. Geometry facts for the model

- **Type:** A321-271NX (A321neo). Airbus data: length 44.51 m, span 35.80 m, height 11.76 m, fuselage 3.95 m wide
  and 4.14 m high. All tracked aircraft are this type.
- **Engines:** Pratt & Whitney **PW1133G-JM** geared turbofan (the whole Wizz A321neo fleet; widely reported, and
  Wikipedia notes the PW1100G groundings). (verified: every Commons title gives A321-271NX, the PW-engined
  A321neo; Airbus's 2019 first-delivery release says Pratt & Whitney GTF; `9H-WNF_engine` shows the plain exhaust.) Nacelle look:
  - a large, round, short nacelle, about 2.5 m in diameter and about 4.0 m long (lip to the end of the reverser),
    measured on `9H-WDX_left`;
  - a **smooth, plain exhaust with no chevrons** (unlike LEAP-1A/1B), and a short dark core nozzle with a plug;
  - a bare-metal inlet lip;
  - a small dark vent flap on the upper forward cowl.

  The nacelle bottom hangs about 1.45 m below the keel line.
- **Wingtip device:** Airbus **Sharklet**, about 2.4 m tall, blended through a curved knee, swept aft and canted
  slightly outboard. The blade tapers to about half its root chord at the tip (estimated from `9H-WMD_below-right`).
- **Doors: 239-seat Cabin Flex layout** (verified: 239 seats per the Airbus/Wizz first-delivery release, HA-LVA,
  March 2019; two over-wing exits and no door 2 on `9H-WDX_left` and `HA-LZW_right`). Per side: door 1 (z 4.3–5.4), **two over-wing emergency exits** (z 17.9–19.4)
  and **no door 2 ahead of the wing**, door 3 aft of the wing (z 26.2–27.1), and door 4 (z 35.9–36.8). The classic
  A321 layout with four full doors per side does not match. This matters only if the model paints door outlines.
- **Fin and tailplane:** the standard A320-family fin. The fin tip is at h ≈ 10.2 above the keel, the tip chord is
  ≈ 1.8 m, and the leading-edge sweep is ≈ 41° from vertical (`9H-WDX_left`) (verified: 10.25 m, 1.8 m, 40.6°).
- **Differences from the app's current `liveries.json` WZZ entry** (verified against `client/scene/liveries.json`:
  `{"base": "#f7f7f7", "fin": "#c6007e", "fin2": "#3a1e6e", "engine": "#c6007e", "title": true}`, with WMT and
  WUK aliased to WZZ):
  - `fin2` #3a1e6e is purple, but the real paint is royal blue #1E3394.
  - The fin is a diagonal magenta/blue split that is continuous with the fuselage line L2, not one flat colour.
  - The rear half of the fuselage is magenta and blue, not the white `base`.
  - The title decal shows the pre-2015 logo.
  - Engine magenta (`engine` #c6007e) is correct.

---

## 8. Confidence and open questions

- **High confidence:**
  - the scheme and its parts: the white nose with the outline logo, L1, the magenta zone, L2 continuing across the
    fin, the blue tail, the titles, the magenta nacelles with titles on all four faces, and the magenta Sharklets;
  - that the scheme is the same on WZZ, WMT and WUK and on all 68 tracked registrations (except HA-LDC) (verified);
  - the official magenta.
- **Positions:** within ±0.4 m in z and ±0.15 m in h. The left and right sides differ by about 0.4 m, which I treat
  as reference bias. The belly title position is only ±1 m, because it comes from oblique photos.
- **Check:** I drew L1, L2 (extended over the fin), the fin points, the logo box, the title box and the doors from
  the numbers above onto `9H-WDX_left` and (mirrored) onto `HA-LZW_right`. On the left photo they sit on the painted
  edges to within about 0.2 m. On the right photo they sit about 0.3 m forward of the edges. The fin-line crossing
  points fall on the real leading and trailing edges in both photos. (corrected: the "within about 0.2 m" holds
  for L1 only. A checker pixel scan of `9H-WDX_left` puts L1 within 0.15 m of the stated line, but L2 lies 0.3 m
  (crown) to 0.4 m (keel) forward of the stated mean line z = 29.9 + 1.50·h; the right photo lies about 0.2 m aft
  of it. The mean line is still the best symmetric choice and is inside the ±0.4 m stated above.)
- **Blue:** the photos give H ≈ 229°, while the official digital blue is 238°. I recommend #1E3394 (photo median).
  #2E3192 is the official alternative. (checker: ground photos give 221–231°, the two in-flight photos 238°; the
  median stays 229°, so the recommendation stands, but the gap to #2E3192 is within the lighting spread.)
- **Wing and tailplane grey:** estimated as the standard Airbus light grey. The samples were dominated by sky
  reflection.
- **Sharklets:** the size and exact position of the "wizzair.com" text on the inner face, and the width of the
  leading-edge band, are estimates (medium-low confidence). I also saw no close-up showing whether the band is paint
  or a bare erosion strip. (checker: the text sits in the lower half of the blade, see section 4; no photo of the
  right Sharklet's inner face was found on Commons (searched the three "Current Airbus A321neo of Wizz Air"
  categories), so it is assumed to mirror the left one.)
- **HA-LDC:** its "ABU DHABI" livery is confirmed only by the current planespotters API photo, which must date from
  after its re-registration from A6-WZA on 2025-10-15 (added). It may be repainted later.
- **HA-LGI:** assumed back in standard colours, based on the current planespotters API photo (undated) (verified:
  re-viewed, standard).
- **Planespotters dates:** the API gives none. Every planespotters thumbnail is "reference only".

Sources consulted: Wikimedia Commons (files above); planespotters.net public API; Wizz Air press-office logo file
(via Commons); [brandcolorcode.com/wizz-air](https://www.brandcolorcode.com/wizz-air) (Pantone 233 C / 3591 C
mapping, unofficial); [Wikipedia: Wizz Air](https://en.wikipedia.org/wiki/Wizz_Air) (PW1100G engines);
[AirlineGeeks, "Livery of the Week: Wizz Air" (2025-10-31)](https://airlinegeeks.com/2025/10/31/livery-of-the-week-wizz-air/)
(checker: its description, "a pink forward section that fades into blue", is loose and not usable for detail);
[Airbus A321neo](https://www.aircraft.airbus.com/en/aircraft/a320-family/a321neo) (dimensions); the Wizz Air
20th-anniversary livery news (9H-WNM) and the avworld.ca model listing (HA-LGI Team Hungary), from web search.
Added by the checker: [Wizz Air press release 2015-05-19, "refreshed brand and livery"](https://www.wizzair.com/en-gb/information-and-services/about-us/news/2015/05/19/wizz-air-celebrates-11th-anniversary-with-refreshed-brand-and-livery);
[Airbus, "Wizz Air takes delivery of its first A321neo" (2019-03)](https://www.airbus.com/en/newsroom/press-releases/2019-03-wizz-air-takes-delivery-of-its-first-a321neo);
[Wizz Air, 20th-anniversary livery release (9H-WNM)](https://www.wizzair.com/en-gb/information-and-services/about-us/news/wizz-air-reveals-special-20th-anniversary-livery-aircraft);
[AirlineGeeks, "Wizz Air's 250th Aircraft" (2025-12-05, 9H-WMR)](https://airlinegeeks.com/2025/12/05/livery-of-the-week-wizz-airs-250th-aircraft/);
planelogger.com histories of [HA-LDC](https://www.planelogger.com/aircraft/Registration/HA-LDC/1216810),
[HA-LDG](https://www.planelogger.com/aircraft/Registration/HA-LDG/1219722) and
[HA-LDI](https://www.planelogger.com/Aircraft/Registration/HA-LDI/1222662); the `client/scene/liveries.json` WZZ entry.
