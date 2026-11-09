# Lviv bus and marshrutka classification — candidate status

Updated: 2026-11-10 00:00 EET
Server candidate: `codex/lviv-feed-chain-20261109`, based on `449bc79a6ebfbc1eae2591ac5dd1353de8b98952`

## Evidence snapshot

The prior isolated import report for `https://track.ua-gis.com/gtfs/lviv/static.zip` reported 72 routes: 55 routes in the generic GTFS bus class, 9 trolleybus routes, and 8 tram routes. The supplied audit attributes CC BY 4.0 to the feed. These counts and license are historical audit evidence, not a fresh import or exact runtime identity. None of the 55 generic routes is thereby proven to be a conventional bus or a marshrutka.

## Candidate semantics

- Generic `route_type=3` without an explicit unambiguous service marker is emitted by journey search as `bus_unspecified`. It remains selectable through the canonical `bus` preference and is not selected by `marshrutka`.
- Extended GTFS `route_type=1501` maps to `marshrutka` in fixture tests. Exact type-1501 usage in the Lviv source has not been confirmed.
- Explicit terms `маршрутка`, `маршрутне таксі`, or `minibus` are retained as name evidence. The prior generic stem match for `маршрутн` was narrowed to avoid matching unrelated wording such as “маршрутний автобус”.
- Explicit Lviv trolleybus labels and `Тр` route identifiers remain separate from buses.

## Unfinished controls

No persistent `route_classification` table, provenance/review workflow, route-level evidence export, migration, or reimport has been implemented in this candidate. No route has been newly certified as a marshrutka. Classification, public-bus filtering, and GTFS mode regression fixtures passed in the 136-test targeted run; this is not live-feed verification. Status: `PARTIAL / FIXTURE_VERIFIED`.
