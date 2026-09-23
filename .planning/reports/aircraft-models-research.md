<!-- .planning/reports/aircraft-models-research.md -->
# Per-type aircraft models: free sources, licences, a minimal set and the ICAO fallback mapping

Research only, no code changed. All checks were made on **2026-09-23**. Repo facts cite files in this tree. Web facts cite the page, repository or API that was read. "Measured" means I downloaded the file to a scratch folder outside the repo and inspected it. "Unverified" means exactly that. Nothing here is legal advice.

## TL;DR

- **The best free source is the FlightGear aircraft, as re-packaged for flight trackers. All are GPL.**
  - **livetaiwan-aircraft-models:** 68 web-ready glTF 2.0 GLBs, one mesh each, untextured, one axis convention, with sources and build scripts. Measured 62–715 KB each; 20 files total 4.3 MB.
  - It is built from **FlightAirMap-3dmodels** (textured glTF 2.0, one file per ICAO designator) and **Flightradar24's fr24-3d-models** (glTF 1.0, with `.blend` sources). Both derive from FlightGear aircraft under GPL-2.0 / 2.0+ (a few GPL-3.0).
  - They cover every requested type except the Q400 (a `.blend` exists), the C172 (use the C182) and a true 777-300ER (the 777-300 stands in).
- **FlightAirMap's own mapping cannot be recovered.**
  - The app matched `designator,file.glb[,minPixelSize]` rows in a `models/gltf2/modelsdb` CSV.
  - Its fallback was engine type + count + wake category (`J2M`, `J2H`, `T2M`, `P1L` …), then Cesium Air.
  - The CSV lived on `data.flightairmap.com`, which answers **502**, with no Wayback copy. The GitHub model files are named by designator, which covers most of it.
- **Sketchfab CC-BY works for single models but is a poor basis for the set:**
  - uneven styles and liveries;
  - bulk uploaders with doubtful provenance;
  - no CC0 airliners found;
  - Sketchfab/Fab **Standard**, TurboSquid, CGTrader and Free3D licences all **forbid shipping the raw file**.
  - Poly Pizza, Kenney and Quaternius have nothing type-specific. NASA/Smithsonian/Commons have only special cases.
- **Most common types.**
  - Active fleet, June 2025 (IATA/Cirium): B738 4,558 · A320 3,611 · A20N 1,776 · B38M 1,573 · A321 1,538 · A21N 1,474 · A319 855 · B77W/B773 784 · E175 759 · B763 666 · B789 660 · B737 654 · A333 630.
  - By flights in 2025 (IATA WATS): 737 10.8 M, A320 8.7 M, A321 4.2 M.
  - GA and helicopters: C172 and P28A lead every registration count; R44 and AS50 lead helicopters.
