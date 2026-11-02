# MARSHGO — TRANSPORT FEED AUDIT

**Generated:** 2026-10-31T16:30:05.999Z
**Generator:** `scripts/build-transport-registry.ts` (re-run: `npx tsx scripts/build-transport-registry.ts --probe <json>`)
**Product status:** NOT_RELEASED
**Evidence rule:** a row says VERIFIED only when this run measured it. NOT_MEASURED = no evidence collected, not "does not exist".

## 1. Headline numbers

| Metric | Value |
|---|---|
| Catalog rows (canonical server repo) | 52 |
| Rows probed today | 52 |
| HEALTHY | 24 |
| DEGRADED | 4 |
| OFFLINE | 19 |
| SKIPPED (needs credentials / insecure endpoint) | 5 |
| Routable in planner today | 28 |
| Feeds with live vehicle positions | 14 |
| Feeds with arrival predictions (trip updates) | 0 |
| Feeds with service alerts | 0 |
| Feeds with verified pricing | 0 |
| Feeds with reservation/booking | 0 |

## 2. Per-feed results (measured 2026-10-31T16:16:52.866Z)

| Feed | City | Type | State | Latency | Measured | Static network | Live positions | Arrival predictions | First failing check |
|---|---|---|---|---|---|---|---|---|---|
| Львівавтодор — розклад (GTFS) | Львів | gtfs | HEALTHY | 2287 ms | stops=1071, routes=72, trips=15716, stopTimes=426685 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Львівавтодор — realtime позиції (GTFS-RT) | Львів | gtfs_rt | HEALTHY | 245 ms | vehicles=443, tripUpdates=0, alerts=0, ageSeconds=19 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Львівавтодор — затримки (GTFS-RT) | Львів | gtfs_rt | OFFLINE | 293 ms | — | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | Valid GTFS-Realtime protobuf |
| Стрийська міська рада — розклад (GTFS) | Стрий | gtfs | HEALTHY | 586 ms | stops=295, routes=34, trips=1061, stopTimes=13874 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Ужгородська міська рада — розклад (GTFS) | Ужгород | gtfs | HEALTHY | 286 ms | stops=217, routes=18, trips=2376, stopTimes=46460 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| inbus.ua — розклад (GTFS) | Україна | gtfs | OFFLINE | 362 ms | stops=2, routes=1, trips=45, stopTimes=90 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Scheduled service in next 7 days: no active trip service in the next 7 days |
| Zelectra — е-самокати (GBFS 3.0) | Київ | gbfs | DEGRADED | 272 ms | discoveryHttp=200, feeds=9, vehicles=1048, stations=0 | NOT_APPLICABLE | VERIFIED_LIVE | NOT_APPLICABLE | Positions are in Ukraine: bbox -77.06, -12.05, 37.30, 50.47 |
| Київ — розклад (GTFS) | Київ | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — realtime (GTFS-RT) | Київ | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | — |
| Одеса — розклад (GTFS) | Одеса | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | — |
| КП «Бучатранссервіс» — розклад (GTFS) | Буча | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Рівне — розклад (GTFS, Dozor) | Рівне | gtfs | HEALTHY | 1286 ms | stops=211, routes=21, trips=2420, stopTimes=40909 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Рівне — позиції (GTFS-RT, Dozor) | Рівне | gtfs_rt | HEALTHY | 538 ms | vehicles=47, tripUpdates=0, alerts=0, ageSeconds=2 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Івано-Франківськ — розклад (GTFS, Dozor) | Івано-Франківськ | gtfs | HEALTHY | 707 ms | stops=522, routes=50, trips=2829, stopTimes=68227 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Івано-Франківськ — позиції (GTFS-RT, Dozor) | Івано-Франківськ | gtfs_rt | HEALTHY | 21 ms | vehicles=96, tripUpdates=0, alerts=0, ageSeconds=13 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Ужгород — позиції (GTFS-RT, Dozor) | Ужгород | gtfs_rt | HEALTHY | 23 ms | vehicles=30, tripUpdates=0, alerts=0, ageSeconds=2 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Ужгород — розклад (GTFS, Dozor) | Ужгород | gtfs | HEALTHY | 519 ms | stops=163, routes=15, trips=1274, stopTimes=22602 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Стрий — позиції (GTFS-RT) | Стрий | gtfs_rt | HEALTHY | 35 ms | vehicles=21, tripUpdates=0, alerts=0, ageSeconds=14 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Трускавець — позиції (GTFS-RT) | Трускавець | gtfs_rt | DEGRADED | 40 ms | vehicles=0, tripUpdates=0, alerts=0, ageSeconds=21 | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | Entities: 0 vehicles, 0 trip updates, 0 alerts |
| Чорноморськ — розклад (GTFS) | Чорноморськ | gtfs | OFFLINE | 443 ms | stops=152, routes=6, trips=16, stopTimes=406 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Scheduled service in next 7 days: no active trip service in the next 7 days |
| Червоноград — позиції (EasyWay JSON) | Червоноград | json | HEALTHY | 222 ms | vehicles=11, vehicles_marshrutka=6, vehicles_bus=5, ageSeconds=18 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Конотоп — позиції (EasyWay JSON) | Конотоп | json | DEGRADED | 50 ms | — | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | Vehicle list found: 0 entries |
| Ужгород — позиції (Dozor JSON) | Ужгород | json | HEALTHY | 99 ms | vehicles=71, vehicles_bus=71 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Івано-Франківськ — позиції (Dozor JSON) | Івано-Франківськ | json | HEALTHY | 113 ms | vehicles=126, vehicles_trolleybus=22, vehicles_bus=104 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Дніпро — позиції (iCity JSON) | Дніпро | json | DEGRADED | 1364 ms | vehicles=32, vehicles_bus=32, ageSeconds=1 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Coordinates: 32 valid, 384 invalid |
| Суми — позиції (GTFS-RT) | Суми | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | — |
| Полтава — позиції (EasyWay JSON) | Полтава | json | HEALTHY | 85 ms | vehicles=177, vehicles_marshrutka=124, vehicles_bus=29, vehicles_trolleybus=24 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| VD-Express — міжміські автобуси (GTFS) | Україна | gtfs | HEALTHY | 785 ms | stops=37, routes=2, trips=2, stopTimes=72 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Укрзалізниця — розклад поїздів (GTFS) | Україна | gtfs | HEALTHY | 5092 ms | stops=167, routes=125, trips=125, stopTimes=1345 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київпастранс — розклад (GTFS) | Київ | gtfs | HEALTHY | 1337 ms | stops=1535, routes=166, trips=24310, stopTimes=103533 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Кам’янець-Подільський — розклад (GTFS, Dozor) | Кам’янець-Подільський | gtfs | HEALTHY | 721 ms | stops=224, routes=11, trips=2256, stopTimes=52144 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Кам’янець-Подільський — позиції (Dozor JSON) | Кам’янець-Подільський | json | HEALTHY | 110 ms | vehicles=138, vehicles_bus=138 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Біла Церква — розклад (GTFS, Dozor) | Біла Церква | gtfs | HEALTHY | 64 ms | stops=342, routes=18, trips=189, stopTimes=5451 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Біла Церква — позиції (Dozor JSON) | Біла Церква | json | HEALTHY | 116 ms | vehicles=128, vehicles_bus=128 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Хмельницький — розклад (GTFS, Dozor) | Хмельницький | gtfs | OFFLINE | 45 ms | stops=0, routes=0, trips=0, stopTimes=0 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Stops: 0 stops, 0 with invalid coordinates |
| Олександрія — розклад (GTFS, Dozor) | Олександрія | gtfs | HEALTHY | 88 ms | stops=204, routes=14, trips=189, stopTimes=3919 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Олександрія — позиції (Dozor JSON) | Олександрія | json | HEALTHY | 21 ms | vehicles=11, vehicles_bus=11 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Київ — міська електричка (розклад) | Київ | rest | OFFLINE | 19911 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — метро (перший/останній поїзд) | Київ | rest | OFFLINE | 19686 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — метро (інтервали руху) | Київ | rest | OFFLINE | 19675 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — метро (пересадкові вузли) | Київ | rest | OFFLINE | 19378 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — метро (години роботи станцій) | Київ | rest | OFFLINE | 19538 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — фунікулер (перший/останній рейс) | Київ | rest | OFFLINE | 19894 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — фунікулер (інтервали руху) | Київ | rest | OFFLINE | 19661 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — фунікулер (години роботи станцій) | Київ | rest | OFFLINE | 19589 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — маршрутки (офіційна геометрія) | Київ | geojson | OFFLINE | 15357 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: The operation was aborted due to timeout |
| Київ — метро (геометрія ліній) | Київ | geojson | OFFLINE | 15135 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: The operation was aborted due to timeout |
| Київ — метро (станції) | Київ | geojson | OFFLINE | 15240 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: The operation was aborted due to timeout |
| Київ — міська електричка (геометрія) | Київ | geojson | OFFLINE | 15146 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: The operation was aborted due to timeout |
| Київ — фунікулер (геометрія) | Київ | geojson | OFFLINE | 15139 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: The operation was aborted due to timeout |
| Київ — фунікулер (станції) | Київ | geojson | OFFLINE | 15239 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: The operation was aborted due to timeout |
| Київ — міська електричка (станції) | Київ | geojson | OFFLINE | 15186 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: The operation was aborted due to timeout |

