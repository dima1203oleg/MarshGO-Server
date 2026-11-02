
## Fresh dense Lviv replay — 2026-10-25

| Requirement | Evidence | Status | Boundary / next step |
|---|---|---|---|
| Search preserves complete dense-feed coverage and useful results under bounded execution | Audit 145 replay: 1,197 ms, 100 returned/800 retained, 11,475 explored steps, stop-selection/search-budget/candidate-sampling all truncated; no comparable fares. | FAIL / OPEN | Keep incomplete state visible. Design baseline-preserving alternative discovery and validate exact chain/winner parity over frozen multi-OD replays. |
| Geometry and stop-time validity for returned results | Audit 145: 329/329 returned segments had correct geometry endpoints and chronological stop times. | PASS (local fixture-backed current-feed replay) | Node 25.4.0; repeat exact candidate on declared Node 24.21.0 and staging before release. |
