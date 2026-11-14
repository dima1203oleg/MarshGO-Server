# MARSHGO — TRANSPORT FEED AUDIT

**Generated:** 2026-11-12T02:11:53.837Z
**Generator:** `scripts/build-transport-registry.ts` (re-run: `npx tsx scripts/build-transport-registry.ts --probe <json>`)
**Product status:** NOT_RELEASED
**Artifact source:** SELECT-only mobility_providers.last_report after mobility:seed
**Artifact reported timestamp:** 2026-11-11T19:36:30.325Z
**Export timestamp:** NOT_MEASURED
**Evidence rule:** Capabilities describe dated measurements in the supplied artifact, not current runtime availability. Undated counts remain diagnostics only.

## 1. Headline numbers

| Metric | Value |
|---|---|
| Catalog rows (canonical server repo) | 88 |
| Non-skipped result rows (not necessarily dated) | 36 |
| Dated measurement rows | 0 |
| HEALTHY | 12 |
| DEGRADED | 9 |
| OFFLINE | 15 |
| SKIPPED (license / access / endpoint policy) | 52 |
| Verified product routing | NOT_MEASURED |
| Feeds with live vehicle positions | 0 |
| Feeds with arrival predictions (trip updates) | 0 |
| Feeds with service alerts | 0 |
| Feeds with verified pricing | 0 |
| Feeds with reservation/booking | 0 |

## 2. Per-feed evidence

Reported counts are retained for diagnosis, including undated values. Missing measurement timestamps, invalid/future ages and missing per-vehicle freshness never become VERIFIED_LIVE. Static and realtime evidence are independent.