## 3. Ingestion adapters actually present in code

| Format | Adapter | Implemented |
|---|---|---|
| GTFS (ZIP) | server/mobility/gtfs.ts + server/journey/gtfsTimetable.ts | yes |
| GTFS-Realtime (protobuf) | server/mobility/gtfsRealtime.ts | yes |
| GBFS v2/v3 (vehicle rental/geofences) | server/mobility/gbfs.ts, gbfsGeofences.ts, micromobilityFeatures.ts | yes |
| JSON vehicle lists | server/mobility/jsonVehicles.ts | yes |
| GeoJSON geometry | server/mobility/transportLayers.ts (sourceType geojson) | yes |
| REST table (ArcGIS/CKAN) | server/mobility/kyivSchedule.ts, kyivMetroTimetable.ts | yes |
| TSV price catalog | server/mobility/kiwitaxiTsv.ts | yes |
| CSV (generic) | none | **no** |
| XML | none | **no** |
| SIRI / SIRI-2 | none | **no** |
| NeTEx | none | **no** |
| GTFS-RT Trip Updates persistence | parse only (probe counts entities; no store) | **no** |
| GTFS-RT Service Alerts persistence | parse only (probe counts entities; no store) | **no** |

## 4. Acceptance database (SELECT-only, 2026-10-31T16:24:00Z)

