# MARSHGO — 12-MODE TRANSPORT COVERAGE MATRIX

**Generated:** 2026-11-11T19:44:06.703Z · **Product status:** NOT_RELEASED
**Routable** column reflects `journeySearchSupportedTypes` in the web client. **Static/live** city lists are computed from feeds that were reachable and parseable in the 2026-11-11T19:36:30.325Z probe, not from intentions.

| Transport category | Routable in planner | Static network (cities with data today) | Live positions (cities today) | Honest status |
|---|---|---|---|---|
| Автобуси | yes | Львів, Стрий, Ужгород, Рівне, Івано-Франківськ, Київ, Шептицький, Малин, Одеса, Буча | Львів, Івано-Франківськ, Червоноград, Ужгород, Дніпро, Рівне | Static network measured in 10 catalog cities; live positions measured in 6 cities. |
| Маршрутки | yes | — | Червоноград | Live positions only (EasyWay JSON typed as marshrutka, e.g. Червоноград). No marshrutka GTFS network is reachable: the official Kyiv marshrutka GeoJSON fails DNS resolution today. |
| Тролейбуси | yes | Львів, Рівне, Івано-Франківськ, Київ, Одеса | Івано-Франківськ, Рівне | Static in 5 cities, live typed positions in 2. |
| Трамваї | yes | Львів, Київ, Одеса | — | Static in Lviv and Kyiv (Київпастранс mirror). No tram GTFS-RT source found. |
| Метро | yes | — | — | No provider feed available today: every Kyiv metro row (geometry, stations, first/last train, intervals, interchanges, opening hours) fails DNS resolution (gisserver.kyivcity.gov.ua / gisserver-stage.kyivcity.gov.ua). Hand-built `kyivMetroTimetable.ts` depends on the same dead portal. |
| Поїзди/електрички | yes | Україна | — | UZ GTFS mirror (ODbL, OpenStreetMap-derived, not official УЗ) responded 200 with 115 routes / 167 stops; no realtime train feed. |
| Попутки | yes | — | — | Own marketplace supply, not a feed: 14 vehicles and the two-account lifecycle were proven in the acceptance environment on 2026-10-31. |
| Самокати | yes | — | — | Zelectra GBFS reachable (998 vehicles, all in-country after the coverage filter); routing uses geofence estimates and requires CONFIRMED network + FREE_FLOATING_ZONE return rule. City-level street supply is operator-declared, not independently verified. |
| Велосипеди | no (toggle only) | — | — | No Ukrainian bike-share source verified: CityBikes discovery returned 815 networks with 0 in Ukraine, `nextbike_lv` resolves to Latvia, `nextbike_vin` is HTTP 404. `rental_locations` = 317 are Zelectra scooter stations, not bicycles. Bicycle routing code exists but has no supply. |
| Таксі | no (toggle only) | — | — | Kiwitaxi/Intui are catalog + affiliate price lists pending credentials; no booking API is authorized. No Ukrainian taxi operator feed. |
| Каршеринг | no (toggle only) | — | — | No feed, no partner agreement, no rows in the registry. |
| Трансфери | no (toggle only) | — | — | Partner adapter endpoints exist (`server/partner/router.ts`, `transferAdapters.ts`) but every operator is AWAITING_CREDENTIALS or AWAITING_AGREEMENT. |

## Acceptance chain per requirement

| Stage | Status | Evidence |
|---|---|---|
| Verified source | PARTIAL | 12/88 catalog rows healthy today; 5 rows blocked on credentials or http-only endpoints |
| Successful ingestion | PARTIAL | GTFS/GTFS-RT/JSON/GeoJSON/GBFS adapters exist and parse live data; no SIRI, NeTEx, XML or generic CSV adapter exists |
| Normalized data | PARTIAL | mobility_providers/operators/networks populated (89/7/4); provider_source_records = 0, rental_locations = 317 (Zelectra scooter stations) |
| Valid routing | PARTIAL | Lviv GTFS planner produced multimodal bus→tram (А47→Т08) and direct bus itineraries for service date 2026-11-12; both query cases hit the result limit (truncated) |
| Correct map presentation | PARTIAL | Freshness badge LIVE/STALE/OLD derived from position age; arrival predictions are provider-backed in 1 feed(s) and service alerts in 2 feed(s) (Lviv only); other cities carry none |
| Accurate availability status | PARTIAL | Unknown fare renders as — not 0; scooter legs are labelled estimates; seat/booking availability is NOT_MEASURED for every external feed |

## What this means for the 12-category promise

Measured, provider-backed data today supports **bus, trolleybus, tram, train (static), marshrutka (live positions only) and carpool (own marketplace)** — 6 of 12.
**Scooter** is estimate-grade with operator-declared city coverage. **Metro, bike, taxi, carsharing, transfer** have no working provider source right now: metro and Kyiv marshrutka geometry are blocked by a DNS-dead open-data portal, bike share has no Ukrainian network, and taxi/carsharing/transfer are waiting on credentials or agreements.
Presenting any of those four as available would require fabricating positions, prices or availability, which this project prohibits.
