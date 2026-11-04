# MARSHGO — TRANSPORT FEED AUDIT

**Generated:** 2026-11-04T13:33:19.707Z
**Generator:** `scripts/build-transport-registry.ts` (re-run: `npx tsx scripts/build-transport-registry.ts --probe <json>`)
**Product status:** NOT_RELEASED
**Evidence rule:** a row says VERIFIED only when this run measured it. NOT_MEASURED = no evidence collected, not "does not exist".

## 1. Headline numbers

| Metric | Value |
|---|---|
| Catalog rows (canonical server repo) | 52 |
| Rows probed today | 52 |
| HEALTHY | 26 |
| DEGRADED | 4 |
| OFFLINE | 17 |
| SKIPPED (needs credentials / insecure endpoint) | 5 |
| Routable in planner today | 30 |
| Feeds with live vehicle positions | 14 |
| Feeds with arrival predictions (trip updates) | 1 |
| Feeds with service alerts | 0 |
| Feeds with verified pricing | 0 |
| Feeds with reservation/booking | 0 |

## 2. Per-feed results (measured 2026-11-04T13:33:07.760Z)

| Feed | City | Type | State | Latency | Measured | Static network | Live positions | Arrival predictions | First failing check |
|---|---|---|---|---|---|---|---|---|---|
| Львівавтодор — розклад (GTFS) | Львів | gtfs | HEALTHY | 2186 ms | stops=1071, routes=72, trips=15141, stopTimes=406422 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Львівавтодор — realtime позиції (GTFS-RT) | Львів | gtfs_rt | HEALTHY | 356 ms | vehicles=603, tripUpdates=0, alerts=0, ageSeconds=2 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Львівавтодор — затримки (GTFS-RT) | Львів | gtfs_rt | HEALTHY | 172 ms | vehicles=0, tripUpdates=701, alerts=0, ageSeconds=5 | NOT_APPLICABLE | EMPTY | VERIFIED_LIVE | — |
| Стрийська міська рада — розклад (GTFS) | Стрий | gtfs | HEALTHY | 342 ms | stops=295, routes=34, trips=1061, stopTimes=13874 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Ужгородська міська рада — розклад (GTFS) | Ужгород | gtfs | HEALTHY | 386 ms | stops=217, routes=18, trips=2376, stopTimes=46460 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| inbus.ua — розклад (GTFS) | Україна | gtfs | OFFLINE | 261 ms | stops=2, routes=1, trips=45, stopTimes=90 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Scheduled service in next 7 days: no active trip service in the next 7 days |
| Zelectra — е-самокати (GBFS 3.0) | Київ | gbfs | DEGRADED | 272 ms | discoveryHttp=200, feeds=9, vehicles=1048, stations=0 | NOT_APPLICABLE | VERIFIED_LIVE | NOT_APPLICABLE | Positions are in Ukraine: bbox -77.06, -12.05, 37.30, 50.47 |
| Київ — розклад (GTFS) | Київ | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — realtime (GTFS-RT) | Київ | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | — |
| Одеса — розклад (GTFS) | Одеса | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | — |
| КП «Бучатранссервіс» — розклад (GTFS) | Буча | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Рівне — розклад (GTFS, Dozor) | Рівне | gtfs | HEALTHY | 675 ms | stops=207, routes=23, trips=2424, stopTimes=36283 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Рівне — позиції (GTFS-RT, Dozor) | Рівне | gtfs_rt | HEALTHY | 122 ms | vehicles=99, tripUpdates=0, alerts=0, ageSeconds=19 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Івано-Франківськ — розклад (GTFS, Dozor) | Івано-Франківськ | gtfs | HEALTHY | 451 ms | stops=525, routes=55, trips=3319, stopTimes=82455 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Івано-Франківськ — позиції (GTFS-RT, Dozor) | Івано-Франківськ | gtfs_rt | HEALTHY | 21 ms | vehicles=164, tripUpdates=0, alerts=0, ageSeconds=13 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Ужгород — позиції (GTFS-RT, Dozor) | Ужгород | gtfs_rt | HEALTHY | 20 ms | vehicles=63, tripUpdates=0, alerts=0, ageSeconds=11 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Ужгород — розклад (GTFS, Dozor) | Ужгород | gtfs | HEALTHY | 272 ms | stops=181, routes=17, trips=1454, stopTimes=26089 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Стрий — позиції (GTFS-RT) | Стрий | gtfs_rt | HEALTHY | 33 ms | vehicles=32, tripUpdates=0, alerts=0, ageSeconds=5 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Трускавець — позиції (GTFS-RT) | Трускавець | gtfs_rt | DEGRADED | 110 ms | vehicles=0, tripUpdates=0, alerts=0, ageSeconds=5 | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | Entities: 0 vehicles, 0 trip updates, 0 alerts |
| Чорноморськ — розклад (GTFS) | Чорноморськ | gtfs | OFFLINE | 478 ms | stops=152, routes=6, trips=16, stopTimes=406 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Scheduled service in next 7 days: no active trip service in the next 7 days |
| Червоноград — позиції (EasyWay JSON) | Червоноград | json | HEALTHY | 336 ms | vehicles=16, vehicles_bus=7, vehicles_marshrutka=9, ageSeconds=20 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Конотоп — позиції (EasyWay JSON) | Конотоп | json | DEGRADED | 59 ms | — | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | Vehicle list found: 0 entries |
| Ужгород — позиції (Dozor JSON) | Ужгород | json | HEALTHY | 169 ms | vehicles=78, vehicles_bus=78 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Івано-Франківськ — позиції (Dozor JSON) | Івано-Франківськ | json | HEALTHY | 233 ms | vehicles=176, vehicles_trolleybus=36, vehicles_bus=140 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Дніпро — позиції (iCity JSON) | Дніпро | json | DEGRADED | 1365 ms | vehicles=268, vehicles_bus=268, ageSeconds=2 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Coordinates: 268 valid, 193 invalid |
| Суми — позиції (GTFS-RT) | Суми | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | — |
| Полтава — позиції (EasyWay JSON) | Полтава | json | HEALTHY | 83 ms | vehicles=169, vehicles_marshrutka=129, vehicles_bus=23, vehicles_trolleybus=17 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| VD-Express — міжміські автобуси (GTFS) | Україна | gtfs | HEALTHY | 1089 ms | stops=37, routes=2, trips=2, stopTimes=72 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Укрзалізниця — розклад поїздів (GTFS) | Україна | gtfs | HEALTHY | 6926 ms | stops=167, routes=118, trips=118, stopTimes=1246 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київпастранс — розклад (GTFS) | Київ | gtfs | HEALTHY | 4146 ms | stops=1528, routes=165, trips=24401, stopTimes=104038 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Кам’янець-Подільський — розклад (GTFS, Dozor) | Кам’янець-Подільський | gtfs | HEALTHY | 429 ms | stops=239, routes=15, trips=2416, stopTimes=55620 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Кам’янець-Подільський — позиції (Dozor JSON) | Кам’янець-Подільський | json | HEALTHY | 174 ms | vehicles=143, vehicles_bus=143 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Біла Церква — розклад (GTFS, Dozor) | Біла Церква | gtfs | HEALTHY | 42 ms | stops=345, routes=20, trips=233, stopTimes=6275 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Біла Церква — позиції (Dozor JSON) | Біла Церква | json | HEALTHY | 135 ms | vehicles=129, vehicles_bus=128, vehicles_trolleybus=1 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Хмельницький — розклад (GTFS, Dozor) | Хмельницький | gtfs | HEALTHY | 83 ms | stops=356, routes=46, trips=822, stopTimes=20222 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Олександрія — розклад (GTFS, Dozor) | Олександрія | gtfs | HEALTHY | 21 ms | stops=184, routes=12, trips=169, stopTimes=3344 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Олександрія — позиції (Dozor JSON) | Олександрія | json | HEALTHY | 20 ms | vehicles=13, vehicles_bus=13 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Київ — міська електричка (розклад) | Київ | rest | OFFLINE | 19911 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — метро (перший/останній поїзд) | Київ | rest | OFFLINE | 19686 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — метро (інтервали руху) | Київ | rest | OFFLINE | 19675 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — метро (пересадкові вузли) | Київ | rest | OFFLINE | 19378 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — метро (години роботи станцій) | Київ | rest | OFFLINE | 19538 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — фунікулер (перший/останній рейс) | Київ | rest | OFFLINE | 19894 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — фунікулер (інтервали руху) | Київ | rest | OFFLINE | 19661 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — фунікулер (години роботи станцій) | Київ | rest | OFFLINE | 19589 ms | httpStatus=522 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — маршрутки (офіційна геометрія) | Київ | geojson | OFFLINE | 443 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — метро (геометрія ліній) | Київ | geojson | OFFLINE | 159 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — метро (станції) | Київ | geojson | OFFLINE | 115 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — міська електричка (геометрія) | Київ | geojson | OFFLINE | 191 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — фунікулер (геометрія) | Київ | geojson | OFFLINE | 221 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — фунікулер (станції) | Київ | geojson | OFFLINE | 192 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — міська електричка (станції) | Київ | geojson | OFFLINE | 110 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |

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
