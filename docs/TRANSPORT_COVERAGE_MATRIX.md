# MARSHGO — 12-MODE TRANSPORT COVERAGE MATRIX

**Generated:** 2026-11-12T02:11:53.837Z · **Product status:** NOT_RELEASED
**Artifact source:** SELECT-only mobility_providers.last_report after mobility:seed
**Evidence rule:** Capabilities describe dated measurements in the supplied artifact, not current runtime availability. Undated counts remain diagnostics only.

A static network is not a current timetable or a successful journey. Unknown vehicle types are not counted as buses. No verified city list means insufficient evidence, not proof that the category is absent from Ukraine.

| Transport category | Verified product routing | Dated static-network evidence | Dated typed fresh-position evidence |
|---|---|---|---|
| Автобуси | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Маршрутки | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Тролейбуси | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Трамваї | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Метро | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Поїзди/електрички | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Попутки | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Самокати | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Велосипеди | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Таксі | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Каршеринг | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |
| Трансфери | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED |

## Acceptance chain per requirement

| Stage | Status | Evidence |
|---|---|---|
| Source probe | PARTIAL | 36 non-skipped result rows; 0 dated measurements; 52 skipped |
| Persistence and runtime eligibility | NOT_MEASURED | No database snapshot supplied |
| Valid routing and completeness | NOT_MEASURED | Feed probe does not execute product journey acceptance |
| Map rendering and navigation | NOT_MEASURED | Requires browser and device evidence |
| Pricing, availability and booking | NOT_MEASURED | No transactional acceptance evidence supplied |

## What this means for the 12-category promise

All 12 categories remain subject to separate provider, runtime and end-to-end verification. No overall production-readiness or nationwide coverage claim follows from this artifact.
