# Chase traffic: 3-D models with corner-bracket hitboxes

Approved by the user on 2026-09-23. Scope: chase mode only. Browse (the top-down map) does not change.

## What the user sees

- The app draws each other aircraft within **10 nm** of the chased aircraft as a 3-D model, to a limit of the
  **nearest 30**. The aircraft past the limit keep their flat icon. The app hides the aircraft farther than 10 nm.
- Each model points along the aircraft's track, and its pitch comes from the climb or descent angle (`targetAttitude`:
  flight-path angle + AoA). The wings stay level (roll 0), because the fleet has only the newest sample of each aircraft.
- The size comes from the ADS-B emitter category. It uses the one model file there is (`Cesium_Air.glb`, scaled so it is
  37.6 m long). Scale: A1 light 0.35, A2 small 0.6, A3 large 1, A4 B757 1.2, A5 heavy 1.8, A7 rotorcraft 0.4. Other or
  unknown categories use 1. A far model keeps a minimum on-screen size of 24 px.
- **Corner brackets:** a top-right and a bottom-left corner mark the square around each model on screen. The square is
  the projected bounding sphere of the model (at least the 24 px minimum). It grows as the model gets nearer and
  shrinks as it goes farther. The brackets are thin white lines with a soft shadow. The app hides them when the
  aircraft is behind the camera or below the horizon.
- **Hitbox:** a click in the square is a click on that aircraft. When squares overlap, the aircraft nearest to the
  camera wins. For now the app catches the click and does nothing. A later feature attaches an action to it.

## How it is built

1. **Models (`client/scene/traffic.ts`):** a pool of Cesium `Model`s, all loaded from the manifest's default GLB. Cesium's
   ResourceCache shares the geometry and textures between them. A pooled model hides when not in use. Models load
   async. Until an aircraft's model is ready, its icon stays. If the GLB fails, all traffic stays as icons.
2. **Placement:** `FleetLayer` already computes the drawn position of each aircraft (air height, or the terrain height
   under a ground aircraft, with the terrain grow and sink). It gets a per-frame set of "model hexes": the app places
   those hexes but hides their icons, and `positionOf(hex)` returns the placed position. In chase, `FleetLayer` also
   hides every aircraft that is not in range.
3. **Brackets:** one `div` per model in a layer over the canvas (`pointer-events: none`), moved each frame with a CSS
   transform. The canvas's `LEFT_CLICK` handler first tests the squares (`hitAt`), then does the icon pick as before.
4. **Time alignment:** the chased aircraft is drawn at the delayed render time (3–30 s before now). In chase, the
   app draws the fleet at the same render time. `Fleet` dead-reckons backwards along the track when the render
   time is before the newest sample (`ageS` stays ≥ 0).

## Known limits (ponytail)

- A mountain does not hide the brackets (only the horizon does). Upgrade: test the depth under the square's centre.
- The 10 nm edge has no hysteresis, so an aircraft on the edge can flip between model and hidden. Upgrade: 10.5 nm to
  leave the range.
- The app has one model file for all types. Upgrade: more GLBs per icon kind (airliner, bizjet, helicopter).

## Tests

Unit tests for the pure parts: range selection (nearest N within R, the chased aircraft excluded), the scale per
category, the square size from distance and FOV, `hitAt` (inside, outside, nearest wins), and backward dead reckoning
in `Fleet`. After that, a check in the browser against a replay, at desktop and phone width.
