# Lviv bus and marshrutka feed separation

Updated: 2026-11-10
Candidate base: `f61993013e5abf6fbf6afca96bc6eda3d0ff1c27` (`origin/main` at start of work)

## Registered source

- Lviv has one open shared static GTFS source at `https://track.ua-gis.com/gtfs/lviv/static.zip`, plus GTFS-Realtime trip-update and vehicle-position endpoints.
- The catalog does not configure a distinct marshrutka URL. Bus and marshrutka records in this shared feed must be separated using route metadata; never create a fake second provider by duplicating the same URL.
- A route-only download was checked on 2026-11-10 from the registered static URL: HTTP 200, 3,568,789 bytes, `Last-Modified: 2026-11-02 08:06:59 GMT`, SHA-256 `45b8c8613b0ae40ae22f703c5e29011413a6baeabeaea6d0dc5b676a18f6bc64`. `routes.txt` contained 72 rows: 55 route_type=3 records with no explicit bus/minibus name marker, 9 explicitly named trolleybuses, and 8 trams. No route_type=1501 or explicitly named marshrutka was present in this snapshot. This is current schedule metadata evidence, not proof that no marshrutkas operate in Lviv.
- An additional EasyWay route/GPS integration requires approved partner access. No EasyWay endpoint or credentials are enabled here.

## Classification contract

- Base GTFS `route_type=3` is a bus class and does not by itself distinguish a city bus from a marshrutka. See the [GTFS route reference](https://gtfs.org/documentation/schedule/reference/).
- `route_type=1501` is the extended Communal Taxi Service type; Google lists marshrutka as an example. It is a valid marshrutka marker for a route that also has usable GTFS schedule data. See [Google's extended route types](https://developers.google.com/transit/gtfs/reference/extended-route-types).
- For generic `route_type=3`, only explicit route-name markers such as `маршрутка`, `маршрутне таксі`, or `minibus` select the marshrutka category. Explicit bus names select bus; ambiguous names remain `bus_unspecified` in journey results and are never selected by a marshrutka-only preference.
- Explicit trolleybus labels and `Тр` route identifiers remain trolleybuses.
- A GeoJSON provider is assigned to the marshrutka layer only when its provider name explicitly identifies `routeTaxi`, `minibus`, or a marshrutka phrase. Generic wording such as “автобусні маршрути” and “маршрутний автобус” must not classify the whole feed as minibuses.

## Verification status

Code-level separation is implemented and covered by fixtures; a fresh route-only snapshot was inspected as recorded above. The official open-data portal lists a city-wide static GTFS and realtime resources, while this app catalog has no distinct open marshrutka URL. The 55 unmarked `route_type=3` routes must remain bus-class/unresolved for the narrower bus-vs-marshrutka distinction and must not leak into marshrutka-only results. No live marshrutka itinerary or route-by-route operational vehicle-class verification was performed. Do not claim that a separate marshrutka feed is connected or that every bus-class route is a conventional full-size bus.