- **Proposed set: 12 models** from livetaiwan, **about 2.5 MB** in total: `a320`, `b738`, `b77w` (777-300), `b787`, `a330`, `e175`, `crj9`, `atr72`, `b744` (quad), `c550` (bizjet), `c182` (GA single), `ec135` (helicopter). Cesium Air stays the default.
- **Fallback chain** (section E2): explicit designator → Doc 8643 description + WTC (`L2J-H` → widebody twin, `L2J-M` → A320 unless category `A2` → bizjet, `L4J` → quad, `L2T` → ATR, `L1P` → C182, `H…` → helicopter) → ADS-B category → Cesium Air.
- **Mapping table: Mictronics `icao_aircraft_types.json`** (ODC-By, 2,788 designators, 10 KB gzipped; format `{"B738":{"desc":"L2J","wtc":"M"}}`). The official ICAO Doc 8643 JSON (`POST doc8643.icao.int/External/AircraftTypes`, 2,614 designators, adds engine type/count and wake group) may **not** be redistributed under ICAO's terms. readsb JSON has no `L2J` field, so the table must ship with the client.
- **Licence duties for the GPL set:**
  - licence texts;
  - per-file upstream licence and "modified" notice (livetaiwan's blanket "GPL-2.0-or-later" is wrong for the GPL-3.0 ATR 72);
  - the corresponding source (upstream files + scripts) kept in the same repo;
  - FlightGear author credits.
  - FlightHopper's own code does not become GPL ("mere aggregation").

---

## 0. What the app has today, and what a per-type set changes

- **One model.** `public/models/manifest.json` has `default: "cesium-air"` and one entry: `Cesium_Air.glb`, 586,652 bytes, Apache-2.0, with `forwardAxisFix {-90,0,0}`, `gearHeightM 4.03`, `lengthM 37.57`, `scale 1.7555`.
- **The manifest already expects type matching.** `client/types.ts:49` documents `default` as the "id of the model used when no type match". But `ModelManifestEntry` (`client/types.ts:36-45`) has no field listing which types an entry serves, and `client/app.ts:294` only ever loads the default entry.
- **Traffic is sized by ADS-B category, not by type.** `client/scene/traffic.ts:24` scales the one model by `SCALE = { A1: 0.35, A2: 0.6, A3: 1, A4: 1.2, A5: 1.8, A7: 0.4 }`. The bracket box is hard-coded for Cesium Air (`traffic.ts:17-19`, `BOX_CENTRE`, `BOX_HALF`), with a `ponytail:` note saying it becomes per-model fields "if a second GLB comes".
- **Calibration is geometry-driven.** `measureGlb` (`client/scene/model.ts:35-91`) finds nose, span, length and "below origin" from the GLB itself, and `model.test.ts:65-71` checks that `lengthM` and `gearHeightM` in the manifest match the geometry. It accepts only glTF **2.0** GLBs with no `extensionsRequired` (`model.ts:36-41`), so Draco/meshopt and glTF 1.0 files would need a change there or an offline conversion.
- **What the client gets per aircraft.** readsb JSON from adsb.lol / adsb.fi carries `t` (ICAO type designator) and `desc` (long name, e.g. "BOEING 737-900"), but **not** the ICAO description code (`L2J`) or wake category. Checked in `data/fixtures/golden/adsbfi-point-llbg.json` (keys include `t`, `desc`, `category`; no `L2J`-style field). `shared/info.ts:12-13,39-40` keeps only `typeCode` and `category`. So the family fallback needs a **static designator table** shipped with the client (section D).

---

## A. Free model sources

### Summary table

| Source | Licence of the models | Format | Types covered | Size / polycount | Verdict |
|---|---|---|---|---|---|
| **livetaiwan-aircraft-models** (github.com/GoLocalNear/livetaiwan-aircraft-models) | Repo says "Everything in this repository is **GPL-2.0-or-later**". That is right for most files but **over-claims** for the GPL-3.0 upstreams (AT75, 707, PC21) and the GPL-2.0-only ones (see A0). | **glTF 2.0 GLB**, 1 mesh, 1 material, no textures, `COLOR_0` shading, one axis convention; upstream sources + build scripts included | 68 files: 48 from FlightAirMap-3dmodels + 20 from fr24 (incl. b738, b773, b789, b744, ec135); no Q400, no C172 | 62–715 KB, 1.2k–16k triangles; 20 measured files total 4.3 MB | **Best practical source: web-ready now.** New (2026-08-19, 0 stars): check provenance against the upstreams. |
| **FlightAirMap-3dmodels** (github.com/Ysurac/FlightAirMap-3dmodels) | GPL-2.0 or GPL-2.0-or-later per folder (licence file copied from each FlightGear upstream). **ATR 72 (`atr72`), 707 and PC-21 are GPL-3.0.** B407, C421, BCS1 and B777 folders carry no licence file. | **glTF 2.0 GLB** (Blender exporter) + `.blend` sources | 49 glTF 2.0 GLBs in `<type>/glTF2/`, named by ICAO designator (46 distinct aircraft), incl. A318–A321, A332, A333, A343, A350, A380, AT45, AT75, B744, B748, B752, B763, B788, BCS1, BCS3, C182, C208, C550, CRJ2, CRJ7, CRJ9, E145, E170, E75L, E190, EC35, B407, PA28, PC12, SR22 | 0.8–6.2 MB each; measured 15k–43k triangles; textures are 30–75 % of the bytes | **The textured originals** behind 48 livetaiwan files. Real-scale metres, glTF 2.0, one file per designator. No 737, no 777 GLB. |
| **Flightradar24 fr24-3d-models** (github.com/Flightradar24/fr24-3d-models) | GPL-2.0 (repo `LICENSE`), except a CC-BY 4.0 Millennium Falcon and a 3D-Warehouse Santa | **glTF 1.0** GLB (KHR_binary_glTF) + `.blend` sources | 41 files: 737-600/700/800/900, 747-400/-8, 757, 767, 777-200/-300, 787-8/-9, A318–A321, A330, A340, A350, A380, ATR 42, Citation II, PA-28, CRJ700/900, E170/E190, CS100/300, Q400, BAe 146, EC135, AN-225, Beluga | 0.6–7.6 MB; measured 12k–31k triangles | **Fills the gaps** (737, 777, Q400). Must be converted to glTF 2.0 offline for `measureGlb`. |
| **Aeris** low-poly derivatives (github.com/kewonit/aeris, `public/models/aircraft/`) | GPL-2.0 (their `NOTICE.md`: derived from the two repos above) | glTF 2.0, textures stripped, ~30 % triangles | 12 family silhouettes + B737 | 58–463 KB each, 2.6 MB for all | **Prior art and a size target**, not a source to copy blindly: per-file provenance is not stated. |
| **FlightGear** FGMEMBERS mirror / FGAddon / `c172p-team/c172p` | GPL-2.0 or GPL-2.0-or-later (FGAddon policy: "strongly recommended … be GPLv2+ licensed") | AC3D `.ac` + XML animation; convert via Blender AC3D add-on | Hundreds of types; the upstream of both repos above | Full cockpits: heavy (e.g. `c172-common.ac` 3.2 MB plus ~15 MB of textures) | Use only for a type the two repos above lack. |
| **X-Plane / Laminar default aircraft** | EULA: "You agree to not distribute the artwork from X-Plane, or any derivative thereof, without permission" | `.obj` (X-Plane) | — | — | **No.** |
| **Cesium** sample data / Cesium ion | Cesium Air is Apache-2.0 (already used). ion's curated content has no aircraft | — | 1 generic prop airliner, 1 drone | — | Keep Cesium Air as the last-resort default. |
| **tar1090 / adsb.lol / ADS-B Exchange** | tar1090 is "GPL, v2 or later" | 2-D SVG only | 369 designators → icon shapes | — | No 3-D models. Its fallback chain is the right design (section D). |
| **Sketchfab, CC-BY / CC0 downloads** | CC BY 4.0: "Author must be credited. Commercial use is allowed." (api.sketchfab.com/v3/licenses). Credit author **and** Sketchfab. | Auto-converted glTF/GLB | At least one CC-BY model for every requested type, but no CC0 modern airliner found | 2k–137k faces; 0.15–6.8 MB | **Usable per model, uneven.** Mixed styles, liveries, and several bulk uploaders with doubtful provenance (A5). |
| Sketchfab **Standard / Free Standard**, Fab **Standard** | Forbid making the file available so "third parties [can] … download, extract or access" it; Fab forbids redistribution "on a standalone basis" | — | — | — | **No** for a public repo or a fetchable GLB. |
| **TurboSquid**, **CGTrader** royalty-free, **Free3D** | Must be in "proprietary formats so that they cannot be opened" (TurboSquid). "Take all commercially reasonable measures to prevent the end user from gaining access" (CGTrader §21A.3). "May NOT publish or distribute … in any open format" (Free3D). | — | — | — | **No.** |
| **Poly Pizza** (Google Poly archive) | CC-BY 3.0 (per model page); one CC0 helicopter | GLB | Generic planes, one Boeing 747 | 254–11k triangles | Too generic to tell types apart. |
| **Kenney**, **Quaternius** | CC0 / Quaternius licence | — | No 3-D aircraft kit found | — | **No.** |
| **NASA** 3D Resources / Airborne Science | "free and without copyright" (NASA-3D-Resources README); NASA insignia not public domain | GLB | B777 (NASA LaRC), King Air B200, G-III/IV/V, DC-8, P-3, Twin Otter, C-130 | 11.7–48 MB each | Only for a special case; needs heavy decimation and insignia removal. |
| **Smithsonian 3D**, **Wikimedia Commons** | CC0 (Smithsonian Open Access); Commons takes STL only | glTF / STL | Historic aircraft only | Wright Flyer 31.7 MB | **No.** |

### A0. livetaiwan-aircraft-models: the web-ready set

- **Repo.** https://github.com/GoLocalNear/livetaiwan-aircraft-models. GitHub API: licence GPL-2.0, created 2026-08-19, a single commit `00d6a93` "Publish 68 GPL-2.0 aircraft models with sources and conversion scripts", 0 stars, 0 forks. Found by the helper agent; everything below was re-checked by me.
- **What it says it is** (README):
  - 68 models, 48 from FlightAirMap-3dmodels and 20 from fr24-3d-models, "prepared for the 3D air view on livetaiwan.tw, which draws live ADS-B traffic over Taiwan". The same use case as FlightHopper.
  - Pipeline: Blender 5.2. Every model is "Joined" into one mesh and one material, "Decimated to roughly 20% of the original triangle count", and "Dropped all textures".
  - Every model is "Re-oriented … `+X` right wing, `+Y` up, `-Z` nose" and "Recentred". A `COLOR_0` shade attribute is added "so an untextured single-material hull still reads as a solid shape".
  - The result averages "about 190 KB and 4,500 triangles per model, 13 MB for the whole set".
- **Sources and scripts are in the repo.**
  - `source/flightairmap-glb/`: the 49 upstream GLBs, 127 MB.
  - `source/fr24-blend/`: the 20 `.blend` files, 54.7 MB.
  - `scripts/`: `bl_join.py`, `bl_join_blend.py`, `canonicalise.py`, `embed_copyright.py`, `contact_sheet.py` and others.
  - `docs/model-manifest.json`: span, height, length, triangles and KB per model.
  - `docs/ORIENTATION.md`: the upstream files had "all four horizontal orientations", and B407 was Z-up.
- **Measured** (20 files downloaded to scratch; table in section B):
  - All glTF 2.0, 1 mesh, 1 material, 0 images, no `extensionsRequired`, attributes `POSITION`, `NORMAL`, `COLOR_0`.
  - `asset.copyright` = "GPL-2.0-or-later, derived from FlightGear / FGMEMBERS / Flightradar24 fr24-3d-models".
  - This repo's `measureGlb` accepts every file and finds the nose at **−X** in Cesium's frame for all fixed-wing models, i.e. `forwardAxisFix.headingDeg = +90`. EC35 was mis-read as +X; see the helicopter caveat in B.
  - Lengths are metre-scale.
  - The origin is the airframe centre, not the wheels, so `gearHeightM` is the measured "below origin" (e.g. 6.37 m for b738).
- **Licence caveat.** The blanket "GPL-2.0-or-later" is not quite right:
  - `AT75`, `707` and `PC21` derive from GPL-3.0 upstreams (A1 table). A GPL-3.0 work cannot be relabelled "2.0-or-later".
  - The fr24-derived files come from a repository that says "GPLv2" with no "or later". GPL-2.0 §9 lets a recipient pick a later version only when the Program says "any later version".
  - The files themselves are still redistributable. FlightHopper should just **record each file's upstream licence** rather than copy the blanket label.
- **Gaps:**
  - No Q400: use fr24 `source/q400/q400.blend`.
  - No C172: use `C182`, or convert c172p.
  - No B77W-specific mesh: `b773` is a 777-300. Its span is 60.72 m against the helper agent's ~64.8 m for a -300ER, which also has raked tips. `FGMEMBERS/777` has `Models/777-300ER.ac` (1,619,560 bytes; checked).
  - fr24's `b789` is 65.8 m long, 5 % over a 787-9. The error is in the upstream mesh (fr24 measured the same), so it needs a look before use.

### A1. FlightAirMap: the models, the mapping and the licence

**Where the models are.** The main FlightAirMap repository (github.com/Ysurac/FlightAirMap, code AGPL-3.0 per the GitHub API) ships only `models/Cesium_Air.glb`, `santa.glb`, `space/sat.glb` and empty `models/gltf2/` folders (git tree of `master`, read via the GitHub API). Its installer downloads the aircraft set at run time:
- `install/class.update_db.php:2883-2908` fetches `http://data.flightairmap.com/data/models/gltf2/models.md5sum` and then each listed file into `models/gltf2/`.
- **That server is down.** `data.flightairmap.com` and `www.flightairmap.com` returned **HTTP 502** on 2026-09-23 (curl). The Wayback Machine CDX index has only 502 captures under `data.flightairmap.com/data/models/` (checked `web.archive.org/cdx/search/cdx?url=data.flightairmap.com/data/models/*`). So the exact downloaded list and the alias file cannot be recovered.
- **The same models are on GitHub** as **github.com/Ysurac/FlightAirMap-3dmodels** ("3D models used by FlightAirMap with Cesium", last commit `0906d9b`, 2018-07-26, "Rotated models fix #1"). Its README says the models "come from https://github.com/kalmykov/fr24-3d-models and https://github.com/FGMEMBERS/" (kalmykov/fr24-3d-models now redirects to Flightradar24/fr24-3d-models). Found through Aeris's `NOTICE.md`.

**The type → model mapping.** `live-czml.php:298-330` reads two CSV files, `models/modelsdb` and `models/gltf2/modelsdb`, with rows `designator,file.glb[,minimumPixelSize]`. The lookup order (`live-czml.php:496-660`) is:
1. the aircraft's ICAO designator in `gltf2/modelsdb`, then in the old `modelsdb`;
2. the designator's `aircraft_shadow` (FlightAirMap's own icon family) in either file;
3. a synthetic key from Doc 8643 engine type, engine count and wake category: `J1M`, `J2L`, `J2M`, `J2H`, `J3M`, `J3H`, `J4M`, `J4H` (jets), `T1L`, `T2L`, `T2M`, `T4H` (turboprops), `P1L`, `P1M`, `P2L`, `P2M` (pistons);
4. `Cesium_Air.glb`.

The `modelsdb` file itself was only on the dead server, so the alias rows are **unverified**. A GitHub code search and the 10 forks listed by the API (all last pushed 2018-07-26) turned up no copy. In FlightAirMap-3dmodels the `glTF2/` file names are themselves designators (`A320.glb`, `E75L.glb`, `AT75.glb`, `CRJ9.glb` …), which is most of the mapping.

**The licence.**
- FlightAirMap's `CREDITS` says for `models/*`: "License : in sources.txt". `models/sources.txt` says the aircraft models "are licensed under GPLv2" (and, wrongly, calls Cesium Air GPLv3; it is Apache-2.0 in the CesiumJS repo).
- FlightAirMap-3dmodels has **no top-level licence**. Each model folder is a git submodule of its FlightGear upstream plus a copy of that upstream's licence file. Read on 2026-09-23:

