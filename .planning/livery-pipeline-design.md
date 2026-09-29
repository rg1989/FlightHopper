# Livery pipeline: type models and airline paint from reference photos

Status: design, 2026-09-29. Branch `feat/livery-pipeline` (worktree `../FlightHopper-liveries`).

## 1. Goal

The user's request (2026-09-29): look at the traffic over Israel, find the most common aircraft, study how each
operator's aircraft look (the app's photos and other photos online), then build **a reusable pipeline** that makes an
aircraft model plus an operator's paint job as it looks on the real aircraft, and use it for about five combinations.

Stop condition: the pipeline is ready and documented, and five model + paint combinations are built with it and
checked against reference photos.

## 2. What flies over Israel (survey)

A week of the recorder's LLBG circle (40 nm around Ben Gurion, 2026-09-22 … 29, 739 airframes), by airframe and flight:

| # | Combination | Airframes | Model today | Chosen |
|---|---|---|---|---|
| 1 | El Al 737-800 (B738 ELY; B739 shares it) | 23 (+8 B739) | `b738` (NG, blended winglets) | yes |
| 2 | Wizz Air A321neo (A21N WZZ, WMT, WUK) | 68 | `a321` (ceo, no sharklets) | yes, new `a21n` |
| 3 | Israir A320 (A320 ISR, own 4X-AB* frames) | 16 (8 own) | `a320` (ceo) | yes |
| 4 | flydubai 737 MAX 8 (B38M FDB) | 23 | `b738` (NG) | yes, new `b38m` |
| 5 | Royal Jordanian A320neo (A20N RJA) | 14 | `a320` (ceo) | yes, new `a20n` |
| 6 | El Al 787-9 (B789 ELY) | 13 | `b789` | bonus: same El Al design |

Wet-leased frames (LY-, YR-, 9A-, 5B- under ELY, ISR, AIZ callsigns) wear the lessor's paint: the livery is keyed by
the operator, so they come out in the operator's paint. Accepted (one standard livery per airline, user decision
2026-09-23).

## 3. The method, and why

The models are decimated, untextured, single-mesh GLBs with no usable UVs, so paint cannot be a UV texture. The
existing shader already paints by region (body, fin, engines) with flat colours and two decals. Real liveries need
curves, bands that follow the fuselage, titles in the right place, tail art, painted engines and wingtips.

**Paint = side-elevation artwork, projected along the span.** For almost every airline livery, the paint at a point of
the fuselage or fin depends only on where the point is seen from the side (z along the fuselage, y up): stripes, belly
colour, titles and tail art are all drawn in side elevation. A projection along x is therefore exact for the fin (a
thin plate), right for the fuselage sides, and gives the crown and belly the colour of the top and bottom rows of the
artwork, which is what liveries do.

**One design per airline, drawn onto any model at run time.** A design is a small TypeScript function that draws the
livery with a kit of helpers in metres and in landmark terms (fuselage contour fractions, fin chord/height, window
line, door 1, wing root). At run time the app draws it onto a canvas for the model it flies on (using that model's
measured side profile) and uploads the canvas as the atlas texture of that model's paint shader. So one El Al design
paints the 737-800, 737-900ER, 787-8 and 787-9, and a new type model gets every airline's paint for free.

**Models get the geometry the paint needs.** A tool measures each model's side profile from its mesh (contour, fin,
engines, wingtip device), and a variant tool derives new type models from existing ones by recipe (sharklets, 737 MAX
AT winglets, larger neo/LEAP nacelles), so the A320neo, A321neo and 737 MAX look right.

**The loop that makes it "as on the real aircraft": reference photos → design → rendered comparison sheet → critic.**
A livery lab page renders a model in a livery from the same views as the reference photos; a shot tool captures those
sheets headless; an agent (or a person) compares them with the photos and fixes the design. The same loop, saved as a
workflow script, adds the next airline.

Rejected: per-model UV textures (no UVs; one texture per model × airline); photo projection onto the mesh (photo
copyright, perspective and lighting baked in); baking PNG atlases at build time (models × airlines files, binary
churn; the run-time canvas costs a few ms per combination and is cached).

## 4. Frames and conventions

- **Paint frame** (what `livery.ts` already calls "turned"): mesh metres, +z towards the nose, +y up, +x the left wing.
  `noseMinusZ` models are turned 180° about y first.
- **Body atlas**: a 2048 × 1024 RGBA texture covering the profile's `box` [zMin, zMax, yMin, yMax]. Top half: the left
  side (seen from the left, x > 0); bottom half: the right side. **Both halves have the nose on the left** (u = 0 at
  zMax), the convention of the scenario body wrap, which becomes a special case of it. Shapes are drawn identically on
  both halves (mirror-symmetric paint); text and images are drawn flipped in the right half so they read correctly
  from the right (optionally mirrored so a directional logo faces forward on both sides).
- **Engine atlas** (512 × 512): the same two halves over the nacelle's side box [zMin, zMax, yMin, yMax]; the half is
  chosen by the surface normal's x sign (the outboard face of the left engine faces +x).
