# Aircraft models: GPL corresponding source

This folder is the corresponding source for 14 aircraft models in `public/models/`:

`a320.glb`, `a321.glb`, `a333.glb`, `a359.glb`, `at75.glb`, `b738.glb`, `b744.glb`, `b773.glb`, `b789.glb`, `c182.glb`, `c550.glb`, `crj9.glb`, `e75l.glb`, `ec135.glb`.

The models are GPL-licensed. The GPL says that whoever distributes the models must also make the source available. This folder keeps that source in this repository, next to the models, so FlightHopper meets that obligation itself.

`public/models/Cesium_Air.glb` is not part of this set. It comes from CesiumJS under Apache-2.0.

## Contents

| Path | What it is |
|---|---|
| `source/flightairmap-glb/` | The 8 upstream glTF 2.0 files from FlightAirMap-3dmodels that 8 of the models were built from. Unchanged. |
| `source/fr24-blend/` | The 6 upstream Blender files from fr24-3d-models that the other 6 models were built from. Unchanged. |
| `scripts/` | All the conversion scripts from livetaiwan-aircraft-models. Unchanged. |
| `LICENSE-GPL-2.0` | The GPL version 2 text (from livetaiwan-aircraft-models). |
| `LICENSE-GPL-3.0` | The GPL version 3 text (from https://www.gnu.org/licenses/gpl-3.0.txt). `at75.glb` is GPL-3.0. |
| `licences.json` | Licence, authors and upstream URL for each model. The app copies these into the model manifest. |

Every file in `source/` is byte-identical to the upstream file. We checked this with git blob hashes against the upstream repositories.

## Models

Upstream commits:

- FAM = [Ysurac/FlightAirMap-3dmodels](https://github.com/Ysurac/FlightAirMap-3dmodels) at `0906d9ba1bdd906ce45807e45ed706c09912db19`.
- FR24 = [Flightradar24/fr24-3d-models](https://github.com/Flightradar24/fr24-3d-models) at `dd53267690c6a4ecbb290a3acf0284333a5d68a9`.
- livetaiwan = [GoLocalNear/livetaiwan-aircraft-models](https://github.com/GoLocalNear/livetaiwan-aircraft-models) at `00d6a934afba5314e81d5b40a99f5aacdb51b953`.

| FlightHopper file | livetaiwan file | Upstream file | Licence | Original FlightGear authors |
|---|---|---|---|---|
| `a320.glb` | `models/flightairmap/A320.glb` | FAM `a320/glTF2/A320.glb` (FGMEMBERS/A320-family) | GPL-2.0-only | fredb, curt, mfranz, Ryan Miller, Durk Talsma, janodesbois, F-JJTH, James Turner |
| `a321.glb` | `models/flightairmap/A321.glb` | FAM `a320/glTF2/A321.glb` (FGMEMBERS/A320-family) | GPL-2.0-only | as `a320.glb` |
| `a333.glb` | `models/flightairmap/A333.glb` | FAM `a333/glTF2/A333.glb` (FGMEMBERS/A330-300) | GPL-2.0-only | Narendran Muraleedharan |
| `a359.glb` | `models/flightairmap/A350.glb` | FAM `a350/glTF2/A350.glb` (FGMEMBERS/A350XWB) | GPL-2.0-or-later | Juuso Tapaninen, Brendan O'Gara (Sbyx), Chris Leung, Chris Andrews, Joshua Davidson |
| `e75l.glb` | `models/flightairmap/E75L.glb` | FAM `e190/glTF2/E75L.glb` (FGMEMBERS/E-jet-family) | GPL-2.0-only | Narendran Muraleedharan |
| `crj9.glb` | `models/flightairmap/CRJ9.glb` | FAM `crj9/glTF2/CRJ9.glb` (FGMEMBERS/CRJ700-family) | GPL-2.0-or-later | Ryan Miller |
| `at75.glb` | `models/flightairmap/AT75.glb` | FAM `atr72/glTF2/AT75.glb` (FGMEMBERS/ATR72) | GPL-3.0-only | Narendran Muraleedharan, Donald Belcham, Dwayne Gable, Oliver (ot-666), camelon |
| `c182.glb` | `models/flightairmap/C182.glb` | FAM `c182/glTF2/C182.glb` (FGMEMBERS/c182s) | GPL-2.0-only | Heiko Schulz (3D) and the c182s authors |
| `b738.glb` | `models/fr24/b738.glb` | FR24 `source/b738/737.blend` (FGMEMBERS/737-800) | GPL-2.0-only | Innis Cunningham (3D) and the 737-800 authors |
| `b773.glb` | `models/fr24/b773.glb` | FR24 `source/b773/777-300.blend` (FGMEMBERS/777) | GPL-2.0-only | Syd Adams (3D) and the 777 authors |
| `b789.glb` | `models/fr24/b789.glb` | FR24 `source/b789/787-900.blend` (FGMEMBERS/787-9) | GPL-2.0-only | Jonathan Redpath, MSA-S23, after the 787-8 by Joshua W and others |
| `b744.glb` | `models/fr24/b744.glb` | FR24 `source/b744/747.blend` (FGMEMBERS/747-400) | GPL-2.0-only | Gijs de Rooy and the 747-400 authors |
| `c550.glb` | `models/fr24/citation.glb` | FR24 `source/citation/citation.blend` (FGMEMBERS/Citation) | GPL-2.0-only | Curtis L. Olson, Ludovic Brenta, chris_blues |
| `ec135.glb` | `models/fr24/ec135.glb` | FR24 `source/ec135/ec135.blend` (FGMEMBERS/ec135) | GPL-2.0-only | Heiko Schulz (3D) and the ec135 authors |

Authors come from the `AUTHORS`, `README` or `-set.xml` files of each FGMEMBERS repository.

### How we decided each licence

livetaiwan labels every file "GPL-2.0-or-later". That label is wrong for some files, so we used the upstream licence of each file instead.

- **FAM files.** FAM has no licence for the whole repository. Each aircraft folder has its own licence file.
  - `a320`, `a333`, `e190`, `c182`: the file is the plain GPL-2.0 text. No file says "or any later version", so we record GPL-2.0-only.
  - `a350`: the file is the plain GPL-2.0 text. The upstream FGMEMBERS/A350XWB README says "Released under GPL2+", so we record GPL-2.0-or-later.
  - `crj9`: the file says "GNU General Public License, version 2 or above", so we record GPL-2.0-or-later.
  - `atr72`: the English part of the file is the GPL-3.0 text. The upstream FGMEMBERS/ATR72 README says "This aircraft is released under the GNU GPL v3 License". Neither says "or later", so we record GPL-3.0-only. (FAM's `atr72/LICENCE.txt` is the same file as its `b707/LICENCE.txt`. Its Portuguese part is a translation of GPL-2.0. The README statement is the one we rely on.)
- **FR24 files.** The FR24 `LICENSE` is the GPL-2.0 text. The FR24 README says "All other models are licensed under GPLv2", with no "or later". So all 6 are GPL-2.0-only. This includes `c550.glb`, although its FlightGear upstream (FGMEMBERS/Citation) is GPL-2.0-or-later.
- **Gaps upstream of FR24.** The FGMEMBERS/777 mirror has no licence file. For `b773.glb` we rely on the FR24 statement. The FlightGear FGAddon copy of the 777 has a GPL-2.0 `LICENSE`.

Each GLB still has livetaiwan's `asset.copyright` string, "GPL-2.0-or-later, derived from FlightGear / FGMEMBERS / Flightradar24 fr24-3d-models". We did not change the files. `licences.json` and this README have the correct licence for each file.

## Modified

These models are modified versions of the upstream files.

- **livetaiwan (2026-08-19, commit `00d6a934`)** made these changes to each upstream file, with Blender 5.2 and Python:
  1. Joined all objects into one mesh with one material.
  2. Decimated the mesh to about 20% of the original triangles.
  3. Removed all textures.
  4. Rotated the model to one axis convention: `+X` right wing, `+Y` up, `-Z` nose.
  5. Moved the origin to the centre of the airframe.
  6. Added a `COLOR_0` shade attribute from the vertex normals.
- **FlightHopper (2026-09-23)** copied the 14 files unchanged from livetaiwan commit `00d6a934`. Only the file names changed (for example, `A350.glb` became `a359.glb` and `citation.glb` became `c550.glb`).

## How to rebuild

You need Blender 4.x or 5.x with the glTF exporter, and Python 3. Run these commands in this folder. For the full notes, see the README of livetaiwan-aircraft-models.

1. Join, decimate and remove materials. Do this once for each source file:

   ```bash
   blender -b --python scripts/bl_join.py -- source/flightairmap-glb/A320.glb out/ 0.20
   blender -b --python scripts/bl_join_blend.py -- source/fr24-blend/b738.blend out/ 0.20
   ```

2. Rotate, recentre and add the shade attribute:

   ```bash
   python3 scripts/canonicalise.py out/ models/ --report report.json
   ```

3. If you changed the files, write the licence string again into `asset.copyright`:

   ```bash
   python3 scripts/embed_copyright.py models/
   ```

4. Rename each output to its FlightHopper name (see the table). Copy it to `public/models/`.

Keep the livetaiwan file names until step 4. `canonicalise.py` finds the helicopter orientation by file name (`ec135`).

`scripts/contact_sheet.py` draws a preview image of the models. It needs `numpy` and `Pillow`. The other scripts need only Python 3 or Blender.

The FAM upstream folders also contain Blender files (for example `a320/a320.blend`). FAM made its glTF files from those. livetaiwan built from the glTF files, so this folder has the glTF files.

## Credits

The aircraft are the work of the FlightGear community. Thanks to:

- [FlightGear](https://www.flightgear.org/) and the authors of each aircraft (see the table).
- [FGMEMBERS](https://github.com/FGMEMBERS), who keep the FlightGear aircraft repositories.
- [Flightradar24](https://github.com/Flightradar24/fr24-3d-models), who converted 6 of the models and published the Blender files.
- [Ysurac / FlightAirMap](https://github.com/Ysurac/FlightAirMap-3dmodels), who converted 8 of the models to glTF 2.0.
- [GoLocalNear / livetaiwan-aircraft-models](https://github.com/GoLocalNear/livetaiwan-aircraft-models), who made the web-ready versions and wrote the scripts.
