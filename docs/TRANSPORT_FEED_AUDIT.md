# MARSHGO — TRANSPORT FEED AUDIT

**Generated:** 2026-11-04T15:13:28.597Z
**Generator:** `scripts/build-transport-registry.ts` (re-run: `npx tsx scripts/build-transport-registry.ts --probe <json>`)
**Product status:** NOT_RELEASED
**Evidence rule:** a row says VERIFIED only when this run measured it. NOT_MEASURED = no evidence collected, not "does not exist".

## 1. Headline numbers

| Metric | Value |
|---|---|
| Catalog rows (canonical server repo) | 88 |
| Rows probed today | 88 |
| HEALTHY | 48 |
| DEGRADED | 14 |
| OFFLINE | 21 |
| SKIPPED (needs credentials / insecure endpoint) | 5 |
| Routable in planner today | 62 |
| Feeds with live vehicle positions | 46 |
| Feeds with arrival predictions (trip updates) | 1 |
| Feeds with service alerts | 0 |
| Feeds with verified pricing | 0 |
| Feeds with reservation/booking | 0 |

## 2. Per-feed results (measured 2026-11-04T15:11:12.378Z)

| Feed | City | Type | State | Latency | Measured | Static network | Live positions | Arrival predictions | First failing check |
|---|---|---|---|---|---|---|---|---|---|
| Львівавтодор — розклад (GTFS) | Львів | gtfs | HEALTHY | 1888 ms | stops=1071, routes=72, trips=15141, stopTimes=406422 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Львівавтодор — realtime позиції (GTFS-RT) | Львів | gtfs_rt | DEGRADED | 434 ms | vehicles=616, tripUpdates=0, alerts=0, vehicleEntities=616 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 0/616 vehicle entities have valid coordinates and fresh time |
| Львівавтодор — затримки (GTFS-RT) | Львів | gtfs_rt | HEALTHY | 47 ms | vehicles=0, tripUpdates=115, alerts=0, vehicleEntities=0 | NOT_APPLICABLE | EMPTY | VERIFIED_LIVE | — |
| Стрийська міська рада — розклад (GTFS) | Стрий | gtfs | HEALTHY | 429 ms | stops=295, routes=34, trips=1061, stopTimes=13874 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Ужгородська міська рада — розклад (GTFS) | Ужгород | gtfs | HEALTHY | 407 ms | stops=217, routes=18, trips=2376, stopTimes=46460 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| inbus.ua — розклад (GTFS) | Україна | gtfs | OFFLINE | 570 ms | stops=2, routes=1, trips=45, stopTimes=90 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Scheduled service in next 7 days: no active trip service in the next 7 days |
| Zelectra — е-самокати (GBFS 3.0) | Київ | gbfs | HEALTHY | 747 ms | feeds=9, vehicles=1048, stations=0, ageSeconds=0 | NOT_APPLICABLE | VERIFIED_LIVE | NOT_APPLICABLE | — |
| Київ — розклад (GTFS) | Київ | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київ — realtime (GTFS-RT) | Київ | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | — |
| Одеса — розклад (GTFS) | Одеса | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | — |
| КП «Бучатранссервіс» — розклад (GTFS) | Буча | gtfs | SKIPPED | — | — | BLOCKED_EXTERNAL | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Рівне — розклад (GTFS, Dozor) | Рівне | gtfs | OFFLINE | 711 ms | stops=207, routes=23, trips=2424, stopTimes=36283 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Scheduled service in next 7 days: no active trip service in the next 7 days |
| Рівне — позиції (GTFS-RT, Dozor) | Рівне | gtfs_rt | DEGRADED | 40 ms | vehicles=93, tripUpdates=0, alerts=0, vehicleEntities=93 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 91/93 vehicle entities have valid coordinates and fresh time |
| Івано-Франківськ — розклад (GTFS, Dozor) | Івано-Франківськ | gtfs | HEALTHY | 830 ms | stops=525, routes=55, trips=3319, stopTimes=82455 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Івано-Франківськ — позиції (GTFS-RT, Dozor) | Івано-Франківськ | gtfs_rt | DEGRADED | 162 ms | vehicles=160, tripUpdates=0, alerts=0, vehicleEntities=160 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 143/160 vehicle entities have valid coordinates and fresh ti |
| Ужгород — позиції (GTFS-RT, Dozor) | Ужгород | gtfs_rt | DEGRADED | 20 ms | vehicles=63, tripUpdates=0, alerts=0, vehicleEntities=63 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 26/63 vehicle entities have valid coordinates and fresh time |
| Ужгород — розклад (GTFS, Dozor) | Ужгород | gtfs | OFFLINE | 625 ms | stops=181, routes=17, trips=1454, stopTimes=26089 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Agency timezone: missing or invalid agency_timezone; schedule cannot be evaluated safely |
| Стрий — позиції (GTFS-RT) | Стрий | gtfs_rt | DEGRADED | 125 ms | vehicles=32, tripUpdates=0, alerts=0, vehicleEntities=32 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 0/32 vehicle entities have valid coordinates and fresh times |
| Трускавець — позиції (GTFS-RT) | Трускавець | gtfs_rt | DEGRADED | 107 ms | vehicles=0, tripUpdates=0, alerts=0, vehicleEntities=0 | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | Entities: 0 vehicles, 0 trip updates, 0 alerts |
| Чорноморськ — розклад (GTFS) | Чорноморськ | gtfs | OFFLINE | 239 ms | stops=152, routes=6, trips=16, stopTimes=406 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Scheduled service in next 7 days: no active trip service in the next 7 days |
| Червоноград — позиції (EasyWay JSON) | Червоноград | json | HEALTHY | 304 ms | vehicles=16, timestamped=16, vehicles_bus=7, vehicles_marshrutka=9 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Конотоп — позиції (EasyWay JSON) | Конотоп | json | DEGRADED | 104 ms | — | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | Vehicle list found: 0 entries |
| Ужгород — позиції (Dozor JSON) | Ужгород | json | HEALTHY | 104 ms | vehicles=82, timestamped=82, vehicles_bus=82, ageSeconds=32 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Івано-Франківськ — позиції (Dozor JSON) | Івано-Франківськ | json | HEALTHY | 248 ms | vehicles=174, timestamped=174, vehicles_trolleybus=39, vehicles_bus=135 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Дніпро — позиції (iCity JSON) | Дніпро | json | DEGRADED | 1210 ms | vehicles=6, timestamped=6, vehicles_bus=6, ageSeconds=3 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Coordinates: 6 valid, 458 invalid |
| Суми — позиції (GTFS-RT) | Суми | gtfs_rt | SKIPPED | — | — | NOT_APPLICABLE | EMPTY | NONE_OBSERVED | — |
| Полтава — позиції (EasyWay JSON) | Полтава | json | HEALTHY | 126 ms | vehicles=188, timestamped=188, vehicles_marshrutka=131, vehicles_trolleybus=27 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| VD-Express — міжміські автобуси (GTFS) | Україна | gtfs | HEALTHY | 779 ms | stops=37, routes=2, trips=2, stopTimes=72 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Укрзалізниця — розклад поїздів (GTFS) | Україна | gtfs | HEALTHY | 9104 ms | stops=167, routes=118, trips=118, stopTimes=1246 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Київпастранс — розклад (GTFS) | Київ | gtfs | HEALTHY | 1873 ms | stops=1528, routes=165, trips=24401, stopTimes=104038 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Кам’янець-Подільський — розклад (GTFS, Dozor) | Кам’янець-Подільський | gtfs | HEALTHY | 567 ms | stops=239, routes=15, trips=2416, stopTimes=55620 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Кам’янець-Подільський — позиції (Dozor JSON) | Кам’янець-Подільський | json | HEALTHY | 182 ms | vehicles=143, timestamped=143, vehicles_bus=143, ageSeconds=16 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Біла Церква — розклад (GTFS, Dozor) | Біла Церква | gtfs | HEALTHY | 49 ms | stops=345, routes=20, trips=233, stopTimes=6275 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Біла Церква — позиції (Dozor JSON) | Біла Церква | json | HEALTHY | 138 ms | vehicles=130, timestamped=130, vehicles_bus=129, vehicles_trolleybus=1 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Хмельницький — розклад (GTFS, Dozor) | Хмельницький | gtfs | OFFLINE | 220 ms | stops=356, routes=46, trips=822, stopTimes=20222 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Scheduled service in next 7 days: no active trip service in the next 7 days |
| Олександрія — розклад (GTFS, Dozor) | Олександрія | gtfs | OFFLINE | 107 ms | stops=184, routes=12, trips=169, stopTimes=3344 | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | Scheduled service in next 7 days: no active trip service in the next 7 days |
| Олександрія — позиції (Dozor JSON) | Олександрія | json | HEALTHY | 25 ms | vehicles=15, timestamped=15, vehicles_bus=15, ageSeconds=32 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Шептицький — розклад (GTFS, UA-GIS) | Шептицький | gtfs | HEALTHY | 314 ms | stops=80, routes=7, trips=560, stopTimes=7189 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Малин — розклад (GTFS) | Малин | gtfs | HEALTHY | 887 ms | stops=98, routes=9, trips=250, stopTimes=4423 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Одеса — розклад (GTFS, дзеркало) | Одеса | gtfs | HEALTHY | 6567 ms | stops=3719, routes=87, trips=11090, stopTimes=470314 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Буча — розклад (GTFS, дзеркало) | Буча | gtfs | HEALTHY | 276 ms | stops=129, routes=4, trips=27, stopTimes=563 | VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | — |
| Шептицький — позиції (GTFS-RT, UA-GIS) | Шептицький | gtfs_rt | DEGRADED | 227 ms | vehicles=4, tripUpdates=0, alerts=0, vehicleEntities=4 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 0/4 vehicle entities have valid coordinates and fresh timest |
| Ужгород — позиції (GTFS-RT, UA-GIS) | Ужгород | gtfs_rt | DEGRADED | 93 ms | vehicles=70, tripUpdates=0, alerts=0, vehicleEntities=70 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 0/70 vehicle entities have valid coordinates and fresh times |
| Біла Церква — позиції (GTFS-RT, Dozor) | Біла Церква | gtfs_rt | DEGRADED | 23 ms | vehicles=59, tripUpdates=0, alerts=0, vehicleEntities=59 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 47/59 vehicle entities have valid coordinates and fresh time |
| Хмельницький — позиції (GTFS-RT, Dozor) | Хмельницький | gtfs_rt | DEGRADED | 20 ms | vehicles=133, tripUpdates=0, alerts=0, vehicleEntities=133 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 121/133 vehicle entities have valid coordinates and fresh ti |
| Олександрія — позиції (GTFS-RT, Dozor) | Олександрія | gtfs_rt | DEGRADED | 23 ms | vehicles=10, tripUpdates=0, alerts=0, vehicleEntities=10 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Individual vehicle positions: 9/10 vehicle entities have valid coordinates and fresh times |
| Житомир — позиції (Dozor JSON) | Житомир | json | HEALTHY | 65 ms | vehicles=59, timestamped=59, vehicles_bus=59, ageSeconds=4 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Вінниця — позиції (Dozor JSON) | Вінниця | json | HEALTHY | 128 ms | vehicles=196, timestamped=196, vehicles_trolleybus=39, vehicles_bus=121 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Запоріжжя — позиції (Dozor JSON) | Запоріжжя | json | HEALTHY | 110 ms | vehicles=56, timestamped=56, vehicles_tram=13, vehicles_trolleybus=8 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Черкаси — позиції (Dozor JSON) | Черкаси | json | HEALTHY | 45 ms | vehicles=90, timestamped=90, vehicles_trolleybus=21, vehicles_bus=69 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Черкаська область — позиції (Dozor JSON) | Черкаси | json | HEALTHY | 23 ms | vehicles=11, timestamped=11, vehicles_bus=11, ageSeconds=24 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Чернівці — позиції (Dozor JSON) | Чернівці | json | HEALTHY | 122 ms | vehicles=76, timestamped=76, vehicles_bus=33, vehicles_trolleybus=43 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Чернівці — позиції (EasyWay JSON) | Чернівці | json | HEALTHY | 312 ms | vehicles=87, timestamped=87, vehicles_bus=37, vehicles_trolleybus=50 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Харків — позиції (Dozor JSON) | Харків | json | DEGRADED | 20 ms | vehicles=7, timestamped=7, vehicles_bus=2, vehicles_trolleybus=5 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | Freshness: 203s old; live threshold is 90s |
| Одеса — позиції (Dozor JSON) | Одеса | json | HEALTHY | 473 ms | vehicles=49, timestamped=49, vehicles_trolleybus=16, vehicles_tram=20 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Хмельницький — позиції (Dozor JSON) | Хмельницький | json | HEALTHY | 290 ms | vehicles=140, timestamped=140, vehicles_bus=95, vehicles_trolleybus=45 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Мукачево — позиції (Dozor JSON) | Мукачево | json | HEALTHY | 68 ms | vehicles=35, timestamped=35, vehicles_bus=35, ageSeconds=33 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Дрогобич — позиції (Dozor JSON) | Дрогобич | json | HEALTHY | 22 ms | vehicles=18, timestamped=18, vehicles_bus=18, ageSeconds=22 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Коломия — позиції (Dozor JSON) | Коломия | json | HEALTHY | 21 ms | vehicles=15, timestamped=15, vehicles_bus=15, ageSeconds=33 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Бердичів — позиції (Dozor JSON) | Бердичів | json | HEALTHY | 117 ms | vehicles=55, timestamped=55, vehicles_bus=55, ageSeconds=16 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Володимир — позиції (Dozor JSON) | Володимир | json | HEALTHY | 23 ms | vehicles=11, timestamped=11, vehicles_bus=11, ageSeconds=34 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Звягель — позиції (Dozor JSON) | Звягель | json | HEALTHY | 36 ms | vehicles=9, timestamped=9, vehicles_bus=9, ageSeconds=18 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Чортків — позиції (Dozor JSON) | Чортків | json | HEALTHY | 22 ms | vehicles=5, timestamped=5, vehicles_bus=5, ageSeconds=29 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Коростень — позиції (Dozor JSON) | Коростень | json | HEALTHY | 22 ms | vehicles=13, timestamped=13, vehicles_bus=13, ageSeconds=35 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Коростень — позиції (EasyWay JSON) | Коростень | json | HEALTHY | 82 ms | vehicles=13, timestamped=13, vehicles_marshrutka=13, ageSeconds=35 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Дубно — позиції (Dozor JSON) | Дубно | json | HEALTHY | 20 ms | vehicles=7, timestamped=7, vehicles_bus=7, ageSeconds=35 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Борислав — позиції (Dozor JSON) | Борислав | json | HEALTHY | 19 ms | vehicles=3, timestamped=3, vehicles_bus=3, ageSeconds=22 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Нововолинськ — позиції (Dozor JSON) | Нововолинськ | json | HEALTHY | 21 ms | vehicles=4, timestamped=4, vehicles_bus=4, ageSeconds=44 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Костопіль — позиції (Dozor JSON) | Костопіль | json | HEALTHY | 25 ms | vehicles=4, timestamped=4, vehicles_bus=4, ageSeconds=44 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Рівне — позиції (Dozor JSON) | Рівне | json | HEALTHY | 206 ms | vehicles=155, timestamped=155, vehicles_bus=114, vehicles_trolleybus=41 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Рівне — позиції (EasyWay JSON) | Рівне | json | HEALTHY | 147 ms | vehicles=142, timestamped=142, vehicles_bus=100, vehicles_trolleybus=42 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Київ — маршрутки (Dozor JSON) | Київ | json | HEALTHY | 90 ms | vehicles=199, timestamped=199, vehicles_bus=199, ageSeconds=45 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Полтава — позиції (Dozor JSON) | Полтава | json | HEALTHY | 178 ms | vehicles=172, timestamped=172, vehicles_trolleybus=27, vehicles_bus=145 | NOT_APPLICABLE | VERIFIED_LIVE | NONE_OBSERVED | — |
| Київ — міська електричка (розклад) | Київ | rest | OFFLINE | 502 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — метро (перший/останній поїзд) | Київ | rest | OFFLINE | 57 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — метро (інтервали руху) | Київ | rest | OFFLINE | 2 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — метро (пересадкові вузли) | Київ | rest | OFFLINE | 2 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — метро (години роботи станцій) | Київ | rest | OFFLINE | 4 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — фунікулер (перший/останній рейс) | Київ | rest | OFFLINE | 293 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — фунікулер (інтервали руху) | Київ | rest | OFFLINE | 139 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — фунікулер (години роботи станцій) | Київ | rest | OFFLINE | 127 ms | — | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Kyiv Open Data schedule API: Host cannot be resolved |
| Київ — маршрутки (офіційна геометрія) | Київ | geojson | OFFLINE | 154 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — метро (геометрія ліній) | Київ | geojson | OFFLINE | 0 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — метро (станції) | Київ | geojson | OFFLINE | 1 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — міська електричка (геометрія) | Київ | geojson | OFFLINE | 133 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — фунікулер (геометрія) | Київ | geojson | OFFLINE | 185 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — фунікулер (станції) | Київ | geojson | OFFLINE | 177 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |
| Київ — міська електричка (станції) | Київ | geojson | OFFLINE | 104 ms | — | UNAVAILABLE | NOT_APPLICABLE | NOT_APPLICABLE | GeoJSON feed: Host cannot be resolved |

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

## 4. Acceptance database (SELECT-only, 2026-11-04T15:12:00Z)

| Table / grouping | Count |
|---|---|
| mobility_providers | 88 |
| — ENABLED | 62 |
| — TEMPORARILY_UNAVAILABLE | 20 |
| — DISCOVERED | 6 |
| ENABLED gtfs / gtfs_rt / json | 13 / 12 / 36 |
| mobility_operators | 7 |
| mobility_networks | 4 |
| rental_locations (bike/scooter station inventory) | 0 |
| rental_availability_snapshots | 0 |
| provider_source_records (per-source ingest ledger) | 0 |
| vehicles (carpool fleet, not GTFS-RT positions) | 19 |

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
