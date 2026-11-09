# Kyiv transport sources

The catalog entries below combine the portal's published metadata with feed probes. On 9 November 2026, Zelectra's GBFS endpoints responded; the Kyiv routeTaxi production GIS hostname did not resolve from the development Mac, so that feed still needs an environment-level health check before it can be marked live in MARSHGO. The routeTaxi adapter now targets the city's published production ArcGIS layer directly instead of following the portal download link's stage-host redirect.

| Mode | Kyiv source | Available data | State |
| --- | --- | --- | --- |
| Bus, tram, trolleybus | [Kyiv public transport GTFS](https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport) | Existing HTTPS GTFS mirror; the portal's original static export endpoint is HTTP-only | Static schedule/shape data; no Kyiv realtime enabled |
| Minibus (`marshrutka`) | [routeTaxi GeoJSON](https://data.kyivcity.gov.ua/dataset/7b958c05-43ba-4ae5-b541-01904d658030/resource/77325f5c-57d0-4f79-844a-cc73675f9743) · [production ArcGIS layer 1](https://gisserver.kyivcity.gov.ua/mayno/rest/services/KYIV_API/transport_public/MapServer/1) | Segment geometry, route number, direction, stop IDs/names and segment order | Static map geometry only; no timetable, realtime, live availability or booking |
| Metro | [underground GeoJSON and station points](https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport) | Ordered segment geometry and 52 station points | Static geometry; no realtime |
| Kyiv City Express | [kyivCityExpress geometry and station points](https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport) | Segment geometry, directions and 34 platform points | Static geometry; no realtime |
| Funicular | [kyivFunicular geometry and station points](https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport) | Two directed line features and two station points | Separate `funicular` mode; no realtime |
| E-scooters | [Zelectra GBFS v3.0](https://zelectra.rideatom.com/gbfs/66/v3.0/gbfs) | Live vehicle status, geofences, vehicle types and price plans; the feed contains locations outside Ukraine, so server snapshots must be country-filtered | Live feed verified 2026-11-09 13:12 UTC: 1,010 vehicle records, 8 types and 8 price plans. Attribution is required; booking remains a provider deep link and operator rental/return rules must still be honored. |
| Kyiv realtime vehicles | Kyiv GTFS-Realtime catalogue endpoint | Listed endpoint is HTTP-only on a raw IP address | Disabled as `insecure_endpoint` |
| Kyiv carsharing | No verified open Kyiv feed located | No supported public source | Not available; do not scrape private operator apps |

The Kyiv City portal states that its transport and station datasets may be used for personal or commercial purposes under its Open Data Licence. MARSHGO records that licence and source attribution in the provider registry. We do not enable feeds whose commercial terms or location coverage are unclear.

## Runtime behavior

- `geojson` sources are validated as GeoJSON FeatureCollections, normalized into the existing route/stop model and cached in process for up to six hours. ArcGIS `LineString` and disjoint `MultiLineString` parts are retained as separate paths so the map does not draw invented connectors.
- Routes, stops and health are served by MARSHGO endpoints. The browser does not call Kyiv operator endpoints directly.
- Map requests remain viewport bounded; route, stop and vehicle filters remain separate.
- Registry states distinguish discovered, validated, enabled, temporarily unavailable, and partnership-required sources.
- Ensure the mobility-provider migrations are applied, then run `npm run mobility:seed -- --kyiv-route-taxi-zelectra` in the intended staging environment to register/update only these two sources and perform the server-side checks. The seed command writes provider metadata and should be run by the environment operator; it has not been run against production or the current local database.
- Zelectra discovery and vehicle/type/price feeds were reachable in the read-only probe. The current live vehicle inventory is not a booking confirmation or an assurance that every returned point lies in Kyiv; the planner filters coordinates to Ukraine and applies the provider's geofence rules.

## Limits of this integration

The municipal routeTaxi GeoJSON supplies map geometry and route/stop metadata, but no departures, service calendar, realtime positions, seats, or booking. It may be shown as a route layer; it must not by itself be presented as a scheduled or bookable leg in multimodal journey results. The portal publishes separate schedule tables, but MARSHGO has not normalized those tables into canonical departures. The same timetable limitation applies to the metro, City Express and funicular geometry layers.
