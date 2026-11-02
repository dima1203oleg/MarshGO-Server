# GTFS objective-window sweep — 2026-10-23

## Purpose

Check whether enlarging the bounded objective-reservoir search window fixes the dense-Lviv GTFS truncation seen in the current Server candidate, while measuring winner stability, result diversity, runtime, and graph truncation. This is an offline diagnostic; it does not change production defaults or establish production readiness.

## Reproducibility

- Server candidate: `e7e695ee337f64af97679c283c3988dfe883c200` (PR #33 head at measurement time).
- Feed: frozen Lviv static GTFS archive `/private/tmp/marshgo-lviv-static-review-20261023.zip`.
- Feed SHA-256: `bb4ac0ce9127b4967ad889379f523b04b84a0bb033814aa8c844526b42078164`.
- Runtime: Node.js `v25.4.0`.
- Search date: `2026-10-23`; departure window `05:00–05:30Z`; max 2 transfers; 100 results.
- Objective windows: 25,000 / 50,000 / 100,000 search steps after each leg-count pool fills.
- OD pairs: Holosko–Sykhiv, Naukova–Sykhiv, Ploshcha Rynok–Dubliany.
- Every search returned 100 journeys and reported `searchTruncated=true`, `candidateGraphTruncated=true`, and `resultLimitReached=true`.

## Results

| OD | Window | Search steps | Runtime | Distinct route chains | Distinct trip chains | Fastest / cheapest / balanced winner changed? |
|---|---:|---:|---:|---:|---:|---|
| Holosko–Sykhiv | 25k | 101,827 | 1.93 s | 37 | 58 | baseline |
| Holosko–Sykhiv | 50k | 151,827 | 2.40 s | 39 | 58 | no |
| Holosko–Sykhiv | 100k | 237,772 | 3.59 s | 35 | 50 | no |
| Naukova–Sykhiv | 25k | 97,672 | 1.96 s | 42 | 54 | baseline |
| Naukova–Sykhiv | 50k | 147,672 | 8.73 s | 41 | 52 | no |
| Naukova–Sykhiv | 100k | 247,672 | 10.86 s | 38 | 50 | no |
| Ploshcha Rynok–Dubliany | 25k | 189,400 | 4.33 s | 32 | 58 | baseline |
| Ploshcha Rynok–Dubliany | 50k | 214,400 | 3.80 s | 32 | 57 | no |
| Ploshcha Rynok–Dubliany | 100k | 264,400 | 3.82 s | 31 | 55 | no |

The fastest, cheapest, and balanced winner IDs were identical across all three windows within each OD. Runtime is a single-run diagnostic, not a benchmark distribution; the Naukova timings show substantial variance and must not be treated as a latency SLO.

At the default 25k window, the segment graph already saturated its global 100,000-segment budget in all three ODs:

| OD | Retained segments | Candidate routes | Routes above budget | Overflow reservoirs retained / at cap | Search steps |
|---|---:|---:|---:|---:|---:|
| Holosko–Sykhiv | 99,054 | 70 | 70 | 6,522 / 31 | 101,827 |
| Naukova–Sykhiv | 91,036 | 32 | 9 | 4,800 / 24 | 97,672 |
| Ploshcha Rynok–Dubliany | 99,552 | 65 | 65 | 8,505 / 37 | 189,400 |

Unused allocated capacity in some routes does not remove the global graph bound: the feed-level query graph is still marked truncated, so enlarging only the later path-enumeration window cannot make the search exhaustive.

## Decision

Do **not** raise the production objective-window default based on this evidence. The larger window did not change the three objective winners, did not clear truncation, and generally reduced the number of distinct trip chains returned. It also increased work substantially on one OD. A higher constant is not a demonstrated fix.

The next engineering step should target the earlier, binding graph-retention stage: inspect why the query-specific candidate demand exceeds the global/per-route graph budgets, then improve the allocation/retention policy or use a bounded round-based search that preserves useful alternatives without materializing the full dense graph. Preserve the explicit truncation signal until exhaustive coverage or a separately justified completeness guarantee is established.

## Limitations

- Static archived feed only; no GTFS-RT replay, live provider probe, or production endpoint was involved.
- One date and one departure interval; service-calendar and time-of-day effects were not sampled broadly.
- The three selected ODs are useful dense-city diagnostics, not a representative citywide quality evaluation.
- Stable winners in a truncated candidate set do not prove globally optimal routes.
- No production configuration, deployment, external API, staging system, or physical device was changed or tested.
