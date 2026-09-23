## FlightHopper b744 model and livery: what a JAL 123 scenario needs

Coordinates below are **raw GLB** (livetaiwan convention: +X right wing, +Y up, −Z nose; README.md:73). The livery shader works in a **turned frame** `p = raw·(−1, 1, −1)`, so nose is +Z and +X is the left wing (livery.ts:59-60, `noseMinusZ` manifest.json:192, frame doc types.ts:52). Measurement scripts are in `<scratch>` (`slice.mjs`, `wing.mjs`, `low.mjs`, `fin.mjs`, `hump.mjs`, `color.mjs`).

### Measured geometry of b744.glb

| Item | Value |
|---|---|
| Structure | 1 node, 1 mesh, 1 primitive, 3331 verts / 3140 tris; POSITION, NORMAL, COLOR_0; **no TEXCOORD**; material `hull`, `doubleSided: false` |
| BBox | x ±32.71, y −9.71…8.67, z −35.48…35.48 (span 65.42 m, length 70.95 m) |
| Fuselage | belly y ≈ −8.6, main crown y ≈ −1.45, widest half-width 3.24 at y −5.5…−6.0 |
| COLOR_0 luminance | 0.55–1.0, so the `detail` term (livery.ts:62-63) is always 1. There are no windows on this model |

### 1. Livery shader: inputs, regions and what JAL 1985 needs

**Inputs.**
- `LiveryEntry {base, belly?, fin, fin2?, engine?, title?, finLogo?}` (livery.ts:10-18), resolved by `liveryOf(code)`. Missing fields take defaults (livery.ts:34-38).
- The uniforms are `u_base`, `u_belly`, `u_fin`, `u_fin2`, `u_engine` (VEC3) and `u_finLogo`, `u_title` (SAMPLER_2D) (livery.ts:120-128).
- Geometry constants are baked into the GLSL text from the model's `Paint` (types.ts:56-65) by `paintShaderText(p)` (livery.ts:47-79).
- The vertex shader is a constant that only passes `v_nMC` (livery.ts:81).

**Regions**, all in the turned frame:
- **body:** `|x| < bodyHalfWidth`. Below the single horizontal plane `y < bellyBelowY` it takes `u_belly`, otherwise `u_base` (livery.ts:64, 68).
- **fin:** `z < behindZ && y > aboveY && |x| < halfWidth`. A slanted line splits it into fin and fin2 (livery.ts:65, 72).
- **engines:** an |x|/z box with `|n.y| < 0.8` (livery.ts:66).
- **everything else:** constant grey (livery.ts:67).

**Decals** use `decal()`, a side projection along x that is mirrored on one side so it reads nose to tail (livery.ts:53-56). Decals are gated by `|n.x| > 0.3` (livery.ts:70):
- a square fin logo at `paint.finLogo` (livery.ts:73);
- a 4:1 title on the body at `paint.title` (livery.ts:75).

For b744 these are fin logo `[-29.22, 4.66, 4.91]` and title `[14.19, -3.18, 15.61]` (manifest.json:193-194). Decal files are `public/liveries/<code>-title.png` (1024×256) and `<code>-fin.png` (512×512), and their URL comes from the code (livery.ts:117). The test requires a `logos` source entry for each decal and requires the folder to hold exactly the wanted set (livery.test.ts:33-42).

**What it can do today for JAL 1985:**
- White top: `base`.
- Grey lower fuselage: `belly`. The split line is fixed per model (−5.99, manifest.json:192) and is not a livery setting.
- "JAPAN AIR LINES" titles: `title: true`.
- Crane on a white fin: `fin: '#f7f7f7', finLogo: true`.
- **Cheatline stripes: not possible.** The body has one horizontal threshold and no bands.

**Changes needed, cleanest first:**
- **(a) Body-wrap decal.** Add a `u_body` sampler projected with the existing `decal()` over the whole fuselage side, for example 2048×512 over z −35.5…35.5 and y −8.6…−1.4. One PNG then carries the stripes, any nose sweep, the grey lower half and even window dots, so the stripe order and colours come from a reference photo and not from code. A band at constant y on a near-cylindrical body stays straight. This needs:
  - a new Paint field for the body box;
  - one more `TextureUniform`;
  - about 3 lines of GLSL in the `body && side` branch.
- **(b) Procedural bands.** Up to N `vec4` uniforms `(y0, y1, zFront, zBack)` plus N colours. Band y comes from a per-model `windowY + slope·(z − zRef)`, in the same form as `finSplit`. CustomShader has no uniform arrays, so N is fixed.