| Table / grouping | Count |
|---|---|
| mobility_providers | 52 |
| — ENABLED | 15 |
| — TEMPORARILY_UNAVAILABLE | 27 |
| — DISCOVERED | 10 |
| ENABLED gtfs / gtfs_rt / json | 7 / 1 / 7 |
| mobility_operators | 7 |
| mobility_networks | 4 |
| rental_locations (bike/scooter station inventory) | 0 |
| rental_availability_snapshots | 0 |
| provider_source_records (per-source ingest ledger) | 0 |
| vehicles (carpool fleet, not GTFS-RT positions) | 14 |

## 5. Partner/operator registry (`server/mobility/providerRegistry.ts`)

| Operator | Group | Data source | Integration status | Enabled | Booking | Pricing |
|---|---|---|---|---|---|---|
| Kiwitaxi | TRANSFER | CSV | AWAITING_CREDENTIALS | no | UNKNOWN | UNKNOWN |
| Intui.travel | TRANSFER | PARTNER_API | AWAITING_CREDENTIALS | no | PARTNER_API | UNKNOWN |
| Zelectra | SCOOTER | GBFS | ACTIVE_LIVE | yes | DEEPLINK | CATALOG |
| Nextbike | BICYCLE | OSM | ACTIVE_STATIC | yes | UNKNOWN | UNKNOWN |
| BikeNow | BICYCLE | PARTNER_API | AWAITING_AGREEMENT | no | UNKNOWN | UNKNOWN |
| Veliki.ua | BICYCLE | MANUAL | ACTIVE_STATIC | yes | UNKNOWN | UNKNOWN |
| Непідтверджений велопрокат | BICYCLE | OSM | ACTIVE_STATIC | yes | UNKNOWN | UNKNOWN |

## 6. Defects found by this audit

