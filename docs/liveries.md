<!-- docs/liveries.md -->
# Liveries and type models: how to add an aircraft

FlightHopper draws each aircraft on a 3-D model of its type, painted in its operator's livery. This document tells you
how to add a new type model and a new airline livery. The same steps made the first five combinations (El Al 737,
Wizz Air A321neo, Israir A320, flydubai 737 MAX 8, Royal Jordanian A320neo).

The design is in `.planning/livery-pipeline-design.md`. Read section 3 ("The method, and why") first.

## The pipeline at a glance

```
survey ──► type model ──► reference photos ──► dossier ──► design ──► lab + shots ──► compare ──► fix ──► done
(what flies) (geometry)    (refs.ts)          (research)  (designs/)  (livery-lab)     (you/agent)
```

| Step | Tool | Output |
|---|---|---|
| 1. Find what to paint | `node tools/liveries/survey.ts` | type × operator ranking, airframes (hex, registration) |
| 2. Make or pick the type model | `tools/models/variants.ts`, `tools/models/profile.ts` | `public/models/<id>.glb`, manifest entry with `profile` |
| 3. Get reference photos | `node tools/liveries/refs.ts` | `data/livery-refs/<CODE>/` + `refs.json` (git-ignored) |
| 4. Describe the livery | research (by hand or by agent) | `.planning/liveries/<CODE>.md` (the dossier) |
| 5. Draw the design | edit `client/livery/designs/<CODE>.ts` | the design, registered in `designs/index.ts` |
| 6. Look at it | `/tools/livery-lab/?model=<id>&livery=<CODE>` | the model beside the photos |
| 7. Capture sheets | `node tools/livery-shots.ts <id>:<CODE> …` | `data/livery-refs/shots/<id>-<CODE>/*.png` |
| 8. Repeat 5–7 | until the model looks like the photos | |

To do all of it with agents, run the saved workflow (Part 5).

## Part 1. Find what to paint

```bash
node tools/liveries/survey.ts --top 30
```

The survey reads the recordings in `data/recordings/` (the recorder's queries around Ben Gurion by default; use
`--near lat,lon` for another hero airport, `--near all` for every query). It ranks each type × operator by flights and
airframes, and shows which model draws the type and whether the operator has a design (`design`), only colours
(`colours`) or nothing (`none`). `--json out.json` also writes every airframe (hex, registration) per combination.

Wet-leased aircraft fly under the operator's callsign in the lessor's paint. The app paints them in the operator's
livery (one livery per airline). Choose reference photos of the operator's own aircraft.

## Part 2. The type model

### 2.1 Is there a model already?

`client/scene/modelFor.ts` picks the model for an ICAO type designator from `public/models/manifest.json`: an entry
that lists the designator, then the longest `PREFIX*` entry, then the family fallback. The survey prints the model for
each type. If the model is right for the type (same family, same wingtips, same engines), go to Part 3.

### 2.2 A variant of an existing model (recipe)

Most new types differ from a model we have only in wingtips and engines (A320 → A320neo, 737-800 → 737 MAX 8). Add a
recipe to `tools/models/variants.json` and build it:

```bash
node tools/models/variants.ts            # builds every recipe: public/models/<id>.glb + the manifest entry
node tools/models/profile.ts --write     # measures the side profile of every model into the manifest
node tools/models/light-anchors.ts --write
```

A recipe names the base model, the wingtip device (`sharklet`, `at-winglet`, `blended`, `none`, with sizes), the
nacelle change (scale, forward and up shift) and the ICAO types the new model takes over. See the existing recipes and
their sources. A derived model is GPL like its base: add it to `third_party/aircraft-models/README.md` ("Modified") and
`licences.json`.

### 2.3 A new model from a source file

Use a GPL model from FlightAirMap-3dmodels or Flightradar24's fr24-3d-models, as in
`.planning/reports/aircraft-models-research.md`. Convert and simplify it with the scripts in
`third_party/aircraft-models/scripts/` (Blender: `/opt/homebrew/bin/blender -b`), then:

1. Put the GLB in `public/models/` and the unchanged source in `third_party/aircraft-models/source/`.
2. Add a manifest entry (copy a similar one): `uri`, `license`, `author`, `source`, `forwardAxisFix`, `lengthM`,
   `gearHeightM`, `scale`, `types`, `box`, `paint` (the region map), and a `gear` model if there is one.
3. Run `profile.ts --write` and `light-anchors.ts --write`.
4. Run `npm test`: `model.test.ts` checks the length and the nose direction from the geometry.
5. Look at the profile overlay (`profile.ts --png <dir>`): every outline must sit on the mesh.