There is no window geometry or texture (README.md:72), so pick the window height by eye. The upper lobe narrows above y ≈ −3.5 (half-width 2.95), so start the bands around y ≈ −4.5 and tune against a photo.

### 2. Making the scenario use a specific model and livery

Today both come from the chased aircraft's info every frame (app.ts:597-599):
- `model.use(pick.for(typeCode, category))`
- `model.paint(liveryCode(callsign))`

`liveryCode` returns `operatorOf(callsign)` or its alias, and only if that code is in the table (livery.ts:27-32). Adding a `"JAL"` entry would therefore repaint every modern JAL flight.

**Model.** Resolve the entry by id, for example `pick.models.find(m => m.id === 'b744')` (modelFor.ts:32-34), or add `byId(id)`. The type code route also works: `'B74R'` (I believe that is the 747SR designator) or any `B74*` code matches the `"B74*"` prefix (manifest.json:189, modelFor.ts:39). `use()` compares entries by object identity and returns false until the GLB has loaded (model.ts:193, 205-206). The scenario should call `use()` until it returns true, or await `loadChaseModel`, before playback starts.

**Livery.** Use a key that can never be an operator, such as `"JAL1985"` (`operatorOf` only returns a 3-character prefix, shared/airlines.ts:22-25).
- Simple route: put it in liveries.json with `JAL1985-title.png`, `JAL1985-fin.png` and `logos` sources.
- Package route, better for a reusable scenario format: add `LiveryShaders.custom(key, livery: Livery & {titleUrl?, finUrl?, bodyUrl?})` so the scenario folder carries its own decals.

**Frame loop change.** In scenario mode, call `model.use(scn.entry)` and `model.paint(scn.liveryKey)` in place of lines 598-599, and give Traffic an empty entries list so no traffic is drawn (traffic.ts:160-189).

### 3. Hiding the upper fin and rudder from 18:24:35

The dossier says the vertical stabilizer and lower rudder separated at 18:24:35 (JAL123_simulator_scenario.md:53).

**Measured fin** (raw, above the crown y > −1.3, |x| < 0.6):

| | Root (y ≈ −1.2) | Tip (y 8.5–8.67) |
|---|---|---|
| Leading edge z | 18.8 | 31.1 |
| Trailing edge z | 32.3 | 35.4 |
| Half-thickness | 0.57 | 0.13 |

- Leading-edge sweep is dz/dy ≈ 1.27 and trailing edge ≈ 0.31. The fin stands 10 m above the crown.
- Only 24 vertices lie above the crown (x −0.12…0.10). The fin is a few long triangles, so a vertex-shader cut is impossible; it has to be done per fragment.
- The tail cone ends at z 33.0. The tailplane sits at y ≤ −1.95 (x 4–10, z 25.5–34.3), so a `y > −1.3` test never touches it.

**Recommended: a uniform-gated `discard` in `fragmentMain`**, in the turned frame (z negated):
```glsl
// u_cut: x = on, y = keep height above crown (m), z = rudder chord fraction, w = jag amplitude
if (u_cut.x > 0.5 && p.y > -1.3 && abs(p.x) < 0.8 && p.z < -18.0) {
  float h = p.y + 1.4;
  float le = -18.8 - 1.27*h, te = -32.3 - 0.31*h;
  bool top = h > u_cut.y + u_cut.w*sin(p.z*5.3)*sin(p.z*2.1);
  bool rudder = p.z < te + u_cut.z*(le - te) * -1.0 + (le - te);   // aft u_cut.z of local chord
  if (top || rudder) discard;
}
```
- Declare `u_cut: {type: VEC4}` in `#make` (livery.ts:118-128). Each frame, set it with `shader.setUniform('u_cut', …)` from the scenario clock (`CustomShader.setUniform`, Cesium CustomShader.js:413). Scrubbing back before 18:24:35 turns it off.
- The logo decal at y ≈ 4.7 disappears with the fin, which is correct.
- Take the stub height and the rudder fraction from the report's damage figure. The dossier text does not give them.

**What the cut looks like.**
- The material is single-sided and back faces are culled (Model.js:1582-1592), so the stub is two open skins. The gap is at most about 1.1 m wide, and through it you see the far side (sky or ground) or the fuselage crown. At chase distance it reads as a clean cut.
- For a torn, hollow look, set `model.backFaceCulling = false` on the scenario model and use `if (czm_backFacing()) material.diffuse = vec3(0.04)` (Builtin backFacing.glsl). Normals are not flipped for back faces without a double-sided material (MaterialStageFS.glsl:83-84), but the dark colour hides that.
- Risk: decimation cracks elsewhere in the mesh would show up as dark slivers.
- Restore the setting on exit, because ChaseModel reuses one `Model` per entry id (model.ts:168, 205-213).