1. **Two divergent catalogs.** Canonical `MarshGO-Server/server/mobility/ukraineCatalog.ts` has 52 rows; the legacy root copy has 43 (a strict subset). The read-only probe tool only exists in the root repo, so `npm run acceptance:transport-feeds` certifies 43 rows and silently misses 9 canonical ones (Zelectra GBFS + 8 Kyiv REST tables).
2. **Kyiv city open data is down as a source.** All 15 Kyiv portal rows (7 GeoJSON + 8 REST) returned timeouts / HTTP 522 from `data.kyivcity.gov.ua` and `gisserver.kyivcity.gov.ua` today. Metro, funicular, city express and Kyiv marshrutka geometry therefore have no working provider feed right now.
3. **No arrival predictions anywhere.** Every GTFS-RT feed measured `tripUpdates=0` and `alerts=0`. The planner can show scheduled times and live positions, but "next tram in 4 min" and service alerts are not provider-backed in any Ukrainian feed in this registry.
4. **Lviv trip_updates feed is broken upstream.** `https://track.ua-gis.com/gtfs/lviv/trip_updates` returned a payload that failed protobuf validation.
5. **Micromobility has no persisted supply.** `rental_locations` and `rental_availability_snapshots` are both 0, and `provider_source_records` (the ingest ledger) is empty. Bicycle legs cannot be produced from real inventory; scooter legs are geofence-estimate only.
6. **Zelectra GBFS mixes non-Ukrainian vehicles.** Discovery answers in 272 ms, but the probed bbox reaches -77.06 / -12.05 (Lima). Coverage checks reject out-of-country points, so the "ACTIVE_LIVE" operator status must be read as "feed reachable", not "Kyiv supply verified".
7. **Dnipro iCity feed has dirty coordinates.** 32 valid positions vs 384 rejected — needs a boundary check before display.
8. **Stale/dead rows still registered.** Chornomorsk GTFS is a 2019 archive with no service in the next 7 days; inbus.ua resolves to 2 stops / 1 route; Khmelnytskyi Dozor static zip is empty (0 stops, 0 routes).
9. **Declared lifecycle is not enforced.** `shared/mobility/interfaces.ts` defines HEALTHY/DEGRADED/STALE/OFFLINE/NOT_CONFIGURED, but the map layer only derives LIVE/STALE/OLD/UNKNOWN from position age, and `discovery_status` vs `status` are separate columns consumed by different queries.

## 7. Addendum — LIVE-VEHICLES-1, public HTTPS chain measured 2026-10-31T16:33Z

All requests went to the live public tunnel `https://marshgo-dima.shares.zrok.io` (zrok → nginx :8080 → acceptance API :3902), after a real `POST /api/v1/auth/register` (201) and `POST /api/v1/auth/login` (200) with a throwaway account. No fixture and no localhost-only call was used for these numbers.

| Query (`/api/v1/transport/vehicles`, Bearer auth) | Result |
|---|---|
| `bbox=23.93,49.77,24.12,49.92&types=bus,trolleybus,tram` (Lviv core) | HTTP 200 in 4.04 s, **391 features**, `{bus:338, tram:53}`, `meta {failedProviders:0, filteredStaleVehicles:82}`, position ages min 7 s / median 18 s / max 84 s |
| `bbox=23.85,49.75,24.16,49.98&types=tram` | 55 features, all typed `tram`, **0 leaked**, `failedProviders:1` |
| `bbox=23.85,49.75,24.16,49.98&types=trolleybus` | **406 features, every one typed `other`**, 67 distinct route labels, `filteredStaleVehicles:85` |

Sample feature (Lviv): `{"transport":"bus","route":"Тр22","lon":23.9862,"lat":49.8049,"bearing":112,"speed":1.94444,"updatedAt":"2026-10-31T16:33:08.000Z"}` — coordinates, heading and speed are plausible for Lviv, so real GTFS-RT positions do reach the client over the public domain.

### Confirmed end-to-end
Real provider → fresh timestamp filter → bbox filter → GeoJSON → public HTTPS → authenticated client: **works for positions**. The client map derives `LIVE ≤30 s / STALE ≤90 s` from `updatedAt` ([src/views/TransportMapView.tsx:103-110](../src/views/TransportMapView.tsx)), so a median 18 s age renders as LIVE.

### New defects (10–12)

10. **The vehicle category was derived from the request, and the filter then admitted whatever it could not classify.** `/api/v1/transport/vehicles` built the route-name map from `loadRoutes(box, types)` — i.e. only from the static feeds matching the *requested* types — decoded positions against it, and admitted a vehicle when `vehicle.type === 'other' || types.includes(vehicle.type)`. Consequences measured on the public URL: `types=trolleybus` produced **406 features, every one typed `other`** (Lviv buses and trams became unclassifiable because their static feed was not loaded for that request), and `types=bus` returned **406 features of which 55 were typed `tram`**, while `types=bus,trolleybus,tram,marshrutka` returned 351 bus only. The 10-second vehicle cache was keyed by `providerId` alone, so a decoded array (with types resolved for one request) was reused by a different request inside the window. Fix: strict category matching, an explicit `other` token in `types`, a new `meta.unclassifiedVehicles` counter, and a cache key that includes the requested category set. Regression test: `tests/transport-vehicle-type-filter.test.ts`.
11. **Lviv static data labels trolleybus routes as buses.** 95 of 391 vehicles typed `bus` carry trolleybus-style route names (`Тр22`, `Тр32`, `Т03`, `Т09`). The category comes from the static feed's `route_type`, so this is upstream data, not MARSHGO decoding; measured in the same request. Consequence: the map's trolleybus layer cannot be credited to Lviv from this feed, and the coverage matrix keeps Львів trolleybus as unverified. Poltava, by contrast, resolved `marshrutka` 49 / `trolleybus` 20 / `bus` 15 correctly in one request.
12. **`failedProviders:1` noise on every tram query** comes from the known-broken Lviv `trip_updates` row (defect 4) that is still ENABLED. It is honest telemetry but makes per-provider health unactionable; either disable that row or report the failing provider id.