| Folder | Licence file | Text |
|---|---|---|
| `a320`, `a332`, `a333`, `a343`, `a350`, `a380`, `ask21`, `b744`, `b767`, `b788`, `c208`, `c550`, `crj2`, `dhc4`, `dr40`, `e145`, `gazl`, `p40`, `pa18`, `pa22`, `pa28`, `pa32`, `paraglider`, `pc12`, `sr22`, `t134` | `COPYING` / `COPYING.txt` (~18 KB) | GPL-2.0 text |
| `atr42`, `e190` | `License.txt` | GPL-2.0 text |
| `b748`, `c182`, `ec35` | `LICENSE` | GPL-2.0 text |
| `atr72`, `b707` | `LICENCE.txt` | Portuguese/English bilingual; the English part is **GPL-3.0** ("Version 3, 29 June 2007"). The upstream `FGMEMBERS/ATR72` README agrees: "This aircraft is released under the GNU GPL v3 License". |
| `b752`, `md11` | `LICENSE` | "either version 2 of the License, or any later version" |
| `crj9` | `LICENSE` | "licensed under the GNU General Public License, version 2 or above" |
| `pc21` | `License.txt` | **GPL-3.0** |
| `b407`, `c421`, `bcs1`, `b777` | none | **Unverified.** `FGMEMBERS/bell407` and `FGMEMBERS/CSeries` exist and are GPL-2.0 per the GitHub API, but the link to these folders is not stated. |

### A2. Flightradar24 fr24-3d-models