| Feed | City | Type | Reported state | Measurement time | Reported counts (may be undated) | Static network | Fresh positions at measurement | Trip updates at measurement | Failed checks / skip reason |
|---|---|---|---|---|---|---|---|---|---|
| Львівавтодор — розклад (GTFS) | Львів | gtfs | HEALTHY | NOT_MEASURED | stops=1064, trips=15606, routes=72, stopTimes=421884, routes_bus=55, routes_tram=8, routes_trolleybus=9 | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Львівавтодор — realtime позиції (GTFS-RT) | Львів | gtfs_rt | DEGRADED | NOT_MEASURED | alerts=15, vehicles=391, ageSeconds=1, tripUpdates=0, vehicleEntities=391, vehiclePositions=391, freshVehiclePositions=351, staleVehiclePositions=40, missingVehiclePositions=0, missingVehicleTimestamps=0 | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | Individual vehicle positions: 351/391 vehicle entities have valid coordinates and fresh timestamps; 40 stale, 0 without timestamp, 0 without valid coordinates |
| Львівавтодор — затримки (GTFS-RT) | Львів | gtfs_rt | HEALTHY | NOT_MEASURED | alerts=15, vehicles=0, ageSeconds=2, tripUpdates=436, vehicleEntities=0, vehiclePositions=0, freshVehiclePositions=0, staleVehiclePositions=0, missingVehiclePositions=0, missingVehicleTimestamps=0 | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | — |
| Стрийська міська рада — розклад (GTFS) | Стрий | gtfs | HEALTHY | NOT_MEASURED | stops=292, trips=1061, routes=34, stopTimes=13874, routes_bus=34 | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Ужгородська міська рада — розклад (GTFS) | Ужгород | gtfs | HEALTHY | NOT_MEASURED | stops=215, trips=2376, routes=18, stopTimes=46460, routes_bus=18 | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | — |
| inbus.ua — розклад (GTFS) | Україна | gtfs | SKIPPED | NOT_MEASURED | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Zelectra — е-самокати (GBFS 3.0) | Київ | gbfs | DEGRADED | NOT_MEASURED | feeds=9, stations=0, vehicles=998, ageSeconds=0, pointsInDeclaredCountry=998 | NOT_APPLICABLE | NOT_MEASURED | NOT_APPLICABLE | — |
| Київ — розклад (GTFS) | Київ | gtfs | SKIPPED | NOT_MEASURED | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | insecure_endpoint |
| Київ — realtime (GTFS-RT) | Київ | gtfs_rt | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | insecure_endpoint |
| Одеса — розклад (GTFS) | Одеса | gtfs | SKIPPED | NOT_MEASURED | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | requires_credentials |
| КП «Бучатранссервіс» — розклад (GTFS) | Буча | gtfs | SKIPPED | NOT_MEASURED | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | requires_credentials |
| Рівне — розклад (GTFS, Dozor) | Рівне | gtfs | DEGRADED | NOT_MEASURED | stops=176, trips=1084, routes=16, stopTimes=17560, routes_bus=7, routes_trolleybus=9 | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | Scheduled service in next 7 days: no active trip service in the next 7 days |
| Рівне — позиції (GTFS-RT, Dozor) | Рівне | gtfs_rt | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | license_unverified |
| Івано-Франківськ — розклад (GTFS, Dozor) | Івано-Франківськ | gtfs | HEALTHY | NOT_MEASURED | stops=522, trips=2700, routes=48, stopTimes=65581, routes_bus=40, routes_trolleybus=8 | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Івано-Франківськ — позиції (GTFS-RT, Dozor) | Івано-Франківськ | gtfs_rt | DEGRADED | NOT_MEASURED | alerts=0, vehicles=65, ageSeconds=18, tripUpdates=0, vehicleEntities=65, vehiclePositions=65, freshVehiclePositions=58, staleVehiclePositions=7, missingVehiclePositions=0, missingVehicleTimestamps=0 | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | Individual vehicle positions: 58/65 vehicle entities have valid coordinates and fresh timestamps; 7 stale, 0 without timestamp, 0 without valid coordinates |
| Ужгород — позиції (GTFS-RT, Dozor) | Ужгород | gtfs_rt | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | license_unverified |
| Ужгород — розклад (GTFS, Dozor) | Ужгород | gtfs | SKIPPED | NOT_MEASURED | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Стрий — позиції (GTFS-RT) | Стрий | gtfs_rt | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | license_unverified |
| Трускавець — позиції (GTFS-RT) | Трускавець | gtfs_rt | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | license_unverified |
| Чорноморськ — розклад (GTFS) | Чорноморськ | gtfs | SKIPPED | NOT_MEASURED | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Червоноград — позиції (EasyWay JSON) | Червоноград | json | HEALTHY | NOT_MEASURED | vehicles=12, ageSeconds=21, timestamped=12, vehicles_bus=5, vehicles_marshrutka=7 | NOT_APPLICABLE | NOT_MEASURED | NOT_APPLICABLE | — |
| Конотоп — позиції (EasyWay JSON) | Конотоп | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Ужгород — позиції (Dozor JSON) | Ужгород | json | DEGRADED | NOT_MEASURED | vehicles=51, ageSeconds=-420312, timestamped=51, vehicles_bus=51 | NOT_APPLICABLE | NOT_MEASURED | NOT_APPLICABLE | Freshness: -420312s old; live threshold is 90s |
| Івано-Франківськ — позиції (Dozor JSON) | Івано-Франківськ | json | DEGRADED | NOT_MEASURED | vehicles=107, ageSeconds=-6322, timestamped=107, vehicles_bus=90, vehicles_trolleybus=17 | NOT_APPLICABLE | NOT_MEASURED | NOT_APPLICABLE | Freshness: -6322s old; live threshold is 90s |
| Дніпро — позиції (iCity JSON) | Дніпро | json | DEGRADED | NOT_MEASURED | vehicles=229, ageSeconds=1, timestamped=229, vehicles_bus=229 | NOT_APPLICABLE | NOT_MEASURED | NOT_APPLICABLE | Coordinates: 229 valid, 160 invalid |
| Суми — позиції (GTFS-RT) | Суми | gtfs_rt | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | insecure_endpoint |
| Полтава — позиції (EasyWay JSON) | Полтава | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| VD-Express — міжміські автобуси (GTFS) | Україна | gtfs | SKIPPED | NOT_MEASURED | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Укрзалізниця — розклад поїздів (GTFS) | Україна | gtfs | HEALTHY | NOT_MEASURED | stops=167, trips=115, routes=115, stopTimes=1192, routes_train=112, routes_suburban=3 | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київпастранс — розклад (GTFS) | Київ | gtfs | HEALTHY | NOT_MEASURED | stops=1774, trips=27206, routes=191, stopTimes=115443, routes_bus=130, routes_tram=17, routes_trolleybus=44 | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Кам’янець-Подільський — розклад (GTFS, Dozor) | Кам’янець-Подільський | gtfs | SKIPPED | NOT_MEASURED | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Кам’янець-Подільський — позиції (Dozor JSON) | Кам’янець-Подільський | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Біла Церква — розклад (GTFS, Dozor) | Біла Церква | gtfs | SKIPPED | NOT_MEASURED | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Біла Церква — позиції (Dozor JSON) | Біла Церква | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Хмельницький — розклад (GTFS, Dozor) | Хмельницький | gtfs | SKIPPED | NOT_MEASURED | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Олександрія — розклад (GTFS, Dozor) | Олександрія | gtfs | SKIPPED | NOT_MEASURED | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | license_unverified |
| Олександрія — позиції (Dozor JSON) | Олександрія | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Шептицький — розклад (GTFS, UA-GIS) | Шептицький | gtfs | HEALTHY | NOT_MEASURED | stops=80, trips=560, routes=7, stopTimes=7189, routes_bus=7 | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Малин — розклад (GTFS) | Малин | gtfs | HEALTHY | NOT_MEASURED | stops=98, trips=250, routes=9, stopTimes=4423, routes_bus=9 | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Одеса — розклад (GTFS, дзеркало) | Одеса | gtfs | HEALTHY | NOT_MEASURED | stops=3719, trips=11064, routes=87, stopTimes=469625, routes_bus=62, routes_tram=18, routes_trolleybus=7 | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Буча — розклад (GTFS, дзеркало) | Буча | gtfs | HEALTHY | NOT_MEASURED | stops=129, trips=27, routes=4, stopTimes=563, routes_bus=4 | NOT_MEASURED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Шептицький — позиції (GTFS-RT, UA-GIS) | Шептицький | gtfs_rt | DEGRADED | NOT_MEASURED | alerts=0, vehicles=0, ageSeconds=0, tripUpdates=0, vehicleEntities=0, vehiclePositions=0, freshVehiclePositions=0, staleVehiclePositions=0, missingVehiclePositions=0, missingVehicleTimestamps=0 | NOT_APPLICABLE | NOT_MEASURED | NOT_MEASURED | Entities: 0 vehicles, 0 trip updates, 0 alerts |
| Ужгород — позиції (GTFS-RT, UA-GIS) | Ужгород | gtfs_rt | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | license_unverified |
| Біла Церква — позиції (GTFS-RT, Dozor) | Біла Церква | gtfs_rt | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | license_unverified |
| Хмельницький — позиції (GTFS-RT, Dozor) | Хмельницький | gtfs_rt | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | license_unverified |
| Олександрія — позиції (GTFS-RT, Dozor) | Олександрія | gtfs_rt | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | license_unverified |
| Житомир — позиції (Dozor JSON) | Житомир | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Вінниця — позиції (Dozor JSON) | Вінниця | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Запоріжжя — позиції (Dozor JSON) | Запоріжжя | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Черкаси — позиції (Dozor JSON) | Черкаси | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Черкаська область — позиції (Dozor JSON) | Черкаси | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Чернівці — позиції (Dozor JSON) | Чернівці | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Чернівці — позиції (EasyWay JSON) | Чернівці | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Харків — позиції (Dozor JSON) | Харків | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Одеса — позиції (Dozor JSON) | Одеса | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Хмельницький — позиції (Dozor JSON) | Хмельницький | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Мукачево — позиції (Dozor JSON) | Мукачево | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Дрогобич — позиції (Dozor JSON) | Дрогобич | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Коломия — позиції (Dozor JSON) | Коломия | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Бердичів — позиції (Dozor JSON) | Бердичів | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Володимир — позиції (Dozor JSON) | Володимир | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Звягель — позиції (Dozor JSON) | Звягель | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Чортків — позиції (Dozor JSON) | Чортків | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Коростень — позиції (Dozor JSON) | Коростень | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Коростень — позиції (EasyWay JSON) | Коростень | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Дубно — позиції (Dozor JSON) | Дубно | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Борислав — позиції (Dozor JSON) | Борислав | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Нововолинськ — позиції (Dozor JSON) | Нововолинськ | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Костопіль — позиції (Dozor JSON) | Костопіль | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Рівне — позиції (Dozor JSON) | Рівне | json | DEGRADED | NOT_MEASURED | vehicles=73, ageSeconds=-1756, timestamped=73, vehicles_bus=66, vehicles_trolleybus=7 | NOT_APPLICABLE | NOT_MEASURED | NOT_APPLICABLE | Freshness: -1756s old; live threshold is 90s |
| Рівне — позиції (EasyWay JSON) | Рівне | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Київ — маршрутки (Dozor JSON) | Київ | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Полтава — позиції (Dozor JSON) | Полтава | json | SKIPPED | NOT_MEASURED | — | NOT_APPLICABLE | BLOCKED_EXTERNAL | NOT_APPLICABLE | license_unverified |
| Київ — міська електричка (розклад) | Київ | rest | OFFLINE | NOT_MEASURED | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Feed accessible: Host cannot be resolved |
| Київ — метро (перший/останній поїзд) | Київ | rest | OFFLINE | NOT_MEASURED | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Feed accessible: Host cannot be resolved |
| Київ — метро (інтервали руху) | Київ | rest | OFFLINE | NOT_MEASURED | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Feed accessible: Host cannot be resolved |
| Київ — метро (пересадкові вузли) | Київ | rest | OFFLINE | NOT_MEASURED | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Feed accessible: Host cannot be resolved |
| Київ — метро (години роботи станцій) | Київ | rest | OFFLINE | NOT_MEASURED | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — фунікулер (перший/останній рейс) | Київ | rest | OFFLINE | NOT_MEASURED | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — фунікулер (інтервали руху) | Київ | rest | OFFLINE | NOT_MEASURED | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — фунікулер (години роботи станцій) | Київ | rest | OFFLINE | NOT_MEASURED | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — маршрутки (офіційна геометрія) | Київ | geojson | OFFLINE | NOT_MEASURED | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — метро (геометрія ліній) | Київ | geojson | OFFLINE | NOT_MEASURED | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — метро (станції) | Київ | geojson | OFFLINE | NOT_MEASURED | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — міська електричка (геометрія) | Київ | geojson | OFFLINE | NOT_MEASURED | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — фунікулер (геометрія) | Київ | geojson | OFFLINE | NOT_MEASURED | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — фунікулер (станції) | Київ | geojson | OFFLINE | NOT_MEASURED | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — міська електричка (станції) | Київ | geojson | OFFLINE | NOT_MEASURED | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |

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
| GTFS-RT Trip Updates cache | server/journey/gtfsRealtime.ts + server/cache/cacheService.ts (L1; Redis when configured, not durable history) | yes |
| GTFS-RT Service Alerts entity count | server/mobility/gtfsRealtime.ts (counts only; no product alert delivery established) | yes |

## 4. Database and runtime eligibility

**NOT_MEASURED.** This generator does not query the running database. Activation, persistence, fares, reservations and route completeness require separate evidence; no database counts are embedded in the generator.

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

## 6. Evidence boundaries

The operator table above contains code declarations, not measured availability. A feed count or an HTTP response proves neither a working journey nor a bookable vehicle. Missing evidence is not evidence that a mode is absent from Ukraine. Failed checks and skip reasons are preserved in full above.