### 2.4 The profile

The livery is drawn on the model's side profile (`ModelProfile` in `client/types.ts`): the fuselage outline, the fin,
the wing root, the nacelle box, the wingtip device box, the tailplane, the passenger doors and the cockpit windows, in
the paint frame (metres; +z to the nose, +y up, +x to the left wing). The profile tool measures it from the mesh.

## Part 3. The airline design

### 3.1 Reference photos

```bash
node tools/liveries/refs.ts --code WZZ --hex 4d2531,4d2532,… --commons "Category:Wizz Air Airbus A321neo"
```

Take the hexes from the survey (`--json`). The tool gets each airframe's photo from planespotters.net (the app's photo
source: thumbnails, for reference only, credited) and larger free photos from a Wikimedia Commons category. They go
into `data/livery-refs/<CODE>/`, which git ignores: never commit or ship a photo. Open `refs.json` and replace each
`"view": "?"` with what the photo shows: `left side`, `right side`, `3/4 front left`, `3/4 rear right`, `tail`,
`engine`, `winglet`, `below`. The lab puts the same view of the model beside each photo.

Get at least: one clean photo of each side, a 3/4 front view, the tail, an engine and a wingtip device.

### 3.2 The dossier

Write down how the livery looks before you draw it: `.planning/liveries/<CODE>.md`. The existing dossiers show the
format: which aircraft wear the scheme, every colour as a hex with its evidence, every element in side elevation
(belly line, cheatlines, titles and their size and place, fin art, engines, wingtips, left/right differences), the
logos and their licences, and the fonts.

### 3.3 Logos and fonts: licences

- Logos: only public-domain or freely licensed files from Wikimedia Commons (for example `PD-textlogo`). Put them in
  `public/liveries/<CODE>/` (SVG preferred, with `width` and `height` set) and record each file's source and licence in
  that folder's `sources.json`: `{ "wordmark.svg": { "source": "https://commons.wikimedia.org/wiki/File:…", "licence": "PD-textlogo" } }`.
- A wordmark with no free file: typeset it in an OFL font that looks like it (Google Fonts), in `public/fonts/` with its
  licence file.
- A graphic emblem with no free file: leave it out, or use plain colour shapes that are not a copy of it.
- Photos: never.

### 3.4 Write the design

A design is a TypeScript module, `client/livery/designs/<CODE>.ts`, registered in `client/livery/designs/index.ts`.
It draws one side of the aircraft at a time. The kit (`client/livery/kit.ts`) gives you the model's landmarks and
drawing calls in metres. The same design paints every model the airline flies.

```ts
import { asset } from '../kit.ts'
import type { Design } from '../kit.ts'

const BLUE = '#0b2e6b'

export const ELY: Design = {
  code: 'ELY',
  name: 'El Al (2023 scheme)',
  sources: ['https://commons.wikimedia.org/wiki/File:…'],
  base: '#ffffff', wing: '#c9ced6', engineColor: '#ffffff',
  side(k) {
    k.fill('#ffffff')                                   // the whole fuselage and fin
    k.below(0.28, '#d6dade')                            // belly: below 28 % of the fuselage height
    k.stripe(0.45, 0.35, BLUE, { from: k.a.cockpit, to: k.a.tail })   // a cheatline 0.35 m wide
    k.finFill(BLUE)                                     // the fin, from its measured outline
    k.text('EL AL', { z: k.a.door1 - 1.5, y: k.a.windowY + 0.45, capM: 0.9, color: BLUE, weight: 800 })
    k.image(asset('liveries/ELY/logo.svg'), { z: k.fin(0.5, 0.5)[0], y: k.fin(0.5, 0.5)[1], h: 2.2 })
  },
  engine(k) { k.fill('#ffffff') },
}
```

The frame: `z` is metres along the fuselage (larger is further forward), `y` is metres up. Draw in painter's order:
later calls paint over earlier ones. Shapes may run past the aircraft (only the surface is sampled); let them overshoot
at the nose and the tail so no seam shows.

Landmarks (`k.a`): `nose`, `tail`, `length`, `cockpit` (aft edge of the cockpit windows), `door1`, `doors`,
`windowY` (the cabin window row), `wingLe`, `wingTe` (the wing root chord), `finRoot`, `finTip` (`[y, le, te]`), `box`.

Where things are:

| Call | What it gives |
|---|---|
| `k.top(z)`, `k.bottom(z)` | the fuselage crown and keel height at `z` |
| `k.at(z, f)` | the height at fraction `f` of the local fuselage height (0 keel, 1 crown) |
| `k.fin(u, h)` | a point on the fin: `u` 0 leading edge … 1 trailing edge, `h` 0 root … 1 tip |
| `k.stations(from, to, step)` | z values from `from` to `to`, for building your own curves |

