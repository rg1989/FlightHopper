# Chase traffic: 3-D models with corner-bracket hitboxes

Approved by the user on 2026-09-23 and changed after the user's review in the browser (no flat icons in chase;
brackets that match the model's drawn size). Scope: chase mode only. Browse (the top-down map) does not change.

## What the user sees

- The app draws each other aircraft within **10 nm** of the chased aircraft as a 3-D model, to a limit of **30**:
  airborne first, then nearest (at a hub the nearest dozens are parked). **Chase shows no flat icons**: the app
  hides the aircraft past the limit, farther than 10 nm, or whose model has not loaded yet.
- Each model points along the aircraft's track, and its pitch comes from the climb or descent angle (`targetAttitude`:
  flight-path angle + AoA). The wings stay level (roll 0), because the fleet has only the newest sample of each aircraft.
- The size comes from the ADS-B emitter category. It uses the one model file there is (`Cesium_Air.glb`, scaled so it is
  37.6 m long). Scale: A1 light 0.35, A2 small 0.6, A3 large 1, A4 B757 1.2, A5 heavy 1.8, A7 rotorcraft 0.4. Other or
  unknown categories use 1. The app enlarges a far model to 24 CSS px itself (`minScale`). It does not use Cesium's
  `minimumPixelSize`, because that multiplies the scale in the model matrix, so the model and its brackets
  would have different sizes.
- **Corner brackets:** a top-right and a bottom-left corner mark the square around each model on screen. The square is
  centred on the model's bounding-box centre. Its side is the wingspan + 8 %, projected at the depth of the centre,
  and it is enlarged together with the model. It grows as the model gets nearer and
  shrinks as it goes farther. The brackets are thin white lines with a soft shadow. The app hides them when the
  aircraft is behind the camera.
- **Hitbox:** a click in the square is a click on that aircraft. When squares overlap, the aircraft nearest to the
  camera wins. For now the app catches the click and does nothing. A later feature attaches an action to it.

## How it is built

1. **Models (`client/scene/traffic.ts`):** a pool of Cesium `Model`s, all loaded from the manifest's default GLB. Cesium's
   ResourceCache shares the geometry and textures between them. A pooled model hides when not in use. Models load
   async. Until a model is ready, the aircraft is not drawn. If the GLB fails, chase shows no traffic.
2. **Placement:** `FleetLayer` already computes the drawn position of each aircraft (air height, or the terrain height
   under a ground aircraft, with the terrain grow and sink). In chase, it gets a per-frame set of "model hexes": the
   app places those hexes but hides their icons, and `positionOf(hex)` returns the placed position. Every other
   icon hides, except the chased aircraft's icon when it has no 3-D model.
3. **Brackets:** one `div` per model in a layer over the canvas (`pointer-events: none`), moved each frame with a CSS
   transform. The canvas's `LEFT_CLICK` handler first tests the squares (`hitAt`), then does the icon pick as before.
4. **Time alignment:** the chased aircraft is drawn at the delayed render time (3–30 s before now). In chase, the
   app draws the fleet at the same render time. `Fleet` dead-reckons backwards along the track when the render
   time is before the newest sample (`ageS` stays ≥ 0).

## Known limits (ponytail)

- Terrain, buildings and the horizon do not hide the brackets (only the camera's back does). Upgrade: test the depth
  under the square's centre.
- The 10 nm edge has no hysteresis, so an aircraft on the edge can flip between model and hidden. Upgrade: 10.5 nm to
  leave the range.
- The app has one model file for all types. Upgrade: more GLBs per icon kind (airliner, bizjet, helicopter).

## Tests

Unit tests for the pure parts: range selection (nearest N within R, the chased aircraft excluded), the scale per
category, the square size from distance and FOV, `hitAt` (inside, outside, nearest wins), and backward dead reckoning
in `Fleet`. After that, a check in the browser against a replay, at desktop and phone width.