**Alternatives:**
- **`ClippingPlaneCollection`** with the default `unionClippingRegions=false` (ClippingPlaneCollection.js:40-41). It gives only one straight cut, but `edgeColor`/`edgeWidth` add a rim for free. The planes are relative to `modelMatrix` (Model.js:2651-2684), so they must be given in Cesium's model frame (glTF +Y becomes +Z and +Z becomes +X, model.ts:11-16).
- **Rebuild the GLB with fin and rudder as separate nodes.** The upstream `b744.blend` has separate objects `vstab`, `rudder`…`rudder.005` and `hstab`, but `bl_join_blend.py:11-19` joins all meshes. With separate nodes, `model.getNode('rudder').show = false` (Model.js:1877) hides them. This needs Blender, which is not installed, plus a GPL-sourced build step.

### 4. Landing gear

**There is no gear in the GLB.**
- Nothing within |x| < 9 lies below the belly (y −8.67).
- The lowest vertex, y −9.71, is the **inboard engine nacelle** (x ±12…16, z −10…−3). The outboard nacelle reaches −9.17.
- So `gearHeightM: 9.71` (manifest.json:188) measures origin to nacelle bottom, and `modelMatrixFor` adds it (model.ts:126). This does not matter in the air.

The upstream blend has gear-door objects (`nlg_*door*`, `wlg_*door*`) but no wheel, strut or bogie objects, so gear cannot be recovered from the source either. Options for the gravity extension at 18:39:32 (JAL123_simulator_scenario.md:62):
1. **Recommended: a small separate `b744-gear.glb`** (boxes and cylinders, a few hundred triangles) in the same raw frame. Draw it as a second `Model` that copies the chase model's matrix every frame (after `ChaseModel.update`, model.ts:225-229), with `show = t ≥ 18:39:32`. Placement:
   - belly at y −8.6;
   - nose gear near z ≈ −28;
   - four main legs around z ≈ −2…+3, at x ≈ ±1.9 (body gear) and ±5.5 (wing gear).

   These positions come from public 747 dimensions (wheelbase about 25.6 m, main track about 11 m) and are approximate.
2. Cesium primitive geometry: more code and no benefit.
3. Import gear from the full FGMEMBERS 747-400 (GPL, animated): a heavy conversion that needs Blender.

### 5. Winglets and upper deck: can the model pass for a 747SR?

**Winglets are present but small** after decimation.
- The wing tip plane sits at y ≈ −4.25 at x = 32 (chord z 11.0–14.7).
- The winglet rises from x 32.0 to 32.71 and from y −4.3 to −2.52 (1.7–1.9 m tall) at z 14.0–15.8. Only 30 vertices have |x| > 30.5.
- The span is 65.42 m against about 59.6 m for a 747-100/SR, so each tip needs to come in about 2.9 m, to |x| ≈ 29.8. At x = 30 the wing measures y −4.72…−4.33, z 9.3…13.5.

**Vertex collapse works well here.** In `vertexMain`, for |x| > 29.8 set `x = sign·29.8` and `y = min(y, −4.3)`. The winglet and tip extension fold into a closed, degenerate tip with no holes; normals stay the originals, which makes no visible difference. This works because Cesium assigns the modified `vsOutput.positionMC` back to the attributes before the geometry stage (CustomShaderStageVS.glsl:17-18, GeometryStageVS.glsl:6-7). As a result, the fragment shader's paint regions see the deformed positions too. It needs a per-model vertex shader text in place of the shared `VERTEX` (livery.ts:81). Confidence: high.

**Upper deck: only a rough approximation is possible.**
- The hump crown at x = 0 is y ≈ −0.6 from z −26 to −13, then slopes to the main crown (−1.45) by z ≈ −4. It is only about 0.9 m higher than the main crown and narrow (half-width 1.25 at y −1.0).
- There are only 18 vertices above y −1.3 in the hump, in rings at z −30, −29, −25, −19 and −14.
- The 747-400's stretched upper deck is about 7.1 m longer than the SR's. Clamping `y ≤ mainCrownProfile(|x|)` for z > −16 (profile at z = +5: −1.45, −1.49, −1.71, −1.90, −2.21 at |x| = 0, 0.8, 1.2, 1.6, 2.0) makes the hump slope down from the −19 ring to the −14 ring. That is roughly 6–10 m shorter; the mesh cannot land exactly on 7.1 m.

**Honest assessment.** Fuselage length already matches (70.95 m against about 70.6 m). The winglet and span fix is clean. The hump change is subtle at chase distance and needs a visual check. Engine nacelle shapes (JT9D on the real aircraft) stay those of the -400.