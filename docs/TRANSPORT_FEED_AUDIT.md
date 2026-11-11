# MARSHGO — TRANSPORT FEED AUDIT

**Generated:** 2026-11-11T19:44:06.703Z
**Generator:** `scripts/build-transport-registry.ts` (re-run: `npx tsx scripts/build-transport-registry.ts --probe <json>`)
**Product status:** NOT_RELEASED
**Evidence rule:** a row says VERIFIED only when this run measured it. NOT_MEASURED = no evidence collected, not "does not exist".

## 1. Headline numbers

| Metric | Value |
|---|---|
| Catalog rows (canonical server repo) | 88 |
| Rows probed today | 88 |
| HEALTHY | 12 |
| DEGRADED | 9 |
| OFFLINE | 15 |
| SKIPPED (needs credentials / insecure endpoint) | 52 |
| Routable in planner today | 21 |
| Feeds with live vehicle positions | 8 |
| Feeds with arrival predictions (trip updates) | 1 |
| Feeds with service alerts | 2 |
| Feeds with verified pricing | 0 |
| Feeds with reservation/booking | 0 |

## 2. Per-feed results (measured 2026-11-11T19:36:30.325Z)

| Feed | City | Type | State | Latency | Measured | Static network | Live positions | Arrival predictions | First failing check |
|---|---|---|---|---|---|---|---|---|---|
| Львівавтодор — розклад (GTFS) | Львів | gtfs | HEALTHY | 2105 ms | stops=1064, trips=15606, routes=72, stopTimes=421884 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Львівавтодор — realtime позиції (GTFS-RT) | Львів | gtfs_rt | DEGRADED | 48 ms | alerts=15, vehicles=391, ageSeconds=1, tripUpdates=0 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 351/391 vehicle entities have valid coordinates and fresh ti |
| Львівавтодор — затримки (GTFS-RT) | Львів | gtfs_rt | HEALTHY | 152 ms | alerts=15, vehicles=0, ageSeconds=2, tripUpdates=436 | NOT_APPLICABLE | EMPTY | VERIFIED_LIVE | — |
| Стрийська міська рада — розклад (GTFS) | Стрий | gtfs | HEALTHY | 132 ms | stops=292, trips=1061, routes=34, stopTimes=13874 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Ужгородська міська рада — розклад (GTFS) | Ужгород | gtfs | HEALTHY | 236 ms | stops=215, trips=2376, routes=18, stopTimes=46460 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| inbus.ua — розклад (GTFS) | Україна | gtfs | SKIPPED | — | — | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Zelectra — е-самокати (GBFS 3.0) | Київ | gbfs | DEGRADED | 874 ms | feeds=9, stations=0, vehicles=998, ageSeconds=0 | NOT_APPLICABLE | VERIFIED_LIVE | NOT_APPLICABLE | — |
| Київ — розклад (GTFS) | Київ | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | insecure_endpoint |
| Київ — realtime (GTFS-RT) | Київ | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | insecure_endpoint |
| Одеса — розклад (GTFS) | Одеса | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | requires_credentials |
| КП «Бучатранссервіс» — розклад (GTFS) | Буча | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | requires_credentials |
| Рівне — розклад (GTFS, Dozor) | Рівне | gtfs | DEGRADED | 391 ms | stops=176, trips=1084, routes=16, stopTimes=17560 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Scheduled service in next 7 days: no active trip service in the next 7 days |
| Рівне — позиції (GTFS-RT, Dozor) | Рівне | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Івано-Франківськ — розклад (GTFS, Dozor) | Івано-Франківськ | gtfs | HEALTHY | 463 ms | stops=522, trips=2700, routes=48, stopTimes=65581 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Івано-Франківськ — позиції (GTFS-RT, Dozor) | Івано-Франківськ | gtfs_rt | DEGRADED | 22 ms | alerts=0, vehicles=65, ageSeconds=18, tripUpdates=0 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 58/65 vehicle entities have valid coordinates and fresh time |
| Ужгород — позиції (GTFS-RT, Dozor) | Ужгород | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Ужгород — розклад (GTFS, Dozor) | Ужгород | gtfs | SKIPPED | — | — | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Стрий — позиції (GTFS-RT) | Стрий | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Трускавець — позиції (GTFS-RT) | Трускавець | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Чорноморськ — розклад (GTFS) | Чорноморськ | gtfs | SKIPPED | — | — | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Червоноград — позиції (EasyWay JSON) | Червоноград | json | HEALTHY | 276 ms | vehicles=12, ageSeconds=21, timestamped=12, vehicles_bus=5 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Конотоп — позиції (EasyWay JSON) | Конотоп | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Ужгород — позиції (Dozor JSON) | Ужгород | json | DEGRADED | 163 ms | vehicles=51, ageSeconds=-420312, timestamped=51, vehicles_bus=51 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Freshness: -420312s old; live threshold is 90s |
| Івано-Франківськ — позиції (Dozor JSON) | Івано-Франківськ | json | DEGRADED | 80 ms | vehicles=107, ageSeconds=-6322, timestamped=107, vehicles_bus=90 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Freshness: -6322s old; live threshold is 90s |
| Дніпро — позиції (iCity JSON) | Дніпро | json | DEGRADED | 1336 ms | vehicles=229, ageSeconds=1, timestamped=229, vehicles_bus=229 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Coordinates: 229 valid, 160 invalid |
| Суми — позиції (GTFS-RT) | Суми | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | insecure_endpoint |
| Полтава — позиції (EasyWay JSON) | Полтава | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| VD-Express — міжміські автобуси (GTFS) | Україна | gtfs | SKIPPED | — | — | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Укрзалізниця — розклад поїздів (GTFS) | Україна | gtfs | HEALTHY | 5711 ms | stops=167, trips=115, routes=115, stopTimes=1192 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київпастранс — розклад (GTFS) | Київ | gtfs | HEALTHY | 1153 ms | stops=1774, trips=27206, routes=191, stopTimes=115443 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Кам’янець-Подільський — розклад (GTFS, Dozor) | Кам’янець-Подільський | gtfs | SKIPPED | — | — | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Кам’янець-Подільський — позиції (Dozor JSON) | Кам’янець-Подільський | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Біла Церква — розклад (GTFS, Dozor) | Біла Церква | gtfs | SKIPPED | — | — | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Біла Церква — позиції (Dozor JSON) | Біла Церква | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Хмельницький — розклад (GTFS, Dozor) | Хмельницький | gtfs | SKIPPED | — | — | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Олександрія — розклад (GTFS, Dozor) | Олександрія | gtfs | SKIPPED | — | — | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Олександрія — позиції (Dozor JSON) | Олександрія | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Шептицький — розклад (GTFS, UA-GIS) | Шептицький | gtfs | HEALTHY | 209 ms | stops=80, trips=560, routes=7, stopTimes=7189 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Малин — розклад (GTFS) | Малин | gtfs | HEALTHY | 575 ms | stops=98, trips=250, routes=9, stopTimes=4423 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Одеса — розклад (GTFS, дзеркало) | Одеса | gtfs | HEALTHY | 4908 ms | stops=3719, trips=11064, routes=87, stopTimes=469625 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Буча — розклад (GTFS, дзеркало) | Буча | gtfs | HEALTHY | 96 ms | stops=129, trips=27, routes=4, stopTimes=563 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Шептицький — позиції (GTFS-RT, UA-GIS) | Шептицький | gtfs_rt | DEGRADED | 119 ms | alerts=0, vehicles=0, ageSeconds=0, tripUpdates=0 | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | Entities: 0 vehicles, 0 trip updates, 0 alerts |
| Ужгород — позиції (GTFS-RT, UA-GIS) | Ужгород | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Біла Церква — позиції (GTFS-RT, Dozor) | Біла Церква | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Хмельницький — позиції (GTFS-RT, Dozor) | Хмельницький | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Олександрія — позиції (GTFS-RT, Dozor) | Олександрія | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Житомир — позиції (Dozor JSON) | Житомир | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Вінниця — позиції (Dozor JSON) | Вінниця | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Запоріжжя — позиції (Dozor JSON) | Запоріжжя | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Черкаси — позиції (Dozor JSON) | Черкаси | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Черкаська область — позиції (Dozor JSON) | Черкаси | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Чернівці — позиції (Dozor JSON) | Чернівці | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Чернівці — позиції (EasyWay JSON) | Чернівці | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Харків — позиції (Dozor JSON) | Харків | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Одеса — позиції (Dozor JSON) | Одеса | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Хмельницький — позиції (Dozor JSON) | Хмельницький | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Мукачево — позиції (Dozor JSON) | Мукачево | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Дрогобич — позиції (Dozor JSON) | Дрогобич | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Коломия — позиції (Dozor JSON) | Коломия | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Бердичів — позиції (Dozor JSON) | Бердичів | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Володимир — позиції (Dozor JSON) | Володимир | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Звягель — позиції (Dozor JSON) | Звягель | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Чортків — позиції (Dozor JSON) | Чортків | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Коростень — позиції (Dozor JSON) | Коростень | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Коростень — позиції (EasyWay JSON) | Коростень | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Дубно — позиції (Dozor JSON) | Дубно | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Борислав — позиції (Dozor JSON) | Борислав | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Нововолинськ — позиції (Dozor JSON) | Нововолинськ | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Костопіль — позиції (Dozor JSON) | Костопіль | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Рівне — позиції (Dozor JSON) | Рівне | json | DEGRADED | 211 ms | vehicles=73, ageSeconds=-1756, timestamped=73, vehicles_bus=66 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Freshness: -1756s old; live threshold is 90s |
| Рівне — позиції (EasyWay JSON) | Рівне | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Київ — маршрутки (Dozor JSON) | Київ | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Полтава — позиції (Dozor JSON) | Полтава | json | SKIPPED | — | — | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | license_unverified |
| Київ — міська електричка (розклад) | Київ | rest | OFFLINE | 376 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Feed accessible: Host cannot be resolved |
| Київ — метро (перший/останній поїзд) | Київ | rest | OFFLINE | 1 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Feed accessible: Host cannot be resolved |
| Київ — метро (інтервали руху) | Київ | rest | OFFLINE | 2 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Feed accessible: Host cannot be resolved |
| Київ — метро (пересадкові вузли) | Київ | rest | OFFLINE | 1 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Feed accessible: Host cannot be resolved |
| Київ — метро (години роботи станцій) | Київ | rest | OFFLINE | 1 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — фунікулер (перший/останній рейс) | Київ | rest | OFFLINE | 185 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — фунікулер (інтервали руху) | Київ | rest | OFFLINE | 209 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — фунікулер (години роботи станцій) | Київ | rest | OFFLINE | 120 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — маршрутки (офіційна геометрія) | Київ | geojson | OFFLINE | 1 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — метро (геометрія ліній) | Київ | geojson | OFFLINE | 1 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — метро (станції) | Київ | geojson | OFFLINE | 0 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — міська електричка (геометрія) | Київ | geojson | OFFLINE | 182 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — фунікулер (геометрія) | Київ | geojson | OFFLINE | 195 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — фунікулер (станції) | Київ | geojson | OFFLINE | 91 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — міська електричка (станції) | Київ | geojson | OFFLINE | 124 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |

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

