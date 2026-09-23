<!-- .planning/reports/sharper-chase-imagery-research.md -->
# Sharper ground in chase mode: imagery sources, Cesium settings, airport markings

Research only, no code changed. All checks were made on **2026-09-23**. Cesium facts come from the installed `cesium@1.145.0` (`@cesium/engine@26.3.0`) under `node_modules/@cesium/engine/Source/…`; line numbers refer to that tree. Web facts cite the page read. "Unverified" means exactly that. Nothing here is legal advice.

## TL;DR

- **The cause is the source data, not a Cesium setting.** At chase ranges Cesium asks for imagery at zoom 17–22. The app caps EOX at z14 (8.1 m/px at LLBG), so each texel is stretched 8× to 256× ([table below](#why-it-looks-grainy)). No render setting can put back detail the tiles don't have.
- **Best imagery for the effort: Esri World Imagery with a free ArcGIS Location Platform key.**
  - At LLBG: 0.3 m imagery (Vantor "Vivid Advanced", captured 2025-01-29), with tiles up to **z19**. Measured.
  - Price: 2M tiles/month free, then $0.15 per 1,000.
  - Cesium has a built-in provider for it.
  - The keyless `services.arcgisonline.com` endpoint is not licensed for this use.
- **To make the runway sharp at 25–300 m, draw it procedurally.** Even 0.3 m imagery is 2–8× too coarse at 25–100 m. Flight simulators solve this by drawing the paint as geometry from a few runway attributes (X-Plane, MSFS, FlightGear). OurAirports already has the inputs. ICAO and FAA give the dimensions.
- **Avoid for this app:**
  - **Bing via ion.** Cesium's guide bans "asset tracking, fleet management" with Bing and bans mixing Bing with non-Bing imagery. Access is only promised "at least through September 2026", which is now.
  - **Google 2D or 3D tiles on top of EOX or Esri.** Google's terms ban use "with or near a non-Google Map".
- **Worth setting once better imagery is in:**
  - `useBrowserRecommendedResolution: false` (or `resolutionScale`) gives crisper edges on a DPR-2 Mac. It costs about 4× the pixels but no extra tiles.
  - A larger `globe.tileCacheSize`.
  - Leave the anisotropic filtering and MSAA defaults alone; they are already on.

---

## Why it looks grainy

Cesium picks the terrain tile level from screen-space error, then picks the imagery level whose texel spacing matches that tile's geometric error:
- Screen-space error: `QuadtreePrimitive.js:1248-1273`, default max 2 px (`Globe.js:105`).
- Imagery level from geometric error: `ImageryLayer.js:794-810` (`errorRatio = 1.0`) and `getLevelWithMaximumTexelSpacing` at `:1682-1706`.
- Quantized-mesh level-0 error comes from `TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap` (quality 0.25, 65 samples, `Core/TerrainProvider.js:503-525`, `Core/CesiumTerrainProvider.js:67,210-214,1148-1152`). That gives 77,067 m, halved at each level.
- The quadtree keeps refining past the terrain's z14 by upsampling terrain, and imagery keeps loading on those deeper tiles (`GlobeSurfaceTile.js:293-296,337-382`). The imagery level is then clamped to the provider's `maximumLevel` (`ImageryLayer.js:807-810`).

**Derived estimate.** Assumptions: 1440×900 CSS-px canvas, default 60° fov across the wider axis (`Camera.js:169`), SSE 2, latitude 32°N. It is accurate to about ±1 level, because a tile's distance is measured to its nearest point.

| Ground distance from camera | Imagery zoom Cesium wants | m/px there | EOX z14 (8.1 m/px) is stretched | Esri capped at z19 (0.25 m/px) is stretched |
|---|---|---|---|---|
| 25 m | z22 | 0.03 | ×256 | ×8 |
| 100 m | z20 | 0.13 | ×64 | ×2 |
| 300 m | z19 | 0.25 | ×32 | ×1 |
| 1,000 m | z17 | 1.0 | ×8 | ×1 |
| 3,000 m | z15 | 4.1 | ×2 | ×1 |

The screen-space error is divided by `frameState.pixelRatio` (`QuadtreePrimitive.js:1271`), so this table is the same whether you render at DPR 1 or DPR 2.

---

## A. Higher-resolution imagery usable from CesiumJS

### Summary table

| Source | Resolution at LLBG | Max zoom | Key needed | Free tier, then price | Licence limits | CesiumJS class |
|---|---|---|---|---|---|---|
| **EOX Sentinel-2 cloudless 2025** (current) | 10 m | Useful to z14. The grid goes to z21, but z15–18 tiles look upsampled (inferred from shrinking file sizes). | none | free | 2018–2025 layers are CC BY-NC-SA 4.0 (non-commercial). 2016/2017 are CC BY 4.0. | `UrlTemplateImageryProvider` |
| **Esri World Imagery** (keyed) | **0.3 m** (source 0.34 m), Vantor Vivid Advanced, 2025-01-29. Stated accuracy (SRC_ACC) 8.47 m. | **z19 at LLBG.** The service declares 0–23, but z20–21 return a "no data" tile. | ArcGIS Location Platform API key | 2M tiles/month free, then $0.15 per 1,000 | Esri Master License Agreement (MLA). No bulk export or offline use. Revenue-generating apps must authenticate. | `ArcGisMapServerImageryProvider.fromBasemapType(SATELLITE,{token})` |
| **Mapbox Satellite** | 50 cm base. An Israel/Palestine update is listed for Oct 2021. LLBG zoom unverified. | z16 global, z18 regional, z21+ in select areas | Mapbox token | 750k raster tiles/month free, then $0.25 → $0.15 per 1,000 | Cache only on the end user's device, for at most 30 days. No proxying. Commercial use OK (pay as you go). | `MapboxImageryProvider({mapId:'mapbox.satellite'})` |
| **MapTiler Satellite** | 5–50 cm in "economically active" areas, 1 m in dense areas, 2 m elsewhere. Israel unverified. | z22 (tutorial uses 20) | key | Free plan: 100k requests/month, **non-commercial only**, service pauses at the cap. Flex: $30/month + $0.15 per 1,000. | No server-side cache | `UrlTemplateImageryProvider` (512 px tiles) |
| **Google 2D satellite** (Map Tiles API) | Unverified: needs a key (read `maxZoomRects` from the viewport endpoint) | 0–22 | Google Cloud key + session token (valid 2 weeks) | 100k events/month free, then $0.60 per 1,000. Default cap 15k tiles/day. | **No use "with or near a non-Google Map"**, so it cannot sit on top of EOX or Esri. No caching or prefetching. | `Google2DImageryProvider.fromUrl` (added in 1.134) |
| **Google 2D via ion** | same as above | 22 (`Google2DImageryProvider.js:70`) | ion token | 1,000 "Global Imagery" sessions/month on Community (non-commercial). Commercial plan: $149/month, 5k sessions. | Google rules plus ion rules | `Google2DImageryProvider.fromIonAssetId` (3830183 = satellite with labels; the plain-satellite ID is unverified) |
| **Bing Aerial via ion** (asset 2) | "down to 15 cm" in urban areas, 30 cm in the US and W. Europe. LLBG unverified. | unverified | ion token | same 1,000 sessions/month | **No asset tracking or fleet management. No mixing with non-Bing imagery.** Promised only "at least through September 2026". | `createWorldImageryAsync()` (`IonWorldImageryStyle.AERIAL = 2`) |
| **Google Photorealistic 3D Tiles** | Israel marked ⬤ in Google's country table. **Mesh at LLBG unverified.** | 3D | Google key, or ion asset 2275207 | Google: 1,000 root requests/month free, then $6 per 1,000 (a root request covers up to 3 h of tiles). ion: 1,000 root/month. | Non-Google-map ban applies. Credits must be shown on screen. | `createGooglePhotorealistic3DTileset` |
| **National orthophotos** | see [below](#national-open-orthophotos) | | | | | WMTS / ArcGIS / URL template |

### Sources and notes per source

**Esri World Imagery**

What I measured myself:
- **LLBG metadata.** Esri's metadata service `https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2026_r07/MapServer/identify` at 34.8867 E, 32.0094 N returns `NICE_NAME "Vivid Advanced"`, `NICE_DESC "Vantor"`, `SRC_DATE 20250129`, `SRC_RES 0.34`, `SAMP_RES 0.3`, `SRC_ACC 8.47`.
- **Tile availability** at the same point, from `services.arcgisonline.com/…/World_Imagery/MapServer/tilemap/{z}/{y}/{x}/1/1`:
  - `data:[1]` at z17, z18, z19; `data:[0]` at z20, z21.
  - Tile sizes: z17 10.5 KB, z18 7.4 KB, z19 6.2 KB. At z20 and z21 the service returns a 2.5 KB "no data" placeholder.
- **The keyed endpoint** `ibasemaps-api.arcgis.com/…/World_Imagery/MapServer?f=json` answers "499 Token Required".
- **The service description** (`…/World_Imagery/MapServer?f=json`) says 0.3 m in select metro areas, 0.5 m in the US and parts of W. Europe, 1 m elsewhere. Its copyright text is "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community".

Terms (from the research agent, URLs given):
- **Keyless use is not licensed.** Esri's ToU summary (https://www.esri.com/content/dam/arcgisonline/docs/tou_summary.pdf, April 2025) says "If you do not have Esri software, you must purchase an ArcGIS Online subscription".
- **Product terms E300** (13 Nov 2025): revenue-generating apps must authenticate (fn 89), and bulk export of basemap tiles is not allowed (fn 10). https://www.esri.com/content/dam/esrisites/en-us/media/legal/product-specific-terms-of-use/e300.pdf
- **Price:** "2M free then $0.15 per 1,000 tiles" (https://location.arcgis.com/pricing/). The page doesn't split non-commercial from commercial use.
- **Attribution:** "Powered by Esri" plus the source line (https://developers.arcgis.com/documentation/esri-and-data-attribution/interactive-maps/).

Cesium behaviour:
- **Cesium's built-in Esri token** is "provided for evaluation purposes only" (`ArcGisMapService.js:12`) and adds a warning credit.
- **`fromBasemapType` sets `maximumLevel` from the service's LOD count** (24 LODs, so 23; `ArcGisMapServerImageryProvider.js:153`). Cesium never reads the tilemap (no "tilemap" in that file). In close chase it will therefore request z20–z22 at LLBG, then drop the placeholders with its default `DiscardMissingTileImagePolicy` (`:29-38,114-125`).
  - Those are wasted requests. Whether Esri bills them is unverified.
  - Option: use a `UrlTemplateImageryProvider` on `…/tile/{z}/{y}/{x}?token=` with `maximumLevel: 19`, at the cost of losing z20+ where Esri has it elsewhere.
- **No clause found that forbids combining Esri with other imagery**, in the pages read. Unlike Google and Bing, so an Esri layer only around airports, over EOX, looks acceptable. This is not a full legal review.

**Cesium ion Community plan** (https://cesium.com/platform/cesium-ion/pricing/)
- "Personal and non-commercial use", 10 GB storage, 15 GB/month streaming.
- **Global Imagery** ("Bing Maps, Google Maps; Azure Maps as Technology Preview"): 1,000 sessions/month.
- **Google Photorealistic 3D Tiles:** 1,000 root tiles/month.
- A paid plan is required above $50K of revenue or funding.
- **Commercial plan:** $149/month (individual) or $524/month (team), 5,000 sessions.
- **What counts as a session:** one successful GET of `/v1/assets/<id>/endpoint` (https://cesium.com/learn/ion/optimizing-quotas/).
- Cesium 1.145 still ships a default ion token "for evaluation purposes only" (`Core/Ion.js:12`).

**Bing Maps retirement**
- Microsoft: "After June 30, 2025, Basic keys in Basic accounts will no longer function" (https://blogs.bing.com/maps/2025-06/Bing-Maps-for-Enterprise-Basic-Account-shutdown-June-30,2025).
- Enterprise licence holders can continue "until June 30, 2028" (https://blogs.bing.com/maps/2025-01/What-are-my-options-regarding-Bing-Maps-for-Enterprise-Retirement).
- Cesium's guide (https://cesium.com/learn/ion/content-usage-and-attribution-guide/), quoted:
  - "Bing Maps is being retired, but Cesium ion will provide access to it at least through September 2026."
  - "You may not perform asset tracking, fleet management, or routing using Bing Maps assets."
  - "You may not combine Bing Maps assets … with non-Bing imagery".
- Cesium added Google Maps 2D as the replacement, under a combined "Global Imagery" quota (https://cesium.com/blog/2025/10/02/introducing-google-maps-2d-tiles/).
- The ion Bing path already in `client/scene/imagery.ts` breaks both rules for this app: a flight tracker counts as tracking, and the app mixes imagery.

**Google Map Tiles API**
- **Terms** (https://cloud.google.com/maps-platform/terms, last modified 2026-08-26):
  - §3.2.3(b) "No Caching".
  - §3.2.3(e) "Customer will not use the Google Maps Core Services with or near a non-Google Map".
  - The ion guide says the same: "You may not combine Google Maps Platform data with a non-Google map."
- **Pricing** (https://developers.google.com/maps/billing-and-pricing/pricing, updated 2026-09-17): 2D Map Tiles is an Essentials SKU, 100,000 free events/month, then $0.60 per 1,000. Photorealistic 3D Tiles is Enterprise, 1,000 free, then $6.00 per 1,000.
- **Daily quota:** 15,000 2D tiles per day by default (https://developers.google.com/maps/documentation/tile/usage-and-billing).
- **Policies** (https://developers.google.com/maps/documentation/tile/policies):
  - Show the Google Maps logo, and don't let a third-party renderer's logo overlap it.
  - Respect `Cache-Control`.
  - No offline use.
  - 3D overlays are OK if they are not derived from Google content.
- **Hi-DPI tiles:** `createSession` supports `scale` and `highDpi` (https://developers.google.com/maps/documentation/tile/session_tokens). Cesium's `fromUrl`/`fromIonAssetId` only send `mapType`, `overlay`, `layerTypes`, `styles`, `language` and `region` (`Google2DImageryProvider.js:575-620`). To get them you would build the session yourself and use the constructor.
- **Consequence:** Google 2D would have to be the **only** base imagery, replacing EOX everywhere.
- **Photorealistic 3D Tiles** would replace the globe surface. That clashes with the app's Re:Earth terrain, its runway planes (HAE) and the EOX/Esri layers.

**Israel context**
- US-licensed commercial satellite imagery of Israel was capped at 2 m GSD until 21 Jul 2020. It is now capped at 0.4 m GSD (https://space.commerce.gov/new-limits-on-satellite-imaging-of-israel/).

**Mapbox, MapTiler, EOX**
- **Mapbox:**
  - Satellite reference: https://docs.mapbox.com/data/tilesets/reference/mapbox-satellite/
  - Pricing: https://www.mapbox.com/pricing
  - Product Terms (21 Jul 2026, via https://www.mapbox.com/legal/product-terms) §2.8.1 (device cache ≤30 days) and §2.8.3. No clause requires Mapbox GL.
  - Attribution: https://docs.mapbox.com/help/dive-deeper/attribution/
- **MapTiler:**
  - Tileset: https://docs.maptiler.com/schema-raster/satellite/
  - Pricing: https://www.maptiler.com/cloud/pricing/
  - Terms (free plan "limited to non-commercial use"): https://www.maptiler.com/terms/cloud/
  - Cesium tutorial: https://docs.maptiler.com/cesium/examples/how-to-use-cesium/
- **EOX:** licence per layer in https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml.
- **No free global source sharper than 10 m** was found. NAIP covers the US only.

### National open orthophotos

| Service | Resolution | Licence | Endpoint and class |
|---|---|---|---|
| USGS Imagery Only (US) | mostly NAIP, ~1 m | public domain, "no restrictions" (https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map) | `basemap.nationalmap.gov/…/USGSImageryOnly/MapServer`, `ArcGisMapServerImageryProvider.fromUrl` |
| IGN Géoplateforme (FR) | 20 cm (BD ORTHO) | Licence Ouverte (Etalab), commercial use OK, keyless (https://cartes.gouv.fr/cgu) | `https://data.geopf.fr/wmts`, layer `ORTHOIMAGERY.ORTHOPHOTOS`, matrix set `PM_0_19`, `WebMapTileServiceImageryProvider` |
| PDOK Luchtfoto (NL) | 8 cm (`Actueel_orthoHR`), 25 cm (`Actueel_ortho25`), up to z21 | CC-BY; exact attribution string unverified (https://www.pdok.nl/introductie/-/article/pdok-luchtfoto-rgb-open-) | `https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0`, WMTS |
| swisstopo SWISSIMAGE (CH) | 10 cm (25 cm in the Alps) | free, commercial use OK, "©swisstopo" (https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices) | `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/{Time}/3857/{z}/{x}/{y}.jpeg` |
| **Israel** | **No open tile service found** | GovMap API needs a per-domain token and no third-party tile terms were found (https://api.govmap.gov.il/docs/javascript-functions/create-map). `open.govmap.gov.il/geoserver/opendata/wms` returned 403, possibly geo-blocked, so unverified. data.gov.il has only the Survey of Israel's 2015 **2 m** aerial sheets as ZIPs; its licence allows commercial use with credit (https://data.gov.il/he/terms-of-use). | You would have to tile and host them yourself, and 2 m is coarser than Esri's 0.3 m. |

---

## B. Cesium render settings that affect sharpness (1.145 source)

| Setting | Default | Source | Effect in chase view | Cost |
|---|---|---|---|---|
| `Viewer({useBrowserRecommendedResolution})` | **true**: pixel ratio forced to 1.0, so a DPR-2 Mac renders at CSS resolution | `Widget/CesiumWidget.js:91-101,159,276-277`; default since 1.66 (`cesium/CHANGES.md:2385`) | `false` renders at the device's 2×. Edges, runway lines, labels and **minified** imagery (far ground) get crisper. Imagery that is **magnified** up close (the grainy part) gains nothing. | About 4× the pixels shaded (e.g. 1440×900 → 2880×1800). MSAA buffers scale the same way. **No extra tiles**: SSE is divided by `pixelRatio` (`QuadtreePrimitive.js:1271`). |
| `viewer.resolutionScale` | 1.0 | `CesiumWidget.js:95,755-777` | Multiplies either mode. 1.5 with the recommended resolution on gives 2.25× pixels, a middle ground. | same as above, scaled |
| `scene.globe.maximumScreenSpaceError` | **2** | `Globe.js:98-105`; used at `QuadtreePrimitive.js:734` | Halving it adds about one terrain level at a given distance, and so one imagery level (`ImageryLayer.js:799-810`). **No gain while the imagery is capped at z14.** Worth 1.5 or 1.0 only with Esri/Mapbox at 0.3–0.5 m. | About 4× tiles and requests per level added (quad tree). Billable with keyed sources. |
| `scene.msaaSamples` | **4** (WebGL2 only) | `Scene.js:253`; default since 1.121 (`CHANGES.md:715`); doc at `CesiumWidget.js:175` | Smooths **geometry** edges (runway planes, future markings, aircraft). Does nothing for texture detail. | Already paid |
| FXAA (`scene.postProcessStages.fxaa.enabled`) | **false** | `PostProcessStageCollection.js:53`; the Viewer doesn't enable it (no `fxaa` in `widgets/Source`) | Keep it off. It softens the image, and MSAA already covers the edges. | n/a |
| Imagery anisotropic filtering | **On, at the GPU maximum** (`ImageryLayer` option `maximumAnisotropy`, default "maximum supported"; doc: "Larger values make the imagery look better in horizon views") | `ImageryLayer.js:115-118`; applied in `_finalizeReprojectTexture` `:1286-1330` (`LINEAR_MIPMAP_LINEAR`, `generateMipmap(NICEST)`, `maximumAnisotropy`) for every tile (`:1363-1413`); the max comes from `EXT_texture_filter_anisotropic`, else 1 (`Renderer/Context.js:199-210`) | Already optimal. The spec takes N samples at LOD `log2(Pmax/N)`, and requires at least 2:1 support (https://registry.khronos.org/OpenGL/extensions/EXT/EXT_texture_filter_anisotropic.txt). So at grazing angles, where the footprint ratio exceeds N (e.g. 16×; this Mac's value was not measured), the ground ahead still blurs. That is geometry and cannot be fixed. | none |
| `ImageryLayer` `minificationFilter` / `magnificationFilter` | **LINEAR / LINEAR** | `ImageryLayer.js:106-113,286-304,478,486`; only NEAREST or LINEAR allowed (`:1254-1262`) | Mipmaps and anisotropy apply **only when both are LINEAR** and the tile is power-of-two (`:1290-1300`). NEAREST gives blocky pixels and shimmer at distance. Don't change. | none |
| `Globe.tileCacheSize` | **100** tiles | `Globe.js:107-116`; trimmed at `QuadtreePrimitive.js:1326` | Higher (e.g. 500–1000) keeps tiles loaded when orbiting or turning back over the airport, so detail doesn't reload. It doesn't raise the peak resolution. | GPU and CPU memory |
| `Globe.preloadAncestors` / `preloadSiblings` | true / **false** | `Globe.js:131-148` | `preloadSiblings: true` loads culled neighbours, so detail is already there when the camera swings. | More requests (billable) |
| `Globe.loadingDescendantLimit` | 20 | `Globe.js:118-129` | Higher skips intermediate levels (slower first detail, then all at once). Lower shows coarse levels sooner. Affects how it looks while flying, not final sharpness. | none |
| `scene.fog.screenSpaceErrorFactor` | 2.0 | `Fog.js:74-82`; applied at `QuadtreePrimitive.js:1264-1268` | Lowers detail on fogged tiles. Estimate from `Fog.js:141-159` and `Core/Math.js:1122-1125`: camera at 100 m looking level, ≈0.25 px SSE relief at 3 km, ≈1.5 px at 10 km. **Small effect on the runway within 3 km.** | n/a |
| `RequestScheduler` | 50 requests total, 18 per server | `Core/RequestScheduler.js:57,65,66-81` ("Useful when streaming data from a known HTTP/2 or HTTP/3 server") | Limits how fast detail catches up at 70 m/s. HTTP/2 hosts can take more via `requestsByServer`. | Server load and quota |

Sharpening is not built in. A custom `PostProcessStage` (unsharp mask) could be added, but it also amplifies JPEG noise. Untested.

---

## C. Making airports sharp over coarse imagery

### How simulators do it

The data carries only a few attributes per runway, and the renderer paints the markings:

- **X-Plane.** apt.dat 1200 (https://developer.x-plane.com/article/airport-data-apt-dat-12-00-file-format-specification/). Row 100 has: width, surface, shoulder, and per end the number, lat/lon, displaced threshold, blast pad, **marking code** (0 none, 1 visual, 2 non-precision, 3 precision, 4–7 UK/EASA), approach lights, TDZ lights and REIL. Rows 110/120 are pavement polygons and painted lines. No "1300" format spec exists; 1300 is only a row code.
- **MSFS 2024.** A runway `<Markings>` block is a set of true/false flags (threshold, touchdown, dashes, ident, precision, leadingZeroIdent, …) plus `<OffsetThreshold>`, `<BlastPad>` and `<Overrun>` (https://docs.flightsimulator.com/msfs2024/html/5_Content_Configuration/Environment/Airports_And_Facilities/Runway_XML_Properties.htm). Aprons and painted lines are placed over aerial imagery, with "Ground Merging" setting how much they blend (https://docs.flightsimulator.com/msfs2024/html/2_DevMode/Scenery_Editor/Objects/Airport_Objects.htm).
- **FlightGear.** genapts builds the markings from hard-coded tables in feet (aiming point at 1000 ft, 150 ft long; TDZ bars 75 ft in 500 ft steps) (https://github.com/FlightGear/terragear/blob/master/src/Airports/GenAirports850/runway_precision.cxx). The wiki returned 403.

### Marking dimensions

**Sources:**
- **FAA:** AC 150/5340-1M with Change 1 (12/23/2020), https://www.faa.gov/documentLibrary/media/Advisory_Circular/150-5340-1M-Chg-1-Airport-Markings.pdf. The faa.gov index returned 403. "1M is current" is based on search results.
- **ICAO:** Annex 14 Vol I, **8th ed. 2018** (https://www.iacm.gov.mz/app/uploads/2018/12/an_14_v1_Aerodromes_8ed._2018_rev.14_01.07.18.pdf). **Amendment 18** (applicable 27 Nov 2025) changes "threshold marking for paved runways", and its text was not verified.

| Marking | ICAO (Annex 14 §) | FAA (AC §) |
|---|---|---|
| Threshold stripes | start 6 m in; count by runway width 18/23/30/45/60 m → 4/6/8/12/16; each ≥30 m × ~1.8 m, gaps ~1.8 m, double gap at the centre (5.2.4.4–6) | 20 ft in; 60/75/100/150/200 ft → 4/6/8/12/16; each 150 × 5.75 ft (§2.5, Table 2-2) |
| Designator | ≥9 m tall; 12 m after the stripes; single digit gets a leading 0 (5.2.2.4, Fig 5-2/5-3) | 60 ft tall; starts 210 ft from the threshold; no leading 0 (§2.3, App. A) |
| Centreline | 30 m stripe / 20 m gap; width 0.90 m (CAT II/III), 0.45 m (CAT I and code 3–4 non-precision), 0.30 m otherwise (5.2.3.3–4) | 120 ft stripe / 80 ft gap; width 36 / 18 / 12 in (§2.4) |
| Aiming point | start 400 m in when LDA ≥2400 m (300 m for 1200–2400); 45–60 m × 6–10 m (Table 5-1) | start 1,020 ft in; 150 ft long; width and gap depend on runway width (§2.6) |
| Touchdown zone | pairs every 150 m; 6 pairs when LDA ≥2400 m; bars ≥22.5 × 3 m (5.2.6) | 75 × 6 ft bars in 3/2/1 groups every 500 ft (§2.7) |
| Side stripe | 0.9 m on runways ≥30 m wide, else 0.45 m (5.2.7) | 36 in on runways ≥100 ft wide, else 18 in (§2.8) |
| Displaced threshold | transverse bar ≥1.8 m; arrows (5.2.4.8–9) | 10 ft bar; arrows per Fig A-7 (§2.9) |
| Taxiway centreline | yellow, ≥15 cm (5.2.8.10) | 6 or 12 in (§4.2.5.1) |

**Inputs already available:**
- OurAirports `runways.csv` (https://ourairports.com/help/data-dictionary.html, public domain): `width_ft`, `surface`, `lighted`, `closed`, and per end `ident`, lat/lon, `elevation_ft`, `heading_degT`, `displaced_threshold_ft`.
- There is **no approach or marking type**, so it has to be inferred. Example: precision markings for lighted, paved runways ≥45 m wide.
- LDA can be taken as length minus the displaced threshold.

### OSM aeroway data

**Tagging**
- `aeroway=runway` / `taxiway` are **centreline ways** with `width=`. The runway ones also carry `ref` and `surface` (https://wiki.openstreetmap.org/wiki/Tag:aeroway=runway, https://wiki.openstreetmap.org/wiki/Tag:aeroway=taxiway).
- `aeroway=apron` is an area (https://wiki.openstreetmap.org/wiki/Tag:aeroway=apron).
- Outlines use `area:aeroway=runway|taxiway` (https://wiki.openstreetmap.org/wiki/Key:area:aeroway).
- `aeroway=holding_position` is a node or way.

**LLBG in OSM** (one Overpass query run 2026-09-23; OSM data as of 2026-09-22):

| Feature | Count | Notes |
|---|---|---|
| Runway ways | 6 | 3 runways plus 3 displaced-threshold segments. Widths as tagged: 03/21 60 m, 08/26 45 m, 12/30 45 m. |
| Taxiway ways | 197 | **none have `width`**, so a width has to be assumed |
| Apron areas | 14 | |
| Holding-position nodes | 35 | |
| `area:aeroway` outlines | **0** | |

**Licence**
- The data is ODbL 1.0. A rendering is a Produced Work: any licence, but it must carry "© OpenStreetMap contributors" with a link, and a corner or info button is fine (https://osmfoundation.org/wiki/Licence/Attribution_Guidelines).
- A server that ships extracted OSM geometry to clients is probably publishing a **Derivative Database**, which must stay ODbL (https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ).

**Fetching**
- overpass-api.de asks for fewer than about 10,000 queries and 1 GB per day. It discourages using the public instance as an app backend and says to run your own (https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).
- The wiki says a regular app should divide those limits by 100 (https://wiki.openstreetmap.org/wiki/Overpass_API).
- **Plan:** fetch once per airport in a build script, and ship a small ODbL JSON. Alternatively, cut aeroways from a Geofabrik extract (https://download.geofabrik.de/asia/israel-and-palestine.html).
- Query (adapted from the one that was run, which used `out tags;` and also matched stopways and threshold nodes):
  ```
  [out:json][timeout:25];
  area["icao"="LLBG"]["aeroway"="aerodrome"]->.a;
  ( way(area.a)["aeroway"~"^(runway|taxiway|apron|holding_position)$"]; way(area.a)["area:aeroway"]; );
  out geom;
  ```

### Drawing it in Cesium

| Approach | Good | Limits | Source |
|---|---|---|---|
| **Marking quads as extra geometry on the existing runway plane** (same `Primitive` + flat `PerInstanceColorAppearance` as `client/scene/runways.ts`, lifted a few cm above the 0.2 m plane) | Sharp at any range; edges get MSAA; one batched draw call; follows the plane, not the terrain | Needs a small lift. Log depth bypasses polygon offset (see the comment in `runways.ts:43-49`). Lines narrower than a pixel (0.15–0.45 m at 1–3 km) alias, so fade or widen them with distance. | `runways.ts`; `Scene.js` log depth |
| **Canvas texture on the runway plane** (`MaterialAppearance` + Image material, or `ImageMaterialProperty`, which accepts a canvas) | One quad per runway; exact paint layout from a 2D drawing | **Material textures get no mipmaps**: sampler is plain LINEAR, and only KTX2 images carry mips (`Scene/Material.js:544-558`). A long runway seen at a grazing angle will shimmer and alias. | `Material.js`; https://cesium.com/learn/cesiumjs/ref-doc/ImageMaterialProperty.html |
| **`GroundPrimitive` / Entity polygon on terrain** (aprons, taxiway `CorridorGeometry` in metres) | Drapes on terrain; `zIndex` orders ground layers when no height is set | Drapes onto **terrain and 3D Tiles only**, so it won't show on top of the lifted runway plane. Materials need `WEBGL_depth_texture`. Docs: textured GroundPrimitives are "not meant for precisely mapping textures to terrain". | `GroundPrimitive.js:35-40`; https://cesium.com/learn/cesiumjs/ref-doc/PolygonGraphics.html |
| `GroundPolylinePrimitive` | Cheap lines | **Width is in pixels**, not metres | https://cesium.com/learn/cesiumjs/ref-doc/GroundPolylineGeometry.html |
| `ClassificationPrimitive` | Colours terrain inside a volume | One colour for all instances; the geometry must be extruded | https://cesium.com/learn/cesiumjs/ref-doc/ClassificationPrimitive.html |
| **Custom `ImageryProvider` painting markings into canvas tiles** (`requestImage` may return `HTMLCanvasElement`, `ImageBitmap` or `OffscreenCanvas`, `ImageryProvider.js:8`) | Goes through the imagery path, so it **gets mipmaps and anisotropy**; drapes exactly on terrain; no z-fighting | Sharpness is limited by the imagery level Cesium picks (the table above). Rasterising many tiles costs CPU. Hidden under the lifted runway plane unless the plane goes. | `ImageryLayer.js:1286-1330` |

**Alignment caveat.** Esri gives LLBG a stated accuracy of 8.47 m (`SRC_ACC`). The OurAirports coordinates, the OSM ways and the imagery can therefore be several metres apart. Drawing a full opaque runway plus aprons hides the imagery's own runway, which avoids a visible double edge.

---

## D. Ranked recommendation (quality per effort)

1. **Esri World Imagery with an ArcGIS Location Platform key.** The biggest single gain.
   - Quality: 10 m → 0.3 m at LLBG; the ground stops being grainy from about 300 m out.
   - Effort: a few lines in `imagery.ts` plus a key in config. Also add "Powered by Esri" and the source credit.
   - Cost: free up to 2M tiles/month. Measure a typical chase session's tile count first; tiles at LLBG are 6–11 KB.
   - Licence: no non-commercial clause; authentication required.
   - To avoid z20+ placeholder requests at LLBG, use a `UrlTemplateImageryProvider` with `maximumLevel: 19`.
   - Keep EOX as the fallback, or keep it for the browse view.
   - Treat the key as public; whether it can be scoped by referrer is unverified.
2. **Procedural runway markings** (threshold bars, designators, centreline, aiming point, TDZ, side stripes, displaced-threshold arrows).
   - Effort: moderate, a pure generator from `Runway` plus ICAO/FAA tables. Unit-testable like `runwayCorners`.
   - Cost: none, no keys, works at every OurAirports airport, negligible FPS impact (one batched `Primitive`).
   - Quality: the only thing that stays sharp at 25–100 m, where even Esri is stretched 2–8×.
   - Build it as geometry, not a canvas texture (no mipmaps).
3. **Render tweaks, once item 1 is in.**
   - `useBrowserRecommendedResolution: false`, or `resolutionScale` 1.5 as a middle ground. Costs about 4× (or 2.25×) the fragments, with no extra tiles.
   - `globe.tileCacheSize` about 500–1000.
   - Optionally `globe.maximumScreenSpaceError` 1.5. This adds billable tiles.
   - Leave MSAA 4, FXAA off, and the LINEAR filters and anisotropy as they are.
   - Before item 1, only the DPR change is visible (sharper edges and labels).
4. **OSM aprons and taxiways as flat geometry.**
   - Quality: crisp pavement edges around the runway.
   - Effort: medium. Build-time Overpass or Geofabrik extraction, assumed taxiway widths (none tagged at LLBG), ODbL attribution.
   - Taxiway pieces must use the same "plane" approach as the runways, or drape on terrain as `GroundPrimitive`s, depending on how M4 settles the terrain vs plane question.
5. **Mapbox Satellite** as the alternative to Esri.
   - 50 cm in Israel since 2021; 750k free tiles/month; commercial use OK when paying.
   - The LLBG maximum zoom is unverified. Try it if Esri's look or terms don't suit.
6. **Not recommended now:**
   - **Google 2D.** Cannot be mixed with other imagery, so it would have to be the only base layer. 15k tiles/day default quota. LLBG zoom unverified.
   - **Google Photorealistic 3D Tiles.** Replaces the globe and conflicts with the HAE terrain and runway planes. LLBG mesh unverified. $6 per 1,000 roots after 1,000.
   - **Bing via ion.** Bans tracking use and mixing, and is being retired.
   - **MapTiler free.** Non-commercial only, 100k requests/month, pauses at the cap.
   - **Israeli open data.** 2 m, self-hosted.

---

## Addendum: after implementation (2026-09-23)

The Esri recommendation is implemented in `f2c2a35` (Esri imagery when `VITE_ARCGIS_KEY` is set) and `15280e7` (imagery badge, and EOX when Esri fails). Measured on the keyed endpoint `ibasemaps-api.arcgis.com/…/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=` with a real ArcGIS Location Platform key:

- **Past Esri's coverage the keyed endpoint answers HTTP 404.** It sends no "no data" placeholder tile, unlike the keyless `services.arcgisonline.com` endpoint described above. Cesium then keeps drawing the parent tile, so no `DiscardMissingTileImagePolicy` is needed.
- **It serves tiles for any non-empty token, even a made-up one**, including tiles nobody requested before. A wrong key alone therefore does not fail.
- **A missing token gets HTTP 200** with the body `{"error":{"code":499,"message":"Token Required."}}`. Cesium reports this as an undecodable image with no status code.
- **The new key was not locked to a referrer.** Restrict it to the app's domain before a public deploy.
- **The PoC's frame times** under load average 15–120 were discarded. Only the first, lightly loaded run is quoted in the report artifact: https://claude.ai/artifact/Jhy7hrfKnfPEJCr9igzKVt
