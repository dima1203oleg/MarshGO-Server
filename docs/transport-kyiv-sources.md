# Kyiv transport sources

Audited against the Kyiv City open-data portal on 8 October 2026. The source adapters use the portal's HTTPS resource-download endpoints. Those endpoints currently redirect to the city's HTTPS GIS host; every redirect destination is revalidated as a public HTTPS URL before the server follows it.

| Mode | Kyiv source | Available data | State |
| --- | --- | --- | --- |
| Bus, tram, trolleybus | [Kyiv public transport GTFS](https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport) | Existing HTTPS GTFS mirror; the portal's original static export endpoint is HTTP-only | Static schedule/shape data; no Kyiv realtime enabled |
| Minibus (`marshrutka`) | [routeTaxi GeoJSON](https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport) | Segment geometry, route labels, direction and endpoint stop names | Static geometry; no realtime |
| Metro | [underground GeoJSON and station points](https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport) | Ordered segment geometry and 52 station points | Static geometry; no realtime |
| Kyiv City Express | [kyivCityExpress geometry and station points](https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport) | Segment geometry, directions and 34 platform points | Static geometry; no realtime |
| Funicular | [kyivFunicular geometry and station points](https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport) | Two directed line features and two station points | Separate `funicular` mode; no realtime |
| Shared bikes/scooters | GBFS registry candidate `3electra` | A public feed URL exists, but its listed system coordinates are in Lima and commercial reuse terms are unverified | Kept disabled as `REQUIRES_PARTNERSHIP` |
| Kyiv realtime vehicles | Kyiv GTFS-Realtime catalogue endpoint | Listed endpoint is HTTP-only on a raw IP address | Disabled as `insecure_endpoint` |
| Kyiv carsharing | No verified open Kyiv feed located | No supported public source | Not available; do not scrape private operator apps |

The Kyiv City portal states that its transport and station datasets may be used for personal or commercial purposes under its Open Data Licence. MARSHGO records that licence and source attribution in the provider registry. We do not enable feeds whose commercial terms or location coverage are unclear.

## Runtime behavior

- `geojson` sources are validated as GeoJSON FeatureCollections, normalized into the existing route/stop model and cached in process for up to six hours.
- Routes, stops and health are served by MARSHGO endpoints. The browser does not call Kyiv operator endpoints directly.
- Map requests remain viewport bounded; route, stop and vehicle filters remain separate.
- Registry states distinguish discovered, validated, enabled, temporarily unavailable, and partnership-required sources.
- Apply database migration `040_kyiv_geojson_providers.sql`, then run `npm run mobility:seed` to register and live-check the verified catalog. The seed command writes provider metadata and should be run in the intended environment by its operator.

## Limits of this integration

The newly enabled municipal GeoJSON resources supply map geometry and station locations. They do not supply a complete GTFS timetable, service calendar, transfer graph, or realtime positions. The portal publishes separate schedule tables, but MARSHGO has not yet normalized those tables into canonical departures or connected them to multimodal journey search. Until that work is complete, metro, City Express and funicular map layers must not be presented as routed live services.