### Coverage measured with the same tool, before redeploy

| bbox | `types` | HTTP features | breakdown as returned |
|---|---|---|---|
| Львів `23.85,49.75,24.16,49.98` | `bus` | 406 | bus 351, **tram 55** |
| Львів `23.85,49.75,24.16,49.98` | `bus,trolleybus,tram,marshrutka` | 351 | bus 351 |
| Львів `23.85,49.75,24.16,49.98` | `trolleybus` | 406 | 406 × `other` |
| Львів `23.85,49.75,24.16,49.98` | `tram` | 55 | tram 55 |
| Полтава `34.45,49.52,34.70,49.66` | all 9 line types | 84 | marshrutka 49, trolleybus 20, bus 15 |
| Червоноград `24.60,50.32,24.80,50.46` | all 9 line types | 0 | 54 positions filtered as stale |
| Київ `30.45,50.35,30.65,50.50` | all 9 line types | 0 | 0 stale — no working realtime provider |

The first four rows are mutually contradictory under any single-pass filter (a `bus`-only request returning `tram`-typed features while a request that includes `tram` returns none), which is exactly the signature of the request-dependent category resolution described in defect 10. What is stable across every measurement: with a broad `types` list essentially every position resolves to a real category (0 `other` in Львів and Полтава), so strict category matching does not remove visible supply — it removes markers that appear under the wrong layer. Червоноград is a stale-feed defect, not a filter defect.

### After redeploy — same tool, same public URL, image `marshgo/api:RC-2026-10-31-vehiclefilter.1` (built from `fc5b589` + the uncommitted place-name/GTFS/vehicle-filter changes), measured 2026-10-31T16:52Z

| Query | Result |
|---|---|
| Львів `types=bus` | **354 features, all `bus`**, `unclassifiedVehicles:54` (the trams, now correctly excluded instead of leaking) |
| Львів `types=tram` | **54 features, all `tram`** |
| Львів `types=trolleybus` | **0 features, `unclassifiedVehicles:408`** — honest: Lviv has no classifiable trolleybus supply in this feed (defect 11), and the count tells the client so |
| Львів `types=other` | 0 features, `unclassifiedVehicles:0` — the explicit escape hatch works and returns nothing because the broad request resolved every position |
| Львів `types=bus,trolleybus,tram` | 408 = `{bus:354, tram:54}`, `unclassifiedVehicles:0`, `failedProviders:0`, `filteredStaleVehicles:190` — **no supply lost**, 55 markers moved from the wrong layer to the right one |
| Полтава `types=marshrutka` | 49 marshrutka, `unclassifiedVehicles:0` |
| logged-out request | HTTP 401 |
| site root over the tunnel | HTTP 200 |

The contradictory rows are gone: each category request now returns exactly its own category, and the union of the categories equals the broad request. Gates on the changed repo: `npm run typecheck` clean, `npm test` 360 tests / 357 pass / 3 skipped / 0 fail, eslint exit 0 for the three touched files, focused `tests/transport-vehicle-type-filter.test.ts` 3/3.

Residual limitation, deliberately unfixed: the *breadth* of category resolution still depends on which static providers a request loads — `types=trolleybus` reports 408 unclassified while `types=other` reports 0, because an other-only request loads every provider and therefore resolves more route ids. Widening it on a 15 s-polled hot endpoint would pull the national rail feed into every Lviv poll, so it stays as filed under defect 10-follow-up.

## 8. Addendum — LIVE-MAP-LATENCY-1: the cold path of the live map (measured 2026-10-31T17:05–17:20Z)

