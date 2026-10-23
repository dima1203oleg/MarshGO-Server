# Перевірка придатності окремих GTFS-Realtime VehiclePositions — 2026-10-23

## Зміна

Базовий Server SHA: `14b3abfa29baa90b84d4d0d9d61b51604dac7f1d`.

`testGtfsRealtimeConnection()` раніше перевіряв свіжість лише `FeedHeader.timestamp`. Цей час не доводить, що окремі позиції машин свіжі. Додано `summarizeRealtimeVehiclePositions()`, яка окремо рахує сутності з машинами, валідні координати, свіжі/застарілі позиції, відсутній timestamp і відсутні/некоректні координати. Якщо feed має vehicle entities, джерело буде `healthy` лише коли кожна така сутність має валідні координати й свіжий індивідуальний timestamp за спільним порогом 90 секунд / 30 секунд clock skew. TripUpdate-only чи Alert-only feed не знижується лише через відсутність машин.

## Перевірки

- Нові unit tests: 3/3 PASS (свіжа, застаріла, без часу та некоректна позиція; update-only feed; повністю свіжий fleet).
- Повний Server unit suite: **304 PASS / 0 FAIL / 3 opt-in integration SKIP**.
- TypeScript typecheck: PASS.
- ESLint: PASS.
- Локальна версія Node під час перевірок: `v25.4.0`; Server вимагає Node `24.21.0`, тому Node parity ще має підтвердити exact-head hosted CI.

## Read-only live зріз

Повторний виклик exact Server-коду через публічні Dozor та Львівавтодор URL приблизно о 00:44 UTC. Жодні provider-конфігурації чи БД не змінювалися.

| Місто | Vehicle entities | Валідні позиції | Індивідуально свіжі | Застарілі/без часу | Результат перевірки |
|---|---:|---:|---:|---:|---|
| Рівне | 2 | 2 | 1 | 1 stale | DEGRADED |
| Івано-Франківськ | 8 | 8 | 5 | 3 stale | DEGRADED |
| Ужгород | 5 | 5 | 3 | 2 stale | DEGRADED |
| Львів | 0 | 0 | 0 | 0 | DEGRADED: endpoint свіжий, але порожній |

Це одиничний часовий зріз, а не SLA або гарантія покриття. Фід може містити придатні свіжі машини навіть зі статусом `degraded`; клієнт і так має фільтрувати кожну позицію за timestamp.

Додатковий route/trip crosswalk на Івано-Франківськ у тому самому вікні: статичний GTFS exact parser завантажив 280 stops / 19 routes / 1,928 trips; серед 5 свіжих позицій 5 route IDs мали відповідність GTFS route, але 0 vehicle trip IDs зіставилися з GTFS trips. Це не дозволяє підтвердити напрямок/розклад кожної машини лише з цього feed. Два інші перевірені Dozor static feeds (Рівне, Ужгород) exact Server parser відхилив через відсутню валідну `agency_timezone` і відсутню підтверджену найближчу послугу. Потрібні правильні operator feeds або виправлена metadata; часова зона не вгадується.

## Обмеження приймання

Це code + live-feed diagnostic improvement, не перевірка побудови карти, staging або production. Потрібні exact-head hosted CI, live route/trip/direction crosswalk, map manifest, staging origin та браузерний acceptance.