Drawing (all colours are CSS strings, sRGB):

| Call | Draws |
|---|---|
| `k.fill(color)` | the whole region |
| `k.band(f0, f1, color, {from, to})` | between two contour fractions (numbers or functions of `z`), from `z` `from` to `to` |
| `k.below(f, color, o)`, `k.above(f, color, o)` | everything below (belly) or above a fraction |
| `k.stripe(f, widthM, color, o)` | a stripe of constant width centred on a fraction |
| `k.poly([[z, y], …], color)` | a polygon |
| `k.path([['M', z, y], ['L', z, y], ['Q', cz, cy, z, y], ['C', …], ['Z']], color)` | a path with curves |
| `k.finFill(color, {down})` | the fin, from its measured outline, reaching `down` m into the fuselage |
| `k.finPoly([[u, h], …], color)` | a polygon in fin coordinates |
| `k.text(str, {z, y, capM, color, font, weight, italic, align, tracking, mirror})` | text; `y` is the baseline, `capM` the cap height; `align` says which end sits at `z` (`fore`, `centre`, `aft`) |
| `k.image(src, {z, y, w, h, mirror, opacity})` | an image centred at `z`, `y`; give `w` or `h` (the image's aspect gives the other); `src` = `asset('liveries/<CODE>/x.svg')` |

Text and images read correctly on both sides: on the right side the kit flips them, so a title covers the same span
of the fuselage on both sides. Set `mirror: true` for a directional logo that must face forward on both sides.

`k.side` is `'left'` or `'right'`, for the rare design that differs per side (for example a title in another script
on the right). `k.model` is the manifest id, for a per-type tweak (`if (k.model.startsWith('b78'))`).

The engines: `engine(k)` draws the nacelle's side box (`k.a.box` is `[zInletAft…]`: `[zMin, zMax, yMin, yMax]`; the
inlet is at `zMax`). The wingtip devices: `winglet(k)`, over the device's side box. Wings and the tailplane: the flat
colours `wing` and `stab`.

### 3.5 Look at it

Start the dev server (`npx vite`, or the launch config) and open:

```
/tools/livery-lab/?model=a21n&livery=WZZ
```

The lab shows each reference photo beside the same view of the model, every view (left, right, 3/4 front and rear,
below, above, tail, forward fuselage, engine, wingtip), and the atlases the design drew. Parameters: `views=refs` (only
the views the photos show), `views=left,tail`, `gear=0`, `refs=0`, `w`, `h`.

To capture the sheets without a browser (for an agent, or to compare before and after):

```bash
node tools/livery-shots.ts --views refs a21n:WZZ b738:ELY
```

### 3.6 Done when

- Every photo view matches: the colours (in the same light), the belly line, every stripe and swoosh, the title's text,
  size and place on each side, the fin art, the engines and the wingtips.
- `npm test` passes (`client/livery/designs.test.ts` draws every design on every model).
- The design names its sources, and every file in `public/liveries/<CODE>/` has its source and licence in `sources.json`.

## Part 4. How it works

- The design runs once per model it is drawn on, in the browser, when an aircraft of that airline and type appears
  (`client/scene/livery.ts`, `LiveryShaders`). `client/livery/raster.ts` draws its calls into three canvases: the skin
  atlas (2048 × 1024: the left side in the top half, the right side in the bottom half, the nose at the left in both),
  the nacelle atlas and the wingtip atlas. The model shows the flat `base` colour for the few frames until they are
  ready.
- The paint shader projects each atlas across the span: a point of the fuselage or fin takes the colour of its side
  view position. That is exact for the fin and right for the fuselage sides; the crown and the belly take the top and
  bottom rows of the artwork. Cabin windows are drawn by the shader.
- Airlines with only colours in `liveries.json` (and scenario liveries) become designs automatically
  (`client/livery/legacy.ts`).

## Part 5. The agent workflow

`tools/liveries/livery.workflow.js` runs Parts 3.1–3.6 with agents for one or more airlines: a researcher gets the
photos and writes the dossier, a checker verifies it, a designer writes the design and iterates with the lab shots, and
an independent critic compares the shots with the photos until they match. In Claude Code:

```
Workflow({ scriptPath: 'tools/liveries/livery.workflow.js', args: [{ code: 'AEE', airline: 'Aegean', model: 'a21n', types: 'A321neo (A21N)' }] })
```

It needs the dev server on :5182 (`liveries-replay-client`) or `args.host`.