- README: "This repo contains all models which are used for Flightradar24 3D view. All files are stored in glTF format." Licence section: "All other models are licensed under GPLv2". `LICENSE` is the GPL-2.0 text. Last commit `dd53267` (2020-01-16). 249 stars, not archived. https://github.com/Flightradar24/fr24-3d-models
- The credits table names the FGMEMBERS upstream per model (e.g. 737-800 → `FGMEMBERS/737-800`, Q400 → `FGMEMBERS/Q400`, EC135 → `FGMEMBERS/ec135`). The GitHub API reports GPL-2.0 for most of those upstreams. `FGMEMBERS/737NG` and `FGMEMBERS/777` have no licence file; their `-set.xml` and `AUTHORS` files name authors but no licence. They were FlightGear hangar aircraft, where GPL-2.0 was the policy until August 2015 and GPL-2.0-or-later after (https://wiki.flightgear.org/FGAddon). So their licence rests on FR24's statement and FlightGear policy: **partly unverified**.
- **Format: glTF 1.0.** Measured on 9 files: `asset.version` 1.0, `KHR_binary_glTF` or embedded buffers, custom GLSL techniques.
  - CesiumJS 1.145 still loads them: `Scene/GltfPipeline/updateVersion.js` upgrades 1.0 → 2.0 and turns technique `diffuse` values into PBR base colours (`:991-1061`). Running that function from this repo's `node_modules` on the 9 files gave a base colour on every material.
  - But `measureGlb` rejects version 1 (`model.ts:36`). Convert offline with CesiumGS `gltf-pipeline` (Apache-2.0; README: "Converting glTF 1.0 models to glTF 2.0"), which is also what Aeris did for its B737.
- **The `.blend` sources are in the repo** (`source/<type>/*.blend` plus a zip). That is the GPL "preferred form … for making modifications".

### A3. Aeris (prior art for the same problem)

- github.com/kewonit/aeris, "a real-time 3D flight radar for the web", AGPL-3.0, 345 stars, last push 2026-08-30.
- `docs/3D-MODELS.md`:
  - 13 GLBs, 2.61 MB in total. Two dedicated types (A380, B737 family); all others map to 12 family silhouettes: narrowbody, widebody-2eng, widebody-4eng, regional-jet, turboprop, bizjet, light-prop, helicopter, glider, fighter, drone, generic.
  - Pipeline: `@gltf-transform/cli`, "Texture stripping", "Mesh simplification - Triangle count reduced to ~30% of original", no Draco (to avoid the WASM decoder).
  - Their fallback is by ADS-B category number only. `aircraft-model-mapping.ts` routes `A38x` and `B73x`/`B37M`–`B39M` to dedicated models.
- `public/models/aircraft/NOTICE.md`: models from FlightAirMap-3dmodels and fr24-3d-models, "License: GNU General Public License v2 (GPL-2.0)", "All textures stripped (materials set to neutral unlit white)".
- **Useful as a size target.** Sizes measured from the git tree: narrowbody 402 KB, widebody-2eng 149 KB, widebody-4eng 242 KB, regional-jet 127 KB, turboprop 86 KB, helicopter 271 KB, light-prop 131 KB, bizjet 453 KB.
- **Caveats:**
  - `NOTICE.md` does not say which upstream file each silhouette came from, so re-using the Aeris files would need that provenance first.
  - Aeris claims GPL-2.0 is "compatible with this project's AGPL v3 license". That holds only for the "or later" upstreams: GPL-2.0-only is not compatible with (A)GPL-3.0.
  - This matters to FlightHopper only if it copies Aeris code, which it should not.

### A4. FlightGear upstream (FGMEMBERS, FGAddon, c172p)

- **Licence policy.** Quoted from https://wiki.flightgear.org/FGAddon: it is "strongly recommended that all original content … be GPLv2+ licensed". As of August 2015 the policy changed "from being GPLv2-only to now being GPLv2+".
- **FGMEMBERS licences** (GitHub API, `license.spdx_id`):
  - GPL-2.0: A320-family, 737-800, 787-8, 787-9, A350XWB, E-jet-family, Q400, ATR-42-500, Piper-PA-28, ec135, Citation, 747-400, A330-300, CSeries, A380-omega.
  - CRJ700-family: "NOASSERTION", but its `LICENSE` says "GNU General Public License, version 2 or above".
  - 737NG, 777: no licence file.
- **Format.** AC3D `.ac` with XML animations. Blender import/export: https://github.com/NikolaiVChr/Blender-AC3D (the add-on also ships inside `c172p-team/c172p` as `io_scene_ac3d.zip`). The FlightGear models carry full cockpits, so a conversion has to delete the interior before decimating.
- **Cessna 172.** Neither repo above has a C172. The upstream is `c172p-team/c172p`: GPL-2.0, active (last push 2026-09-02), `Models/c172-common.ac` 3.2 MB plus large textures (`interior.png` 4.0 MB, `panel.png` 3.0 MB).
  - Either convert it with the interior stripped, or use FlightAirMap's `C182.glb`. The C182 is also a high-wing single-engine Cessna, 8.50 m long as measured (C172 about 8.3 m). Visually close enough at chase range; that is a judgement, not measured.

### A5. Other sources

A helper agent surveyed these. Sketchfab, fab.com, free3d.com and 3d.si.edu block scripted fetches, so their legal pages were read from **Wayback Machine** copies (dates given).
- Sketchfab model metadata comes from the public API: `https://api.sketchfab.com/v3/models/<uid>` and `…/v3/search`.
- I re-queried 4 of the models below and `…/v3/licenses`. Name, author, licence slug, face count and `isDownloadable: true` matched.

**Sketchfab, CC-BY picks per type** (all `by` = CC BY 4.0, downloadable; faces from the API; GLB = Sketchfab's auto-converted archive size; "t" = textures). Links are `https://sketchfab.com/models/<uid>`.

| ICAO | Model (uid) | Author | Faces | GLB | Notes |
|---|---|---|---|---|---|
| A320 | Airbus A320 Airliner (`757aa190f27a407291187328d7125903`) | Kyaie | 13,220 | 1.01 MB, 0t | self-made; "not 100% accurate" |
| A320 | Low Poly Airliner (`f06d488f08764e3ca26f2917d4053c69`) | maurogsw | 3,484 | 0.26 MB | "based on airbus A320" |
| B38M | 737 Max-8 (Free) (`197ae72ceb5441efa91b8bdc2ee37050`) | AMGP3D | 42,264 | 2.03 MB, 0t | |
| B77W | Boeing 777-300ER (`553484dd38e54f5ea9fd048d043bdccb`) | nico_notfrench | 82,104 | 2.64 MB, 0t | heavy |
| A359 | Airbus A350 (`cfa2836ead8c4278a199a7d34a87f02e`) | jhag | 5,257 | 5.77 MB | derived from a CC-BY "A350 QTR"; credit both |
| B789 | Low Poly Boeing 787 Dreamliner (`50baa323fabd49a6b861096cb88e5c25`) | maurogsw | 9,444 | 0.70 MB, 0t | variant not stated |
| E175 | Skywest E175 (`3d71ab9f0074432291e41227ebd0b37c`) | car66254 | 136,463 | 5.59 MB | heavy; **no good CC-BY E190 found** |
| AT76 | ATR 72 - 600 (`1e1a7186f7444d288675262fcee44744`) | sofyankurniawan | 9,066 | 0.62 MB, 3t | airline livery |
| DH8D | bombardier-q400 (`682313382054424c9ac77cf1d447c650`) | madexc | 5,208 | 0.93 MB | |
| CRJ9 | Airplane CRJ-900 Cityjet (`02c4fa44604243c2bb48db64506a39af`) | artoud | 8,254 | 4.32 MB | one 4096 texture |
| C172 | Cessna 172 (WIP) (`731b2971c64d42fd9205bb8324f37dc3`) | Meee | 14,244 | 0.44 MB, 0t | self-made |
| Heli | Bell 206 JetRanger (`d2f7ba1d671549d4b26aaf834139a1dd`) | terran4627 | 6,014 | 1.07 MB | |
| Heli | AS350 B2 (`76cf31c232bf4514ab1794d28a2b0ee1`) | Archeopteryxfr | 5,740 | 1.82 MB | |
| B744 | Boeing 747-400f (`1982339cb5d147cf969b7cd0b01a2e69`) | Aviation_Liker | 5,986 | 0.39 MB, 0t | freighter |
| A388 | Airbus A380 (`98d21f9c8104445f814cef47ef992889`) | davidbroutian | 67,580 | 4.41 MB | |
| Bizjet | Low-Poly Gulfstream Aircraft (`af86c5f4a3054cd8a30d1ad213f99e57`) | maurogsw | 2,300 | 0.18 MB | |
| PC12 | Pilatus PC 12/47 (`d8ab7be8b9794910930e7919d0bf3f5a`) | helijah | 36,034 | 2.94 MB | |

**Provenance flags** (the helper agent's reading of uploaders' catalogues; **unverified**):
- Bulk uploaders `jratanatharathorn` (~40 aircraft in Oct–Nov 2020), `manilov.ap` (60+ in Jan 2017, machine-translated Wikipedia text), `Tyler_Dave` and `nobilishornet2` show signs of re-uploading others' work.
- CC-BY from a re-uploader is worthless, which is the main risk of a Sketchfab-built set.
- No CC0 modern airliner was found: a `license=cc0` search returned only WWI types and museum scans.

**Precedent for CC-BY in an open repo.** `bilawalsidhu/gods-eye-view` (41.5k stars) ships Sketchfab CC-BY GLBs (Bell 206, ATR 72, 787-9, C172, Citation, 747) in `public/models/`. Its README table gives creator, source, licence and "Project modifications", and states the files "are not covered by the repository's MIT source-code license" (https://github.com/bilawalsidhu/gods-eye-view/blob/main/public/models/README.md, read by me).

**Sketchfab and Fab licence terms:**

| Point | Quote (<15 words) | Source |
|---|---|---|
| CC-BY summary | "Author must be credited. Commercial use is allowed." | https://api.sketchfab.com/v3/licenses (read by me) |
| Credit Sketchfab too | "must credit the author and the source (Sketchfab)" | https://sketchfab.com/developers/download-api/guidelines (Wayback 2026-06-29) |
| Suggested credit line | "This work is based on [Model] by [Author] licensed under CC BY 4.0." | help.sketchfab.com "Crediting users for 3D model downloads" (Wayback 2022-01-18) |
| CC BY 4.0 on edits | "indicate if You modified the Licensed Material" | https://creativecommons.org/licenses/by/4.0/legalcode.en |
| BY-SA | "Modified versions must have the same license." | licences API |
| ND | Format-only changes are allowed ("never produces Adapted Material"). Decimating or re-orienting is probably an adaptation, so ND models are out. | https://creativecommons.org/licenses/by-nd/4.0/legalcode.en |
| Sketchfab Standard / Free Standard | Forbids offering the file so "third parties [can] use, download, extract or access" it | https://sketchfab.com/licenses (Wayback 2026-09-03) |
| Sketchfab store → Fab | "The Sketchfab Store is now closed." (22 Oct 2024). Free CC downloads still worked through the API on 2026-09-23. | Sketchfab blog (Wayback 2024-11-22) |
| Fab Standard | May not "Resell or redistribute the asset for free on a standalone basis" | https://www.fab.com/eula (Wayback 2026-08-24) |

**Marketplaces** (all **no** for a raw GLB in a public repo or web app):
- **TurboSquid**, effective 3 Feb 2020: models "must be contained in proprietary formats so that they cannot be opened"; only engine WebGL builds are allowed. https://blog.turbosquid.com/royalty-free-license/
- **CGTrader** royalty-free:
  - §21A.3: "take all commercially reasonable measures to prevent the end user from gaining access".
  - §21A.6: redistribution "expressly prohibited" unless incorporated.
  - §20.2: this is the default licence when a seller sets none.
  - https://www.cgtrader.com/pages/terms-and-conditions
- **Free3D**: "You may NOT publish or distribute Stock Media Products in any open format", naming WebGL. https://free3d.com/help/en/articles/9937609-royalty-free-license (Wayback 2026-08-17)

**Generic low-poly libraries:**
- **Poly Pizza**: CC-BY 3.0 generic planes and helicopters, e.g. https://poly.pizza/m/bgUY8zN2Bq9 (618 tris); one CC0 helicopter https://poly.pizza/m/EQJ2MECUbx. The only type-specific item is a Boeing 747 (https://poly.pizza/m/49CLof4tP2V).
- **Kenney**: no 3-D aircraft kit; Tappy Plane is 2-D.
- **Quaternius**: no aircraft pack. Its new licence (https://quaternius.com/license.html, updated 8/28/2026) adds "You just can't resell or redistribute the assets themselves as assets", which is ambiguous for a public repo.

**Public-domain and institutional:**
- **NASA-3D-Resources**: "These assets are free and without copyright" (https://github.com/nasa/NASA-3D-Resources). Aircraft there are only the Global Hawk, X-57 and Ingenuity.
- **NASA Airborne Science** (https://airbornescience.nasa.gov/3d-models/): B777, B200, G-III/IV/V, DC-8, P-3, Twin Otter, C-130 as 11.7–48 MB GLBs.
  - NASA's guidelines say the insignia and logotype "are not in the public domain" (https://www.nasa.gov/nasa-brand-center/images-and-media/).
- **Smithsonian**: historic aircraft only; the Wright Flyer on Sketchfab is CC0, 296,689 faces, 31.7 MB.
- **Wikimedia Commons**: 3-D uploads are STL only (https://commons.wikimedia.org/wiki/Commons:3D_models). Only Wright Flyer STLs were found.

---

## B. Measured facts on the candidate GLBs

Downloaded to a scratch folder (not the repo) and measured with this repo's own `measureGlb` (`client/scene/model.ts`), run under Node from the repo root. The fr24 glTF 1.0 files were first upgraded with Cesium's `updateVersion` and written back as 2.0 GLBs, in scratch only. Nose is the unit vector in Cesium's model frame (`+X` = what `forwardAxisFix.headingDeg = -90` expects today). "Tex" is the bytes of embedded images.

| File (source) | Bytes | Triangles | Tex share | Length m (real) | Span m | Nose | Note |
|---|---|---|---|---|---|---|---|
| `A320.glb` (FAM glTF2) | 3.80 MB | 22.7k | 45 % | 38.27 (37.57) | 33.91 | **+Y** | Only FAM file with a sideways nose. Its `A321.glb` is +X. |
| `A321.glb` (FAM) | 2.70 MB | 25.2k | 16 % | 44.52 (44.51) | 33.91 | +X | |
| `A333.glb` (FAM) | 3.07 MB | 18.0k | 70 % | 63.05 (63.66) | 59.91 | +X | |
| `A350.glb` (FAM) | 3.84 MB | 42.6k | 35 % | 67.02 (66.8, A350-900) | 64.75 | +X | |
| `B747.glb` (FAM, 747-400) | 3.53 MB | 15.8k | 69 % | 70.94 (70.66) | 65.42 | +X | |
| `B788.glb` (FAM) | 2.70 MB | 14.9k | 61 % | 56.69 (56.72) | 59.60 | +X | lowest vertex is 0.12 m above the origin |
| `BCS3.glb` (FAM, A220-300) | 2.22 MB | 32.0k | 51 % | 38.17 (38.7) | 35.17 | +X | |
| `E75L.glb` (FAM) | 3.12 MB | 20.0k | 80 % | 30.82 (31.68) | 25.56 | +X | |
| `E190.glb` (FAM) | 3.41 MB | 20.4k | 74 % | 35.83 (36.24) | 28.20 | +X | |
| `CRJ9.glb` (FAM) | 1.97 MB | 15.6k | 49 % | 36.36 (36.2) | 23.91 | +X | |
| `AT75.glb` (FAM, ATR 72-500) | 2.11 MB | 25.5k | 54 % | 27.39 (27.17) | 26.97 | +X | |
| `C550.glb` (FAM, Citation II) | 2.57 MB | 27.1k | 44 % | 14.48 (14.39) | 15.62 | +X | |
| `PC12.glb` (FAM) | 1.67 MB | 15.5k | 65 % | 14.39 (14.4) | 16.21 | +X | |
| `C182.glb` (FAM) | 5.42 MB | 29.4k | 75 % | 8.50 (8.84) | 10.93 | +X | |
| `SR22.glb` (FAM) | 1.58 MB | 23.0k | 43 % | 7.91 (7.92) | 11.58 | +X | |
| `PA28.glb` (FAM) | 1.69 MB | 19.6k | 53 % | 7.15 (7.3) | 10.55 | +X | |
| `EC35.glb` (FAM, EC135) | 2.59 MB | 31.0k | 29 % | 11.83 | 10.10 | −X? | **Heuristic unreliable for helicopters**: the "top quarter" is the rotor disc, not a tail fin. Check by eye. |
| `B407.glb` (FAM) | 2.98 MB | 24.9k | 56 % | 13.05 | 10.51 | −X? | same caveat; licence unverified |
| `b738.glb` (fr24, glTF 1.0) | 2.94 MB | 25.0k | 8 % | 39.42 (39.5) | 35.69 | −X | |
| `b773.glb` (fr24, 777-300) | 1.31 MB | 19.0k | 44 % | 74.38 (73.9) | 60.72 | −X | Stand-in for B77W: same fuselage; the -300ER has a longer span (64.8 m) and raked tips. |
| `b789.glb` (fr24) | 1.31 MB | 14.1k | 49 % | 65.90 (62.8) | 59.60 | −X | 5 % too long: **check** |
| `q400.glb` (fr24) | 2.32 MB | 12.3k | 82 % | 32.59 (32.8) | 28.45 | −X | |
| `atr42.glb` (fr24) | 3.15 MB | 23.9k | 11 % | 22.77 (22.67) | 27.69 | −X | |

Real-world lengths in brackets are from memory of manufacturer data and are **unverified** here; they only show the files are metre-scale (scale ≈ 1, unlike Cesium Air's 1.7555).

**The same aircraft after livetaiwan's processing** (measured with the same tool). All are 1 mesh, 0 textures and nose −X, so `forwardAxisFix.headingDeg = +90`. "Below" is the origin-to-lowest-vertex distance, i.e. `gearHeightM`, because the origin is now the airframe centre. Triangles are from their `docs/model-manifest.json`.

| livetaiwan file | Bytes | Triangles | Length m | Span m | Below m |
|---|---|---|---|---|---|
| `flightairmap/A320.glb` | 285 KB | 4,544 | 38.23 | 33.86 | 6.26 |
| `flightairmap/A321.glb` | 315 KB | 5,042 | 44.49 | 33.86 | 6.18 |
| `fr24/b738.glb` | 152 KB | 4,983 | 39.48 | 35.69 | 6.37 |
| `fr24/b773.glb` | 186 KB | 4,683 | 74.41 | 60.72 | 9.21 |
| `flightairmap/B788.glb` | 165 KB | 2,975 | 56.71 | 59.52 | 7.96 |
| `fr24/b789.glb` | 111 KB | 2,824 | 65.79 | 59.52 | 7.96 |
| `flightairmap/A333.glb` | 153 KB | 3,596 | 63.06 | 59.91 | 8.41 |
| `flightairmap/A350.glb` | 435 KB | 8,510 | 67.05 | 64.77 | 8.85 |
| `flightairmap/E75L.glb` | 148 KB | 3,991 | 30.82 | 25.56 | 4.98 |
| `flightairmap/E190.glb` | 158 KB | 4,083 | 35.85 | 28.20 | 5.34 |
| `flightairmap/CRJ9.glb` | 155 KB | 3,108 | 36.39 | 23.90 | 3.05 |
| `flightairmap/AT75.glb` | 200 KB | 5,101 | 27.15 | 26.98 | 3.45 |
| `flightairmap/B747.glb` | 177 KB | 3,153 | 70.97 | 65.42 | 9.74 |
| `flightairmap/A380.glb` | 386 KB | 7,288 | 72.71 | 80.44 | 11.79 |
| `flightairmap/BCS3.glb` | 216 KB | 6,396 | 38.20 | 35.19 | 5.98 |
| `flightairmap/C550.glb` | 369 KB | 5,412 | 14.33 | 15.62 | 2.04 |
| `flightairmap/PC12.glb` | 112 KB | 3,094 | 14.40 | 16.21 | 1.90 |
| `flightairmap/C182.glb` | 240 KB | 5,871 | 8.50 | 10.91 | 1.62 |
| `flightairmap/PA28.glb` | 136 KB | 3,910 | 7.16 | 10.55 | 1.36 |
| `flightairmap/EC35.glb` | 324 KB | 6,204 | 11.82 | 10.10 | 2.20 |

These 20 files total **4.3 MB**. Per file that is 7–23× smaller than the textured originals (e.g. A320 3.80 MB → 285 KB, C182 5.42 MB → 240 KB), and the lengths are unchanged.

**Takeaways.**
- **Scale.** Every file is metre-scale, so `scale` ≈ 1. The per-category `SCALE` table in `traffic.ts` is only needed for fallback rows.
- **Size.** Stripping textures and decimating, as livetaiwan did, gives 0.1–0.45 MB per model, measured. The textured originals are 1.3–5.4 MB.
- **Nose direction differs by source.** FAM glTF2: +X. fr24: −X. FAM `A320.glb`: +Y. livetaiwan: all −X. `forwardAxisFix` handles this per entry.
- **`measureGlb` fails on helicopters.** Its fin heuristic mis-reads them: the EC135's nose came out +X from livetaiwan, whose own orientation doc says −Z (glTF), i.e. −X. So a helicopter entry needs its `forwardAxisFix` set by eye, plus an exception in the manifest test.

---

## C. Most common types worldwide

The global picture only; the type mix in the user's own recordings is being counted separately. Numbers were gathered by a helper agent. I re-checked the IATA chart values and the IATA flight counts myself.

### C1. Sources

- **[IATA-F]** IATA, "The global commercial aircraft fleet", August 2025, charts 2–6, "Source: IATA Sustainability and Economics, Cirium Fleets Analyzer", "Data as of June 2025". https://www.iata.org/en/iata-repository/publications/economic-reports/the-global-commercial-aircraft-fleet/
  - "35,550 aircraft, including 30,300 active units and 5,250 held in storage".
  - Active by class: narrowbody 18,495, widebody 5,869, regional jet 3,071, turboprop 2,841.
  - **Checked:** the per-type values in each pie sum exactly to its class total, and the legend order matches descending values. I did not see the rendered chart.
- **[IATA-W]** IATA WATS 2025 press release, 16 July 2026. https://www.iata.org/en/pressroom/2026-releases/07-16-iata-releases-2025-world-air-transport-statistics-report/
  - Boeing 737 "10.8 million flights in 2025, up 12.0% from 2024"; A320 8.7 million; A321 4.2 million.
  - Growth 2019→2025: A220 +770 % (530k flights), A350 +117 % (434k), 787 +41 % (795k), A380 −24 % (90k).
- **[AIB]** Airbus Orders & Deliveries, August 2026 workbook, sheet "Worldwide", row "In Fleet (including leased and secondhand aircraft)", as of 31 Aug 2026. https://www.airbus.com/en/products-services/commercial-aircraft/orders-and-deliveries → `mediaassets.airbus.com/…/orders-and-deliveries-august-2026.xlsx`.
  - I re-opened the workbook. A318 24, A319ceo 1,104, A319neo 44, A320ceo 3,905, A320neo 2,451, A321ceo 1,655, A321neo 2,224: 11,407 for the A320 family.
  - A220-100 75, A220-300 463.
  - A330-200 477, A330-200F 38, A330-300 700, A330-800 8, A330-900 189.
  - A350-900 613, A350-1000 120, A380 193. All types: 14,631.
- **[BOE]** Boeing Orders & Deliveries, Tableau "Minor Models", through 31 Aug 2026. These are **deliveries, not in service**. https://www.boeing.com/commercial#orders-deliveries (helper agent).

### C2. Ranking by active fleet (airliners)

| # | ICAO | Type | Active, Jun 2025 [IATA-F] | Other figure |
|---|---|---|---|---|
| 1 | B738 | 737-800 | 4,558 | 5,012 delivered [BOE] |
| 2 | A320 | A320ceo | 3,611 | 3,905 in fleet [AIB] |
| 3 | A20N | A320neo | 1,776 | 2,451 in fleet [AIB] |
| 4 | B38M | 737 MAX 8 | 1,573 | ~2,090 delivered [BOE] |
| 5 | A321 | A321ceo | 1,538 | 1,655 [AIB] |
| 6 | A21N | A321neo | 1,474 | 2,224 [AIB]; by Aug 2026 above the A321ceo |
| 7 | A319 | A319ceo | 855 | 1,104 [AIB] |
| 8 | B77W (+B773) | 777-300/-300ER | 784 | 833 -300ER delivered [BOE] |
| 9 | E75L/E75S | E175 | 759 | |
| 10 | B763 | 767-300 | 666 | many freighters |
| 11 | B789 | 787-9 | 660 | 761 delivered [BOE] |
| 12 | B737 | 737-700 | 654 | |
| 13 | A333 | A330-300 | 630 | 700 [AIB] |
| 14 | B772 | 777-200 | 592 | |
| 15 | A359 | A350-900 | 552 | 613 [AIB] |
| 16 | AT76 | ATR 72-600 | 488 | |
| 17 | E190 | E190 | 390 | |
| 18 | DH8D | Dash 8-400 | 377 | |
| 19 | B788 | 787-8 | 369 | 399 delivered [BOE] |
| 20 | A332 | A330-200 | 353 | 477 [AIB] |
| 21 | CRJ9 | CRJ900 | 353 | |
| 22 | E145 | ERJ-145 | 286 | |
| 23 | CRJ7 | CRJ700 | 248 | |
| 24 | AT75 | ATR 72-500 | 191 | |
| 25 | CRJ2 | CRJ200 | 172 | |

**Not broken out by IATA; figures from [AIB] or [BOE]:**
- A220-300 (BCS3): 463 in fleet; A220-100 (BCS1): 75.
- A380 (A388): 193.
- A330-900 (A339): 189.
- A350-1000 (A35K): 120.
- 737 MAX 9 (B39M): 348 delivered.
- 787-10 (B78X): 143 delivered.
- 747-8 (B748): 155 delivered, 107 of them freighters (helper agent, from Wikipedia: secondary).

**By family.** A320 family (~11,400 in fleet [AIB]) and 737 NG/MAX dominate. Then come 777, 787, A330, E-Jets, A350, 767, CRJ, ATR 72, Q400 and A220. IATA: the A320 and 737 families are "over 90%" of the narrowbody segment [IATA-F].

**By flights.**
- Worldwide, 2025 [IATA-W]: 737 ≈ 29,600 per day, A320 ≈ 23,800, A321 ≈ 11,500.
- US scheduled flights, April 2025 (Cirium via Simple Flying, secondary: https://simpleflying.com/13-aircraft-types-operate-most-flights-us/): 737-700 69k, 737 MAX 8 59k, E175 56k, 737-800 54k, A321 44k, E175 (enhanced winglets) 41k, A320 41k, CRJ900 38k, A319 35k.
- So regional jets matter far more on a US map than the global fleet suggests.

### C3. General aviation and helicopters

There is no reliable in-service census. Counts of registered aircraft by type come from two open registration databases, downloaded and counted by the helper agent and then deleted:
- OpenSky `aircraft-database-complete` 2025-08: 616,675 rows. OpenSky calls it "unlicensed", "as is" and "not up to date" (https://opensky-network.org/data/aircraft).
- ADS-B Exchange `basic-ac-db.json.gz` of 2026-09-23: 618,751 rows. No licence is stated; its terms page redirects to JETNET's terms, which forbid redistribution. **Do not ship it.**

Both are mostly US-registry data and include deregistered aircraft. So use them to rank within GA, not to rank airliners.

| ICAO | Type | ADSBx registrations | OpenSky rows | Production figure |
|---|---|---|---|---|
| C172 | Cessna 172 | 28,541 | 26,918 | 44,000+ built (Wikipedia, secondary) |
| P28A | PA-28 fixed-gear | 18,612 | 17,661 | 32,778+ all PA-28 (Wikipedia) |
| C182 | Cessna 182 | 13,897 | 12,132 | |
| SR22 (+S22T) | Cirrus SR22 | 5,507 (+3,588) | 5,049 | 11,000 SR-series delivered (Cirrus, 2026-03-25) |
| R44 | Robinson R44 | 4,401 | 5,454 | 5,000th Raven II in Aug 2026 (robinsonheli.com) |
| AS50 | H125/AS350 | 3,333 | | "some 4,200 in service" (airbus.com H125 page) |
| B06 | Bell 206 | 3,334 | | |
| EC35 | H135 | 1,449 | | "over 1,600 delivered" (airbus.com H135 page) |
| B407 | Bell 407 | 1,571 | | |

Among **non-US** ADSBx registrations the order is: C172 6,393, gliders 5,042, **B738 4,666, A320 4,379**, P28A 3,565, H60 3,300, A20N 2,523, R44 2,244, C182 2,216, AS50 2,141, A21N 2,136 … (helper agent's count file, re-read by me).

### C4. Designator facts that affect the mapping

All checked by the helper agent against the live Doc 8643 JSON. I re-checked the ones used in section E.
- B737 is **only** the 737-700 (the -300/-400/-500/-600 are B733/B734/B735/B736). B38M includes the 737-8-200.
- B77L covers both the 777-200LR and the **777F**. The 777X is B778/B779.
- E75L and E75S are the E175 long and short wing. E290/E295 are the E2s.
- AT72 is only the ATR 72-201/202. The -500 and -600 are AT75 and AT76.
- **There is no H125 designator: it is AS50.** EC35 = H135. B06 also covers the 206L LongRanger.
- SR22T is S22T. The PA-28R Arrow is P28R, not P28A.

---

## D. Mapping data: ICAO designator → family

### D1. ICAO Doc 8643 (official)

- **Pages.** https://www.icao.int/operational-safety/doc-8643-aircraft-type-designators and the search page `…/search`. The search page loads `https://www.icao.int/sites/default/files/publications/Doc8643/SiteAssets/designators.html`, which calls:
  - **`POST https://doc8643.icao.int/External/AircraftTypes`** (an empty body with `Content-Length: 0` works): a 1.6 MB JSON array.
  - **`POST https://doc8643.icao.int/External/Stats`**: `{"LastUpdated":"03 September 2026","NextUpdate":"01 October 2026","AircraftTypeCount":10357,"ManufacturerCount":2103}`.
- **Row format, measured** (7,262 rows, 2,614 distinct designators):
  ```json
  {"ModelFullName":"Dornier 328JET","Description":"L2J","WTC":"M","WTG":"G","Designator":"J328",
   "ManufacturerCode":"328 SUPPORT SERVICES","ShowInPart3Only":false,"AircraftDescription":"LandPlane",
   "EngineCount":"2","EngineType":"Jet"}
  ```
- **Field values:**
  - `Description`: 3 characters: aircraft class (L land, S sea, A amphibian, H helicopter, G gyrocopter, T tilt-rotor), engine count, engine type (J jet, T turboprop/turboshaft, P piston, E electric, R rocket).
  - `WTC`: L, M, H, J (J = super: only the A388 rows), L/M.
  - `WTG`: the A–G wake turbulence groups, e.g. A388 = A, B77W = B, A20N and B38M = D, DH8D = E, E75L = F, C172 = G.
  - `EngineType`: Piston, Turboprop/Turboshaft, Jet, Electric, Rocket.
  - `AircraftDescription`: LandPlane, Helicopter, Amphibian, Gyrocopter, Tiltrotor, SeaPlane.
  - One designator can have several rows (e.g. C172 has 14, one per manufacturer/model name).
- **Licence: do not ship it.**
  - The copyright notice (https://www.icao.int/copyright-notice) says materials may not be "used, reproduced or transmitted, in whole or in part", except as the Terms allow.
  - The Terms (https://www.icao.int/terms-and-conditions) allow copying "for the User's personal, non-commercial use", "without any right to resell or redistribute them or to compile or create derivative works therefrom".
  - The bulk "Data Download" is through the paid-registration ICAO API Data Service (https://applications.icao.int/dataservices/).
  - So FlightHopper should not commit or serve this JSON. Use it only to check a table built from an open source.

### D2. Mictronics aircraft-database (open, ODC-By): recommended table

- https://github.com/Mictronics/aircraft-database. README: "Aircraft database exports are made available under the Open Data Commons Attribution License". `LICENSE` is ODC-By 1.0. Updated weekly; last commit 2026-09-20.
- **`icao_aircraft_types.zip`** → `icao_aircraft_types.json`: 88,638 bytes, **10,040 bytes gzipped** (measured), 2,788 designators.
  - Format: `{"A20N":{"desc":"L2J","wtc":"M"}, "AT76":{"desc":"L2T","wtc":"M"}, "R44":{"desc":"H1P","wtc":"L"}, …}`.
  - WTC values present: L 2,229, M 468, H 76, "-" 15. There is no "J": A388 shows as H.
- **Agreement with ICAO (measured).** 2,611 designators appear in both. `desc` differs in 8, e.g. `EV55` L2P vs ICAO L2T, and V22/B609/V280 R2T vs ICAO T2T. Mictronics has 177 designators ICAO lacks (older or retired codes); ICAO has 3 that Mictronics lacks.
- **Richer variant.** `Mictronics/readsb-protobuf` `webapp/src/db/types.json` adds the name: `{"B738":["BOEING 737-800","L2J","M"]}`, 2,788 entries, 110,811 bytes. That repo's licence is GPL (COPYING); the file's own licence is not stated (**unverified**). Prefer the ODC-By zip.
- **Attribution duty.** ODC-By §4.2 requires the licence notice when the database is "Publicly Convey[ed]", and §4.3 requires a notice for a "Produced Work" that is publicly used, e.g. "Contains information from DATABASE NAME which is made available under the ODC Attribution License."
  - A credit line in the app's About/credits and a `LICENSE-ODC-By` next to the file cover both.
  - Whether Mictronics' table is itself derived from ICAO's protected compilation is **unverified**. Single facts such as "B738 is L2J" are generally not copyrightable, but this is not legal advice.
- tar1090 uses the same data: `wiedehopf/tar1090-db` `update.sh` copies Mictronics' `types.json` into `db/icao_aircraft_types2.js`. tar1090-db has no licence file (GitHub API `license: null`).

### D3. How existing trackers fall back (design reference only; GPL code, do not copy)

- **tar1090** `html/markers.js` (tar1090 is "GPL, v2 or later", `LICENSE`), `getBaseMarker()`:
  1. `TypeDesignatorIcons[designator]` (369 explicit designators);
  2. `TypeDescriptionIcons[desc + "-" + wtc]`, e.g. `L2J-L` → non-swept bizjet, `L2J-M` → airliner, `L2J-H` → heavy twin, `L4J-H` → four-jet;
  3. `TypeDescriptionIcons[desc]`, e.g. `L1P` → cessna, `L2T` → twin turboprop, `L4T` → C-130;
  4. the first letter of `desc` (`H` → helicopter, `G` → gyrocopter);
  5. `CategoryIcons[category]` (A1 cessna, A2 swept jet, A3/A4 airliner, A5 heavy twin, A7 helicopter, B1 glider, B6 UAV).
  6. It also special-cases `L2J-M` with category `A2` as a small swept jet.
- **FlightAirMap** falls back via engine type + count + wake category keys (`J2M`, `J2H`, `T2M`, `P1L` …): see A1.

---

## E. Proposed model set and fallback mapping

### E1. The set: 12 GLBs plus Cesium Air

Take the files from **livetaiwan-aircraft-models** at commit `00d6a934afba5314e81d5b40a99f5aacdb51b953` (paths below are under its `models/`). Record each file's **upstream** licence, not the repo's blanket label. The order follows section C.

| id | Serves (explicit designators) | File | Size | Upstream licence | Why |
|---|---|---|---|---|---|
| `a320` | A318, A319, A19N, A320, A20N, A321, A21N | `flightairmap/A320.glb` (optional `A321.glb` for A321/A21N, 44.5 m) | 285 KB | GPL-2.0 (FAM `a320/COPYING`) | #2, #3, #5, #6, #7 by fleet; A320 family 11,407 in fleet |
| `b738` | B736, B737, B738, B739, B37M, B38M, B39M, B3XM | `fr24/b738.glb` | 152 KB | GPL-2.0 (fr24; `FGMEMBERS/737-800`) | #1 by fleet and by flights |
| `b77w` | B772, B773, B77W, B77L, B778, B779 | `fr24/b773.glb` (a 777-300; a true -300ER would need `FGMEMBERS/777/Models/777-300ER.ac`) | 186 KB | GPL-2.0 (fr24; FGAddon `777/LICENSE`) | #8 |
| `b787` | B788, B789, B78X | `flightairmap/B788.glb` | 165 KB | GPL-2.0 (FAM `b788/COPYING`) | #11, #19; fr24's b789 is 5 % too long |
| `a330` | A332, A333, A338, A339, and A359/A35K until `a350` is added | `flightairmap/A333.glb` | 153 KB | GPL-2.0 (FAM `a333/COPYING`) | A330 family (1,412 in fleet) outnumbers A350 (733) [AIB] |
| `e175` | E170, E75L, E75S, E190, E195, E290, E295 | `flightairmap/E75L.glb` (optional `E190.glb` for E190/E195/E29x) | 148 KB | GPL-2.0 (FAM `e190/License.txt`) | E175 is #9 worldwide and #3 by US flights |
| `crj9` | CRJ1, CRJ2, CRJ7, CRJ9, CRJX, plus rear-engine twins (E135, E145, F70, F100, B712, MD81–MD90 …) | `flightairmap/CRJ9.glb` | 155 KB | GPL-2.0-or-later (FAM `crj9/LICENSE`) | #21, #23, #25 |
| `atr72` | AT43, AT44, AT45, AT46, AT72, AT73, AT75, AT76, and DH8A–D until `dh8d` is added | `flightairmap/AT75.glb` | 200 KB | **GPL-3.0** (FAM `atr72/LICENCE.txt`; `FGMEMBERS/ATR72` README) | #16, #24 |
| `b744` | B741–B744, B748, A388, A342–A346, IL96, A124 … (all `L4J`) | `flightairmap/B747.glb` | 177 KB | GPL-2.0 (FAM `b744/COPYING`) | the quad fallback |
| `c550` | bizjets: C25A/B/C, C500–C56X, C68A, C700, E55P, LJ35–LJ75, GLF4–GLF6, GL5T, GL7T, F2TH, FA7X, F900, CL30, CL35, CL60, PC24, HDJT … | `flightairmap/C550.glb` | 369 KB | GPL-2.0 (FAM `c550/COPYING`) | the bizjet fallback |
| `c182` | C172, C182, C150, C152, P28A, SR22, DA40 … (all `L1P`) | `flightairmap/C182.glb` | 240 KB | GPL-2.0 (FAM `c182/LICENSE`) | C172 and P28A top every registration count (C3) |
| `ec135` | all `H***` | `flightairmap/EC35.glb` | 324 KB | GPL-2.0 (FAM `ec35/LICENSE`) | the helicopter fallback |
| `cesium-air` (existing) | anything still unmatched | `public/models/Cesium_Air.glb` | 573 KB | Apache-2.0 | stays `default` |

**The 12 new files total about 2.5 MB** (sum of the measured sizes above).

**Next additions**, each already in livetaiwan unless noted:
- `a350` (`flightairmap/A350.glb`, 435 KB)
- `a380` (`A380.glb`, 386 KB)
- `bcs3` (`BCS3.glb`, 216 KB) for the A220
- `pc12` (`PC12.glb`, 112 KB) for `L1T`
- `pa28` (`PA28.glb`, 136 KB) for low-wing singles
- `b752` / `b763` (FAM)
- `dh8d`: **not** in livetaiwan. Build it from fr24 `source/q400/q400.blend` with their `scripts/bl_join_blend.py`.

There is no 737 MAX-specific or A320neo-specific mesh anywhere in these repos: the NG and ceo meshes stand in for them.

**Fallback via the original textured files.** If livetaiwan's provenance does not check out, the same aircraft are in FAM `…/glTF2/*.glb` and fr24 `models/*.glb`. Those need the same strip-and-decimate pass (Aeris used `@gltf-transform/cli`), plus a glTF 1.0 → 2.0 conversion for the fr24 files.

**Manifest changes the set implies:**
- A `types: string[]` per entry (or a separate `types.json`).
- Per-model bracket geometry: `BOX_CENTRE` and `BOX_HALF` are Cesium Air constants in `traffic.ts:17-19`.
- `scale` ≈ 1 for these metre-scale files.
- The per-category `SCALE` table becomes a fallback-only size hint.

### E2. Fallback order (reimplemented; do not copy GPL tar1090 code)

The input is `typeCode` and `category`. `desc` (e.g. `L2J`) and `wtc` come from the shipped Mictronics table (section D2).

1. **Exact designator** in the E1 lists → that model.
2. **`desc` + `wtc`**. Letters: 1st = class, 2nd = engine count, 3rd = engine type.

| Key | Model | Examples |
|---|---|---|
| `H**`, `G**`, `T**` (tilt-rotor) | `ec135` | R44 `H1P`, AS50 `H1T`, EC45 `H2T` |
| `L4J`, `L4T-H` | `b744` | A388, B748, A124 |
| `L4T` (-M, -L), `L3T` | `atr72` | C130 `L4T-M` |
| `L3J-H` | `b77w` | MD11, DC10 |
| `L3J` (-M, -L) | `c550` | Falcon 900/7X |
| `L2J-H` | `b787` | A306, B764, IL-62-class twins |
| `L2J-M` **and** ADS-B category `A2` | `c550` | GLF6 (G650 is `L2J-M`), CL60 |
| `L2J-M` (otherwise) | `a320` | B752, C919, SU95, A148 |
| `L2J-L`, `L1J` | `c550` | C25B `L2J-L` |
| `L2T` (any WTC), `A2T` | `atr72` | BE20 King Air, DHC6 |
| `L1T`, `A1T` | `c182` (or `pc12` once added) | PC12, C208, TBM9 |
| `L1P`, `L2P`, `A1P`, `A2P`, `S1P`, `L1E` | `c182` | C172, P28A, PA34 |

3. **ADS-B `category` only** (no or unknown designator):

| Category | Model |
|---|---|
| A1 | `c182` |
| A2 | `c550` |
| A3, A4 | `a320` |
| A5 | `b787` |
| A6 | `c550` (no fighter model) |
| A7 | `ec135` |
| B1 (glider), B4 (ultralight) | `c182` (optional ASK-21 glider from either repo) |
| B6 (UAV) | `c182` |
| C* (surface vehicles) | no model |

4. Otherwise → `cesium-air`.

**Why each step exists:**
- Step 1 must list the regional jets explicitly. Their `L2J-M` would otherwise make them `a320`.
- The `A2` check in step 2 is tar1090's `L2J-M` + `A2` → small swept jet rule (`markers.js` `getBaseMarker`).
- Step 3 keeps today's behaviour for aircraft with no designator.

**Explicit lists matter for bizjets too.** Checked against both tables: C56X, C68A, C700, E55P, LJ45, GLF6, GL5T, GL7T, F2TH, CL30, CL35, CL60 and PC24 are all `L2J-M`, the same as an A320. Only C25A, C25B and HDJT are `L2J-L`. FA7X and F900 are `L3J-M`. So the bizjet row of E1 must be explicit, and the `A2` rule catches the rest.

**Other table checks.**
- The 70-odd designators named in this section all exist in both Doc 8643 and the Mictronics table.
- They agree on `desc` and `wtc` except:
  - A388: ICAO `J`, Mictronics `H`.
  - BE20: ICAO `L/M`, Mictronics `M`.
- `MD80` is not a designator; the MD-80 series is MD81–MD88.

---

## F. Licence obligations for shipping GPL models in this repo

This section covers the recommended FlightGear-derived set. Quotes are from the GPL-2.0 text in `Flightradar24/fr24-3d-models/LICENSE`, with line numbers of that file. Not legal advice.

1. **The app's code does not become GPL.**
   - GPL-2.0 §2: "mere aggregation of another work not based on the Program … does not bring the other work under the scope of this License" (lines 129-132).
   - The GLBs are data fetched at run time, not linked code.
   - The FSF says the GPL can be applied to any work "as long as it is clear what constitutes the 'source code'" (https://www.gnu.org/licenses/gpl-faq.html#GPLOtherThanSoftware).
   - Note: FlightHopper (github.com/rg1989/FlightHopper, public per the GitHub API) has **no licence file**. That does not block shipping GPL assets. If a code licence is chosen later, any licence works next to GPL-2.0 data.
2. **Each shipped GLB is a modified work**, because it is converted, stripped and simplified.
   - §2(a): "You must cause the modified files to carry prominent notices stating that you changed the files and the date" (line 95).
   - Put this in each GLB's `asset.copyright`/`asset.extras` and in the manifest `license` field. `model.test.ts:65-68` already requires non-empty `license`, `author` and `source`.
3. **Source must travel with the files.**
   - §3(a): "Accompany it with the complete corresponding machine-readable source code" (line 138).
   - "Source" is "the preferred form of the work for making modifications", including "the scripts used to control compilation" (lines 155-158).
   - §3, last paragraph: giving access to copy the source "from the same place" counts (lines 166-170).
   - **Conservative path:** commit the upstream sources of the shipped models, plus the conversion scripts, in a folder Vite does not serve (e.g. `tools/models-src/`), with the licence texts.
     - With livetaiwan this means its `source/flightairmap-glb/<X>.glb` for the 10 FAM-derived files (2.0–5.4 MB each, about 31 MB), its `source/fr24-blend/b738.blend` and `b773.blend` (about 3 MB each) and its `scripts/`: roughly 37 MB in total.
     - Sizes are from the FAM/fr24 trees listed in A1/A2.
   - **Lighter path, a judgement call:** commit the unmodified upstream GLB and the script that turns it into the shipped GLB. Whether a GLB is the "preferred form" of a model whose authors worked in `.blend`/`.ac` is arguable.
   - A link to GitHub alone, without the files in this repo, is weaker under GPL-2.0 than under GPL-3.0.
4. **Credits.** Name the FlightGear authors per model. Examples: `FGMEMBERS/777/AUTHORS` lists "Syd Adams - 3d Models"; the 737NG `-set.xml` lists "Innis Cunningham (3D and Panel)". Also credit FR24 / FlightAirMap as the converters, and give Mictronics' ODC-By notice for the type table (D2).
5. **Keep licences separate.** GPL-3.0 files (AT75, PC-21) and GPL-2.0-only files may sit side by side as an aggregate. Do not **merge** meshes from GPL-2.0-only and GPL-3.0 files into one GLB.
6. **Unverified provenance, to clear before shipping:**
   - FAM `b407`, `c421`, `bcs1`, `b777` carry no licence file.
   - fr24 `b736/b737/b739` (FGMEMBERS/737NG) upstream has no licence file. It rests on FR24's "All other models are licensed under GPLv2" and on the FlightGear hangar policy. The proposed set uses only `b738`, whose upstream `FGMEMBERS/737-800` is GPL-2.0.
   - fr24 `b772/b773` (FGMEMBERS/777): the GitHub mirror has no licence file. However, the current FGAddon trunk `Aircraft/777/` has a `LICENSE` containing the GPL-2.0 text, last updated 2026-02-04 (https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/777/LICENSE, read via WebFetch). So the 777 is GPL-2.0 upstream. Whether the 2016 mesh FR24 used is the same work is **unverified** but likely: both name Syd Adams.
7. **The GPL-3.0 file (`AT75`)** carries GPL-3.0 duties instead:
   - Licence text plus "Corresponding Source".
   - GPL-3.0 §6(d) also accepts source offered "through the same place" as the object code.
   - Ship `COPYING-GPL-3.0` next to it, or pick the GPL-2.0 `AT45` (ATR 42-500 upstream; livetaiwan notes it is "really an ATR-72-sized airframe") as the turboprop model to keep one licence.
8. **Do not copy livetaiwan's blanket "GPL-2.0-or-later"** into the manifest; record each file's upstream licence (E1 column). Its `asset.copyright` string inside the GLBs says "GPL-2.0-or-later" for all files. Either leave it (it is their statement) or overwrite it with the correct per-file licence and a "modified by FlightHopper" note (item 2).

### Red flags

| Flag | Where | Why it matters |
|---|---|---|
| **Store licences forbid the raw file** | Sketchfab Standard / Free Standard, Fab Standard, TurboSquid, CGTrader royalty-free, Free3D | All require the model to be unextractable or not redistributed stand-alone. A GLB in `public/` is both. |
| **NC / ND** | Any CC BY-NC-* or BY-ND model | NC: the app may be public or commercial. ND: decimating or re-orienting is an adaptation, so the result cannot be shared. |
| **BY-SA** | e.g. Sketchfab "Boeing-747 (UNTEXTURED)" by mikerowaveoven | Every modified GLB must stay BY-SA. That is workable but is another licence regime to track. |
| **Re-uploaded CC-BY** | Several prolific Sketchfab uploaders (A5) | A CC-BY label from someone who is not the author grants nothing. |
| **Licence relabelling** | livetaiwan's blanket "GPL-2.0-or-later" | Wrong for GPL-3.0 upstreams (AT75, 707, PC21) and over-broad for GPLv2-only fr24 files. |
| **Missing licence files** | FAM `b407`, `c421`, `bcs1`, `b777`; FGMEMBERS `737NG` | Provenance rests on FlightGear policy and FR24/FAM statements. None of these are in the proposed 12. |
| **ICAO Doc 8643 data** | `doc8643.icao.int/External/AircraftTypes` | ICAO terms: personal, non-commercial use only; no redistribution. Use Mictronics (ODC-By) instead. |
| **ADS-B Exchange `basic-ac-db`** | downloads.adsbexchange.com | No licence on the download page; the terms redirect to JETNET's, which forbid redistribution. Do not ship. |
| **X-Plane default aircraft** | Laminar EULA | "not distribute the artwork … or any derivative thereof, without permission". |
| **Trademarked liveries and insignia** | Textured Sketchfab/fr24 liveries, NASA markings | Plain hulls avoid them. livetaiwan and FR24 both dropped liveries for this reason. |
| **Star Wars IP** | fr24 `millennium_falcon.gltf` (CC-BY 4.0) | Do not include it. |

---

## Sources

**Repositories** (read through the GitHub REST API with `gh api`; trees at the default branch on 2026-09-23):
- https://github.com/Ysurac/FlightAirMap: `CREDITS`, `models/sources.txt`, `install/class.update_db.php`, `live-czml.php`
- https://github.com/Ysurac/FlightAirMap-3dmodels at `0906d9ba1bdd906ce45807e45ed706c09912db19`: README, per-folder licence files, `glTF2/*.glb`
- https://github.com/Flightradar24/fr24-3d-models at `dd53267690c6a4ecbb290a3acf0284333a5d68a9`: README, `LICENSE`, `models/*.glb`, `source/*`
- https://github.com/kewonit/aeris: `docs/3D-MODELS.md`, `public/models/aircraft/NOTICE.md`, `src/components/map/aircraft-model-mapping.ts`
- https://github.com/FGMEMBERS (the per-aircraft repositories named in A4); https://github.com/c172p-team/c172p
- https://github.com/wiedehopf/tar1090: `LICENSE`, `html/markers.js`. https://github.com/wiedehopf/tar1090-db: `README.md`, `update.sh`
- https://github.com/Mictronics/aircraft-database: README, `LICENSE`, `icao_aircraft_types.zip`. https://github.com/Mictronics/readsb-protobuf: `webapp/src/db/types.json`
- https://github.com/CesiumGS/gltf-pipeline (README); https://github.com/NikolaiVChr/Blender-AC3D
- Other 3-D ADS-B viewers checked for bundled models: https://github.com/machineinteractive/skies-adsb (MIT; no GLB in its tree), https://github.com/hook-365/adsb-3d (MIT; none), https://github.com/miladasgari380/adsb-3d-tracker (no licence; vendors the fr24 GLBs)

**Web pages:**
- https://wiki.flightgear.org/FGAddon
- https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/777/LICENSE
- X-Plane 12 EULA: https://store.steampowered.com/eula/2014780_eula_0
- https://cesium.com/platform/cesium-ion/content/
- https://www.gnu.org/licenses/gpl-faq.html (#MereAggregation, #GPLOtherThanSoftware)
- ICAO:
  - https://www.icao.int/operational-safety/doc-8643-aircraft-type-designators
  - `POST https://doc8643.icao.int/External/AircraftTypes`
  - `POST https://doc8643.icao.int/External/Stats`
  - https://www.icao.int/copyright-notice
  - https://www.icao.int/terms-and-conditions
- IATA fleet report and WATS release; Airbus Orders & Deliveries (section C1)

**Repo files:** `public/models/manifest.json`, `client/types.ts`, `client/app.ts`, `client/scene/model.ts`, `client/scene/model.test.ts`, `client/scene/traffic.ts`, `shared/info.ts`, `shared/types.ts`, `data/fixtures/golden/adsbfi-point-llbg.json`, `node_modules/@cesium/engine/Source/Scene/GltfPipeline/updateVersion.js` (cesium 1.145).

**Found or read by the helper agents, then spot-checked by me:**
- https://github.com/GoLocalNear/livetaiwan-aircraft-models at `00d6a934af` (README, `docs/model-manifest.json`, `docs/ORIENTATION.md`, 20 GLBs measured)
- https://github.com/bilawalsidhu/gods-eye-view/blob/main/public/models/README.md
- Sketchfab API: `https://api.sketchfab.com/v3/models/<uid>` (4 re-queried), `https://api.sketchfab.com/v3/licenses`
- https://github.com/FGMEMBERS/ATR72 (README); https://github.com/FGMEMBERS/777 (`Models/777-300ER.ac`)

**Read only by the helper agents, some via the Wayback Machine** (not re-read by me; quotes as they reported):
- Sketchfab: https://sketchfab.com/licenses; https://sketchfab.com/developers/download-api/guidelines; the help-centre crediting article; the Fab-transition blog post
- https://www.fab.com/eula
- https://blog.turbosquid.com/royalty-free-license/
- https://www.cgtrader.com/pages/terms-and-conditions
- https://free3d.com/help/en/articles/9937609-royalty-free-license
- Creative Commons BY 4.0 / BY-ND 4.0 legal code
- Poly Pizza, Kenney and Quaternius pages
- https://github.com/nasa/NASA-3D-Resources; https://airbornescience.nasa.gov/3d-models/; https://www.nasa.gov/nasa-brand-center/images-and-media/
- https://commons.wikimedia.org/wiki/Commons:3D_models
- Boeing Orders & Deliveries (Tableau); Embraer, De Havilland, Cirrus, Robinson and Airbus Helicopters pages
- The OpenSky and ADS-B Exchange aircraft databases (counted, then deleted)
- https://opensky-network.org/data/aircraft
- https://simpleflying.com/13-aircraft-types-operate-most-flights-us/
