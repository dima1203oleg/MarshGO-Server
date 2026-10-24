# GTFS temporal-retention paired replay — 2026-10-24

## Setup

- Baseline engine: `1c08a98dfe93224eb06cb8562bab2c9e64054573`.
- Candidate engine: `9e4a9524762526ec6210ef4d45889a0bb059b06a` (`fix(gtfs): retain temporally connecting segments`).
- Both executed with Node `v24.21.0` and the same replay harness contract, serialized baseline/candidate pairs, three runs per OD.
- Static Lviv GTFS downloaded from the publisher URL `https://track.ua-gis.com/gtfs/lviv/static.zip`; SHA-256 verified as `bb4ac0ce9127b4967ad889379f523b04b84a0bb033814aa8c844526b42078164`, matching the frozen archive previously used. The producer URL and CC-BY-4.0 attribution metadata are listed by the [official Lviv open-data resource](https://data.gov.ua/dataset/lviv-public-transport-gtfs-real-time/resource/eb31a65b-a22b-44b1-83ce-41add24ae652).
- Query: 2026-10-23 05:00–05:30 UTC, max 2 transfers, 900 m access / 1,000 m egress / 400 m transfer walk, 180 s transfer buffer, 4 h max wait, 100-result cap.
- Winner IDs are derived using actual journey duration for FASTEST, confirmed UAH fare for CHEAPEST, and the shared `scoreJourneys(..., 'BALANCED')` implementation for BALANCED. These replay values are winners within the returned bounded set, not globally optimal results.

## Results

| OD | Baseline / candidate trip chains | Baseline / candidate route chains | Median runtime baseline → candidate | Strategy winners preserved? | Ordered result hashes baseline → candidate |
|---|---:|---:|---:|---|---|
| Holosko → Sykhiv | 58 → 59 | 37 → 38 | 2,007.00 → 2,241.79 ms (+11.70%) | No: FASTEST, CHEAPEST, BALANCED all changed | `698e0e7538b5f0b9c0645ffdffd75be039ef921a2ebb79feb928237b29b6dd6f` → `6a6c4a1ab31ef22b42c13d50a05b7cba2fb9a3d95c52a841cfee2c1924124ce6` |
| Naukova → Sykhiv | 57 → 56 | 40 → 40 | 1,576.75 → 1,601.78 ms (+1.59%) | Yes: all three | `d60392aed4e68af3d4c2e9f8a5df3340344ded578624d9d912a4e31c40607d86` → `122d3247c00d5f03732f96f458572c9e490e341d37f3023c189c8c98b20bb63c` |
| Rynok → Dubliany | 58 → 57 | 32 → 32 | 2,728.81 → 2,679.25 ms (-1.82%) | Yes: all three | `49a674a48b073e16e9eeab97fc550aaf015473d2e961f5118822470d60beadf8` → `12ce90fbd1ebc394c0eae6ebd581814051de341f17079494f1d4306b0786eb9c` |

The sum of per-OD median runtimes is 6,312.56 ms baseline and 6,522.82 ms candidate (+3.33%). The ordered result hash and chain counts were identical across all three repetitions within each version. This is a small, serialized, single-machine comparison; RSS/heap samples were noisy and are not used to claim a memory change.

Every run returned 100 results and reported both `searchTruncated=true` and `candidateGraphTruncated=true`. The candidate changes the result set for all three ODs, improves chain counts only for Holosko→Sykhiv, loses a trip chain on each other OD, and changes all three selected objective candidates for Holosko→Sykhiv. Stable repeats confirm the effect is deterministic, not a one-run fluctuation.

## One-query stage diagnostic

A separate, single debug replay of Holosko→Sykhiv on the candidate (not part of the timing comparison) reported 415,997 estimated graph candidates against a 100,000-segment graph budget. It built 99,063 segments, leaving 937 budget slots unused; 41 of 70 routes reached their allocated cap and 31 overflow reservoirs reached their 200-segment cap. The routing traversal stopped at 122,500 search steps with 1,469 candidate results, including 1,422 two-/three-leg results, and set `searchBudgetTruncated=true` and `candidateSamplingTruncated=true`; it did not hit the 1,000,000 hard search-step ceiling. This narrows where to profile next but is one OD and one run, so it is not a population-wide performance claim.

## Decision

**Reject this candidate as a routing-completeness or release fix.** The targeted dense-feed regression fixture passes and the exact transfer check remains authoritative, but the 3-OD evidence fails the promotion gate: strategy winners are not preserved for every OD, alternatives decrease on two ODs, aggregate median runtime regresses, and truncation remains. Keep the commit isolated as an experiment; do not merge it into the release line or remove truncation disclosure.

## Next engineering step

Inspect route-budget allocation and per-route bounded trip-group replacement against the baseline with the exhaustive small-feed oracle. Design a retention change that preserves all three baseline strategy winners on these frozen ODs, improves useful-chain recall on more than one OD, and does not regress aggregate runtime materially. Repeat the same 3× paired replay before promotion. Avoid tuning a global search window: previous evidence shows the earlier graph budget, not the downstream search-step cap, is binding.
