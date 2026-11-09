# Lviv transport coverage — evidence snapshot

Updated: 2026-11-09 22:43 EET. Candidate Server base: `449bc79a6ebfbc1eae2591ac5dd1353de8b98952`.

“Feed reported” means a source or earlier isolated import indicated data. It does not prove a feasible itinerary, live availability, booking, or rendered geometry.

| Canonical category | Current evidence | Candidate/runtime status |
|---|---|---|
| Carpool | MARSHGO offer search exists; no matching live offer verified in this check. | Candidate only reports the category when matching offers exist; no journey proven. |
| Marshrutka | No separate permitted Lviv feed verified. Generic type 3 is not enough to classify it. | `route_type=1501` and explicit name markers recognized; Lviv route not proven. |
| Bus | Earlier Lviv GTFS import reported 55 generic bus-class routes. | Journey type can remain `bus_unspecified`; exact trip not replayed. |
| Taxi | No connected Lviv quote/booking API verified. | No Lviv journey leg proven. |
| Tram | Earlier import reported 8 routes; shared registry has a tram entry. | Parser supports timetable legs; exact feasible itinerary/geometry not proven. |
| Trolleybus | Earlier import reported 9 routes; shared registry snapshot omitted trolleybus. | Existing classifier plus candidate stale-count fix; current runtime reimport not proven. |
| Metro | No metro in Lviv. | Not applicable in Lviv; retain category globally. |
| Train | Unofficial national GTFS schedule candidate exists; freshness and exact Lviv usefulness unverified. | No current Lviv route acceptance. |
| Bicycle | Static rental/network estimates may exist; live stock was not verified. | No live rental availability or accurate bicycle-road geometry proven. |
| Scooter | Zelectra snapshot checked earlier had no Lviv vehicles; Kyiv-only data is not local availability. | Candidate requires fresh local GBFS inventory/rules; unavailable in current evidence. |
| Carsharing | No connected Lviv fleet/booking API verified. | No Lviv journey leg proven. |
| Transfer | No connected Lviv quote/booking API verified; a catalog is not availability. | No Lviv journey leg proven. |

Current shared zrok provider snapshot is not build-pinned and listed Lviv bus/tram only. No feed or category is marked `LIVE_VERIFIED` by this document.