Measured on the acceptance API (`:3902`) with the category fix already deployed, one Lviv viewport (`bbox=23.85,49.75,24.16,49.98`), one authenticated Bearer session:

| Call | Time |
|---|---|
| 1st `types=bus` after a long-lived container (first call of the run) | **12.87 s** |
| 2nd `types=bus` | 0.376 s |
| `types=tram` (1st / 2nd) | 0.286 s / 0.198 s |
| `types=trolleybus` (1st / 2nd) | 0.256 s / 0.004 s |
| `types=bus,trolleybus,tram` (1st / 2nd) | 0.185 s / 0.023 s |

Over the public tunnel the same class of request measured 4.04 s (§7). The client polls this endpoint every 15 s at zoom ≥ 11 (`MarshGO-Site/src/map/transportLayers.ts:282-291`), so any request that misses the process-local cache freezes the map for seconds and can overlap the next poll. Note: the 12.87 s row is "first call of the run" rather than a provably frozen-cache state; the honest claim is *a multi-second cold path existed and was measured*, not exactly when it recurs.

**Root cause.** To name and categorize vehicles, the endpoint called `loadRoutes(box, types)`, which resolves the *full* cached static network (every stop, every decimated line geometry) of every static provider whose reported bbox touches the viewport — including the national umbrella mirror. `smartCache` keeps L1 as the serialized payload, so an L1 hit is cheap but an L1 miss is `JSON.parse` of megabytes. That parse, not the provider, is the multi-second cost.

**Fix.** `cachedGtfsRouteTypes` stores a compact `route_id → {name, type}` index derived from `routes.txt` only (unzip filtered to that one member), in the same shared L1+L2 cache with the same version semantics as networks; GeoJSON providers keep using their network, because their route IDs come from feature properties rather than `routes.txt`. National feeds merge first and municipal feeds last, so a city feed's own IDs win. The vehicles endpoint no longer parses route geometry at all, and because the index is request-independent the vehicle cache key is `providerId` alone, which also closes the residual of defect 10.

| After (`marshgo/api:RC-2026-10-31-routeindex.2`, container restarted so L1 was empty) | Result |
|---|---|
| cold `types=bus` (Lviv) | 200 in **5.32 s**, 352 `bus`, `unclassifiedVehicles:0`, `failedProviders:1` |
| warm `types=bus` | 0.120 s |
| warm `types=trolleybus` | 0.076 s, 0 features, `unclassifiedVehicles:0` |
| warm `types=bus,trolleybus,tram` | 0.061 s, `{bus:352, tram:53}`, `failedProviders:0` |
| cold `types=marshrutka` (Полтава) | 0.103 s, 48 marshrutka — its index was already in shared L2 |
| public tunnel `types=bus,trolleybus,tram` (1st / 2nd) | **0.60 s / 0.27 s**, 404 features `{bus:351, tram:53}` |
| public tunnel `types=tram` / `types=bus` | 0.25 s → 53 tram / 0.29 s → 351 bus, both `unclassifiedVehicles:0` |
| logged-out request / site root | 401 / 200 |

Supply did not shrink (352–354 bus and 53–54 tram, as before), and the previously reported "55 trams leaking into a `bus` request" is now structurally impossible: categories come from a request-independent index, so `unclassifiedVehicles` dropped from 54 to 0 for `types=bus` because those route IDs now resolve in every request rather than only in requests that happened to load their feed.

**Still open.** (a) A truly cold viewport for a provider never indexed before still costs 5.3 s because building its index downloads the whole GTFS ZIP; the fix would be background refresh with stale-serving, not more parsing on the request path. (b) `meta.failedProviders` is 1 for some Lviv calls and 0 for others within the same minute; this counter only covers *realtime* rows (`cachedVehicles` rejections), so it is either the known-broken Lviv `trip_updates` row (defect 4, still ENABLED) or a transient fetch failure — the response does not say which, because it reports a count instead of provider ids. Make it per-provider before treating it as health telemetry. (c) Visual marker/LIVE-badge proof is still BLOCKED_PENDING_CREDENTIAL_HANDLING (§7).

### Not yet proven
The visual marker/LIVE-badge confirmation in the browser is **BLOCKED_PENDING_CREDENTIAL_HANDLING**: signing into the public preview requires sending the throwaway password through this transcript, which conflicts with the standing rule "Do not print account tokens, access credentials or sensitive configuration". The API-level evidence above is complete; the pixel-level check needs the owner to log in once in the preview browser or to authorize the credential entry explicitly.
