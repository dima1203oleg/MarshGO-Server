# Kyivpastrans GTFS source integration — 2026-11-15

## Change

The canonical seed catalog entry now uses the HTTPS mirror at `https://jbb.ghsq.de/gtfs/ua-kyiv.gtfs.zip`. The previous publisher export is HTTP-only and remains unsuitable as the configured production fetch URL. The existing GTFS parser and routing pipeline are unchanged. New provider rows are eligible for normal connection validation; the seed upsert intentionally preserves an existing disabled/paused admin decision, so this code change does not activate a previously disabled database row.

## Source evidence

- Publisher dataset: [Kyiv City Open Data — city electric and road transport timetable](https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport).
- The publisher page says the dataset is free for personal and commercial use under its Open Data Licence. The CKAN API currently has `license_id: null`, `license_title: null`, and `isopen: false`; this metadata conflict is retained here rather than relabelled as CC BY.
- On 2026-11-15, the official HTTP export and HTTPS mirror both returned HTTP 200 and 1,356,782 bytes. Their downloaded files were byte-identical: SHA-256 `28d888db5ff24dd16d0626c84dd93dd357e3017d29760ad9ed7922b15e58a24f`.
- The verified archive's `feed_info.txt` reported version `20261114`, `feed_start_date=20261114`, and `feed_end_date=20261115`. This is a rolling date-window feed with no publisher refresh SLA established by this probe.

## Product and safety limits

- This is a static schedule source. It does not establish current vehicle positions, trip updates, fares, booking, or Kyiv Metro schedules.
- The separate Kyiv GTFS-Realtime endpoint is HTTP-only and remains blocked as `insecure_endpoint`; it was not enabled by this change. Qoder's probe reported some realtime `trip_id` values do not join to static trips, so no trip-level vehicle attribution is claimed.
- Kyiv Metro's machine-readable endpoint remains unavailable in the source probe. No Metro schedule was added.
- Source reachability and byte parity do **not** prove database ingestion, refresh cadence, date-valid service, a feasible dated journey, or browser rendering. Those remain separate acceptance gates.

## Validation status

- Direct publisher export: `PROBED_OK` on 2026-11-15.
- HTTPS mirror: `PROBED_OK`, byte-identical to the publisher export on 2026-11-15.
- Commercial terms: publisher page explicitly states commercial use is permitted; CKAN metadata conflict is noted above.
- Seeded database state, provider health/activation, planner route search, UI display, and nationwide coverage: `NOT_TESTED` by this change.
- Production release: `NOT_RELEASED`.