- **Winglet atlas** (256 × 512): the same, over the wingtip device's side box; half by normal x sign.
- Wings and the tailplane: flat colours from the design (default: the model's greys).
- Cabin windows stay procedural (`windowRow`), the cockpit glass stays the mesh's dark vertex colour.

## 5. Model profile (`ModelProfile`, manifest `profile`)

Measured by `tools/models/profile.ts` from the GLB, in the paint frame, mesh metres, rounded to 1 cm:

```ts
export interface ModelProfile {
  box: [zMin: number, zMax: number, yMin: number, yMax: number] // the body atlas box: tail … nose, keel … fin tip, +0.1 m pad
  body: Array<[z: number, yBottom: number, yTop: number]>          // fuselage side outline, nose → tail, every 0.25 m; fin, wings,
                                                                   // tailplane and engines excluded; belly fairing included
  fin: Array<[z: number, y: number]>                               // the fin's side outline above the fuselage, closed, LE root first
  finRoot: [y: number, le: number, te: number]                     // fin leading/trailing edge z where it meets the fuselage
  finTip: [y: number, le: number, te: number]                      // …and at its tip
  wing: [rootLe: number, rootTe: number, rootY: number, tipX: number, tipY: number] // root chord at the fuselage side; tip
  engines: [xMin: number, xMax: number, zMin: number, zMax: number, yMin: number, yMax: number] | null // nacelles (+ pylons)
  winglet: [xMin: number, xMax: number, zMin: number, zMax: number, yMin: number, yMax: number] | null // tip device above the wing
  stab: [zMin: number, zMax: number, halfSpan: number] | null      // horizontal tailplane
  doors: number[]                                                  // z of the left-side passenger door centres, nose → tail (may be [])
  cockpit: number                                                  // z of the cockpit windows' aft edge
}
```

The existing `paint` map stays (the shader's region tests and the old decal boxes, used by the legacy converter).

## 6. Designs (`client/livery/`)

- `kit.ts` — the `Kit` a design draws with (pure: records draw ops; unit-tested in node):
  - landmarks `k.a`: nose, tail, cockpit, door1 (…doors), wingLe, wingTe, windowY, finRoot/finTip, box;
  - `k.top(z)`, `k.bottom(z)`, `k.at(z, f)`: the fuselage contour and the y at fraction f (0 keel … 1 crown) at z;
  - `k.fin(u, h)`: a point on the fin, u 0 LE … 1 TE, h 0 root … 1 tip (follows the sweep);
  - drawing, painter's order: `fill`, `poly`, `path` (M/L/Q/C/Z in metres), `band(f0, f1, …)` (between contour
    fractions, optionally from/to z, fractions may be functions of z), `stripe(f, widthM, …)`, `finFill`, `finPoly`,
    `text(str, {z, y, capM, font, weight, color, align, italic, tracking})`, `image(src, {z, y, w|h, mirror})`,
    `wrap(src)` (a ready-made atlas image: scenario body wraps);
  - `k.side`: 'left' | 'right' for the rare asymmetric design (e.g. a different script per side).
- `designs/<CODE>.ts` — one per airline: code, name, sources (reference photo URLs and credits), colours, `side(k)`,
  optional `engine(k)`, `winglet(k)`, `wing`, `stab`, optional per-model tweaks (`k.model` id).
- `legacy.ts` — turns a `liveries.json` colours-only entry and a scenario `LiverySpec` into a design (fill, belly,
  fin, fin2 split, title and fin-logo images at the paint map's boxes), so there is one shader path.
- `paint.ts` — the browser executor: loads the design's images and fonts, draws the ops into canvases, returns the
  three atlases as RGBA arrays. Cached per model × airline for the session; the model shows its flat colours for the
  few frames until the atlas is ready.
- Assets: `public/liveries/<CODE>/…` (logos: Wikimedia Commons public-domain or free files only, source and licence
  in `liveries.json` `logos`); `public/fonts/` (OFL fonts, licence files beside them).

## 7. The shader

`paintShaderText(paint, profile)`: body and fin fragments sample the body atlas by (z, y); engine fragments the engine
atlas; winglet fragments (|x| inside the winglet box, above the wing plane at the tip) the winglet atlas; the rest is
wing (tailplane: aft of the fin's root LE) in the design's flat colours. Everything else stays: glossy/semi-gloss
finish, window row and glass, night cabin glow and logo lights, the chased aircraft's lamps, span fold, damage cut.

## 8. Tools and the lab

- `tools/models/profile.ts` — measures `profile` for every manifest model (`--write` updates the manifest), plus an
  overlay PNG per model (the profile drawn over a side render) for eyeballing.
- `tools/models/variants.ts` + `variants.json` — builds derived models by recipe: base GLB, wingtip device (sharklet,
  737 MAX AT winglet, blended winglet, raked tip, none), nacelle scale/shift, types moved to the new id. Output GLB,
  gear/lights/paint/profile/box entries, and the GPL "modified" notice.
- `tools/livery-lab/index.html` — dev page (vite dev server): one model in one livery in Cesium without the globe, from
  fixed views (left, right, 3/4 front left/right, 3/4 rear, below, top), plus the flattened atlas and the reference
  photos. `?model=a21n&livery=WZZ&view=…`.
- `tools/livery-shots.ts` — headless Chrome (CDP, frame-capped) captures the lab's comparison sheets for a list of
  combinations into a folder.
- `tools/liveries/refs.ts` — fetches reference photos for a combination (planespotters API by hex, Wikimedia Commons
  categories) into `data/livery-refs/` (git-ignored: photos are copyrighted; only URLs and credits are committed).
- `tools/liveries/livery.workflow.js` — the saved multi-agent loop: research → design → shots → critic → fix, for
  `{code, type, model}`; run with `Workflow({scriptPath})`.
- `docs/liveries.md` — how to add a type model and an airline, step by step.

## 9. Licences

Models: GPL, derived models record "modified by FlightHopper" and their recipe (the corresponding source). Logos:
public-domain or free files from Wikimedia Commons only (user decision 2026-09-23); a text-only wordmark with no free
file is typeset in an OFL font. Photos: reference only, never committed or shipped.