## 4. Acceptance database (SELECT-only, 2026-11-11T19:37:00Z)

| Table / grouping | Count |
|---|---|
| mobility_providers (rows) | 89 |
| — status enabled (connected) | 36 |
| — product-active (enabled AND healthy/degraded; the only rows product queries consume) | 21 |
| — discovery ENABLED | 12 |
| — discovery TEMPORARILY_UNAVAILABLE (enabled but offline/degraded) | 25 |
| — discovery DISCOVERED (license / credentials / http-only blocked) | 52 |
| enabled by source gtfs / gtfs_rt / json / gbfs / rest / geojson | 11 / 4 / 5 / 1 / 8 / 7 |
| product-active by source gtfs / gtfs_rt / json / gbfs | 11 / 4 / 5 / 1 |
| mobility_operators | 7 |
| mobility_networks | 4 |
| rental_locations (bike/scooter station inventory) | 317 |
| rental_availability_snapshots | 0 |
| provider_source_records (per-source ingest ledger) | 0 |
| vehicles (carpool fleet, not GTFS-RT positions) | 0 |

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

1. **Two catalog copies remain.** The canonical Server smoke command `npm run acceptance:transport-feeds` probes Base, Wave 2, Wave 3 and Kyiv open-data entries from `server/mobility/ukraineCatalog.ts` (88 rows). The root repository's legacy probe is a 43-row subset; do not use it as full-catalog acceptance.
2. **Kyiv city open data is down as a source.** All 15 Kyiv portal rows (7 GeoJSON + 8 REST) fail DNS resolution ("Host cannot be resolved") for `gisserver.kyivcity.gov.ua` / `gisserver-stage.kyivcity.gov.ua`; `data.kyivcity.gov.ua` returns 403/302. Metro, funicular, city express and Kyiv marshrutka geometry therefore have no working provider feed right now. They are registered enabled-but-offline so the health monitor retries them, but every product query excludes them via the `health IN ('healthy','degraded')` filter.
3. **Arrival predictions exist only in Lviv.** The Lviv "затримки" GTFS-RT feed measured `tripUpdates=436` and `alerts=15`; the Lviv positions feed carries `alerts=15`. Every other GTFS-RT feed (Івано-Франківськ, Шептицький) measured `tripUpdates=0` / `alerts=0`. "Next tram in 4 min" and service alerts are provider-backed in Lviv only, not nationwide.
4. **Dozor JSON feeds carry future-dated timestamps.** Ужгород (`ageSeconds=-420312`), Івано-Франківськ (`-6322`) and Рівне (`-1756`) return positions whose timestamps are ahead of now, so they are graded degraded; the freshness logic must clamp negative ages rather than trust them. Vehicle counts are real (51 / 107 / 73).
5. **Micromobility supply is scooter-only and not snapshotted.** `rental_locations` = 317 (Zelectra stations persisted) but `rental_availability_snapshots` = 0 and `provider_source_records` (the ingest ledger) = 0. Bicycle legs cannot be produced from real inventory; scooter legs are geofence-estimate only.
6. **Zelectra GBFS is reachable but city supply is operator-declared.** The current probe reports `vehicles=998`, `pointsInDeclaredCountry=998` (all in-country after the coverage filter) and `stations=0`. The "ACTIVE_LIVE" operator status means "feed reachable and country-filtered", not independently verified Kyiv street-level supply.
7. **No marshrutka GTFS network.** Marshrutka is live positions only (Червоноград EasyWay `vehicles_marshrutka=7`); the official Kyiv marshrutka GeoJSON is DNS-dead, so there is no routable marshrutka static network.
8. **Stale/dead rows still registered.** Рівне GTFS and Chornomorsk GTFS parse but have no service in the next 7 days (stale archives). The lightweight reachability monitor grades Рівне degraded (HTTP 200) even though the full GTFS parse shows no current service, so it can appear product-active without routable trips; inbus.ua resolves to 2 stops / 1 route; Khmelnytskyi Dozor static zip is empty (0 stops, 0 routes).
9. **Declared lifecycle is not enforced.** `shared/mobility/interfaces.ts` defines HEALTHY/DEGRADED/STALE/OFFLINE/NOT_CONFIGURED, but the map layer only derives LIVE/STALE/OLD/UNKNOWN from position age, and `discovery_status` vs `status` are separate columns consumed by different queries.
