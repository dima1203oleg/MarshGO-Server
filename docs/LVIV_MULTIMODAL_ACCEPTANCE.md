# Lviv multimodal acceptance — candidate checklist

Updated: 2026-11-10 00:00 EET. Server branch `codex/lviv-feed-chain-20261109`; base SHA `449bc79a6ebfbc1eae2591ac5dd1353de8b98952`.

## Candidate behavior

- **Implemented:** select GTFS feeds using corridor coverage rather than cached per-mode route counts; the current parser and selected-mode filter decide whether an itinerary exists.
- **Implemented:** preserve `bus_unspecified` as a neutral leg while allowing the public bus preference to select it, never the marshrutka preference.
- **Implemented:** bounded rental-to-transit composition can query selected timetable modes rather than requiring Metro; nearby transfer stops are capped at two per endpoint and 8 km.
- **Implemented:** require fresh, available scooter inventory near pickup and valid network/geofence rules; no Lviv scooter is represented as available without evidence.
- **Implemented:** carpool coverage is based on matching corridor offers, not unconditional category registration.

## Local evidence

- Server base: `449bc79a6ebfbc1eae2591ac5dd1353de8b98952` (`origin/main` at validation start).
- Targeted fixture command: `npm exec --yes --package=node@24.21.0 -- ./node_modules/.bin/tsx --test tests/gtfs-search-worker.test.ts tests/gtfs-timetable.test.ts tests/journey-search.test.ts tests/micromobility-estimates.test.ts tests/mobility.test.ts tests/provider-coverage.test.ts tests/search-completeness-indicators.test.ts` — **136 passed, 0 failed, 0 skipped**. The run preceded only a nullish snapshot-default guard and tuple type annotations; `typecheck` and changed-file ESLint passed after those edits.
- `npm exec --yes --package=node@24.21.0 -- npm run typecheck` — **passed** after the final local edits.
- ESLint on all changed Server and test files — **passed**.
- `git diff --check` — **passed**.
- This is deterministic fixture evidence, not a live Lviv feed replay, running API check, or staging acceptance.

## Acceptance cases and evidence

| Case | Status | Required evidence |
|---|---|---|
| Generic bus type 3 | FIXTURE_VERIFIED | Neutral `bus_unspecified` remains selectable as public bus and is not labeled marshrutka. |
| Extended type-1501 shared taxi | FIXTURE_VERIFIED | Maps to marshrutka in fixtures; exact type use in the Lviv source remains unverified. |
| Bus-to-tram composition | FIXTURE_VERIFIED | Checked-in worker fixture composes a bus leg to tram; not a live Lviv replay. |
| Trolleybus connector-stop discovery | FIXTURE_VERIFIED | Nearby stops are exposed for a trolleybus fixture; a full trolleybus chain was not tested. |
| Bicycle/scooter + transit | NOT_TESTED | No full rental-to-transit journey with provider inventory, valid pickup/return, street geometry, and provenance was tested. |
| `maxTransfers=0` | NOT_TESTED | Direct-only behavior still needs an explicit regression case. |
| FASTEST / CHEAPEST / BALANCED | FIXTURE_VERIFIED | Small-feed oracle and all three ranking winners passed in the selected test set; no live-feed ranking comparison. |
| Truncation | FIXTURE_VERIFIED | Bounded-search and completeness-indicator fixtures passed; current live Lviv truncation flags were not replayed. |
| Exact Lviv feed, all selected modes and returned geometry | NOT_TESTED | Requires a pinned feed snapshot and unified API replay. |

Database/integration tests, exact live Lviv planner replay, visual acceptance, and performance comparison remain NOT_RUN. No database or running service was modified.
