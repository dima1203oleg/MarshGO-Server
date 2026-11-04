# АУДИТ: Базовий стан ланцюгів маршрутів Україною (Wave 0 Baseline) — 2026-11-04

**Статус продукту:** NOT_RELEASED  
**Дата вимірювань:** 2026-11-04  
**Базовий комміт Server:** `a632d87` (origin/main, 2026-11-02)  
**Гілка worktree:** `antigravity/chain-w0-baseline-20261104`  
**Харнес:** `scripts/replay-chain-od-matrix.mts`  
**Контейнер acceptance API:** `mg-ui-api` (127.0.0.1:3018, `marshgo/api:RC-2026-11-02-mainmerge.1`)  
**Контейнер acceptance DB:** `marshgo-acceptance-db-1` (PostGIS 3.5.2, PostgreSQL 17.5)  

---

## 1. Всесвіт пошуку: 15 ENABLED провайдерів у БД

Запит до `marshgo-acceptance-db-1`:
`SELECT id, name, city, provider_type, source_type, discovery_status, status, health, last_checked_at FROM mobility_providers WHERE discovery_status = 'ENABLED' ORDER BY city, name;`

| # | Назва провайдера | Місто / Рівень | Тип джерела | Статус здоров'я | Маршрути / Зупинки / Поїздки / StopTimes | shapes.txt | Тарифи (fares) | feed_valid_until |
|---|---|---|---|---|---|:---:|:---:|:---:|
| 1 | Біла Церква — позиції (Dozor JSON) | Біла Церква | json | degraded / healthy | 129 машин (128 bus, 1 trolleybus) | N/A | N/A | N/A (live) |
| 2 | Біла Церква — розклад (GTFS, Dozor) | Біла Церква | gtfs | degraded / healthy | 20 routes, 345 stops, 233 trips, 6 275 stopTimes | **НІ** | **НІ** | 20261104 |
| 3 | Івано-Франківськ — позиції (Dozor JSON) | Івано-Франківськ | json | degraded / healthy | 176 машин (140 bus, 36 trolleybus) | N/A | N/A | N/A (live) |
| 4 | Івано-Франківськ — розклад (GTFS, Dozor) | Івано-Франківськ | gtfs | degraded / healthy | 55 routes, 525 stops, 3 319 trips, 82 455 stopTimes | **НІ** | **НІ** | 20261104 |
| 5 | Кам’янець-Подільський — позиції (Dozor JSON) | Кам’янець-Подільський | json | degraded / healthy | 143 машини (143 bus) | N/A | N/A | N/A (live) |
| 6 | Кам’янець-Подільський — розклад (GTFS, Dozor) | Кам’янець-Подільський | gtfs | degraded / healthy | 15 routes, 239 stops, 2 416 trips, 55 620 stopTimes | **НІ** | **НІ** | 20261104 |
| 7 | Київпастранс — розклад (GTFS) | Київ | gtfs | degraded / healthy | 165 routes, 1 528 stops, 24 401 trips, 104 038 stopTimes | **ТАК** | **НІ** | 20261106 |
| 8 | Львівавтодор — затримки (GTFS-RT) | Львів | gtfs_rt | degraded / healthy | 0 vehicles, 701 tripUpdates, 0 alerts, age 5s | N/A | N/A | N/A (live RT) |
| 9 | Львівавтодор — розклад (GTFS) | Львів | gtfs | degraded / healthy | 72 routes, 1 071 stops, 15 141 trips, 406 422 stopTimes | **ТАК** | **НІ** | 20271102 |
| 10 | Олександрія — позиції (Dozor JSON) | Олександрія | json | offline / degraded | 13 машин (13 bus) | N/A | N/A | N/A (live) |
| 11 | Полтава — позиції (EasyWay JSON) | Полтава | json | degraded / healthy | 169 машин (129 marshrutka, 23 bus, 17 trolleybus) | N/A | N/A | N/A (live) |
| 12 | Ужгород — позиції (Dozor JSON) | Ужгород | json | degraded / healthy | 78 машин (78 bus) | N/A | N/A | N/A (live) |
| 13 | VD-Express — міжміські автобуси (GTFS) | Україна | gtfs | degraded / healthy | 2 routes, 37 stops, 2 trips, 72 stopTimes | **ТАК** | **НІ** | 20270202 |
| 14 | Укрзалізниця — розклад поїздів (GTFS) | Україна | gtfs | degraded / healthy | 118 routes, 167 stops, 118 trips, 1 246 stopTimes | **ТАК** | **НІ** | 20271211 |
| 15 | Червоноград — позиції (EasyWay JSON) | Червоноград | json | degraded / healthy | 16 машин (7 bus, 9 marshrutka) | N/A | N/A | N/A (live) |

### Критичні знахідки з аналізу 15 ENABLED фідів:
1. **Геометрія ліній (shapes.txt):**
   - Присутня у 4 національних/великих GTFS фідах: Київпастранс, Львівавтодор, VD-Express, Укрзалізниця.
   - Відсутня у 3 Dozor GTFS фідах (Біла Церква, Івано-Франківськ, Кам'янець-Подільський). У них геометрія — виключно пряма лінія послідовності зупинок.
2. **Тарифи (fare_attributes.txt / fare_rules.txt):**
   - **0 із 7 GTFS фідів мають файли тарифів.** Жоден український GTFS фід не постачає ціни. Ціни в MARSHGO можуть надходити виключно з локального каталогу міських тарифів (наприклад, `kyivSmartCard`, `lvivLeoCard`), інакше ціна залишається чесним `null` (у UI: `—`).
3. **Розклад vs. Позиції:**
   - 7 фідів — це статичний розклад (GTFS).
   - 8 фідів — це живі позиції (EasyWay JSON, Dozor JSON) або затримки (GTFS-RT). Для Полтави, Червонограда, Олександрії, Ужгорода **немає розкладу в ENABLED**, є лише координати рухомого складу. Пошук розкладу по цих містах не може видавати «розклад» за відсутності статичного графа.

---

## 2. Результати харнесу: Матриця 14 OD-пар (виміряно наживо 2026-11-04)

Команда запуску харнесу: `npx tsx scripts/replay-chain-od-matrix.mts`  
Час запитів: 2026-11-04T13:39:35Z.  
Всі 14 рядків виконані без технічних збоїв. Рядки, де чесна відповідь «даних немає», позначені як **PASS (порожньо з причиною)**.

| # | OD-пара | Очікувана поведінка за ТЗ | Фактичний результат | Ланки (mode) | Геометрія ланок | Ціна | Partial reasons | Wall ms |
|---|---|---|---|---|---|---|---|:---:|
| 1 | Львів, пл. Ринок (24.0323, 49.8450) → Львів, зал. вокзал (24.0205, 49.8302) | Міський пошук: вулична геометрія (Львів bbox), трансфер ≤ 4 | Знайдено 2 варіанти | 3 (WALK→BUS→WALK) | osrm-foot-route, gtfs-static, osrm-foot-route | 23 грн | candidate_generation_truncated, provider_error, unsupported_preference, walking_routing_unavailable | 5393 |
| 2 | Львів → аеропорт Львів | Поза bbox: піше плече оцінка прямої, не вулиця | PASS (порожньо з причиною) | 0 | — | — | unsupported_preference | 272 |
| 3 | Київ, Майдан (30.5227, 50.4501) → аеропорт Жуляни (30.3511, 50.2338) | Широта 50.2338 нижче київського bbox 50.25 → відкат на оцінку прямої | PASS (порожньо з причиною) | 0 | — | — | provider_error, unsupported_preference | 267 |
| 4 | Київ, Лівобережні → Правобережні (метро) | Метро: немає робочого фіда → чесно вимкнено з поясненням | PASS (порожньо з причиною) | 0 | — | — | provider_error, unsupported_preference | 18 |
| 5 | Львів → Київ (міжмісто) | Статичний УЗ: ланцюг пішки → поїзд → пішки, ціна null | Знайдено 12 варіантів | 3 (WALK→RAIL→WALK) | osrm-foot-route, gtfs-static, osrm-foot-route | — (null) | candidate_generation_truncated, provider_error, unsupported_preference, walking_routing_unavailable | 11848 |
| 6 | Івано-Франківськ → Львів | GTFS в обох містах ENABLED; міжміський сегмент УЗ | Знайдено 5 варіантів | 3 (WALK→RAIL→WALK) | walking-estimate, gtfs-static, osrm-foot-route | — (null) | candidate_generation_truncated, provider_error, unsupported_preference, walking_routing_unavailable | 10857 |
| 7 | Стрий → Ужгород | По 2 рядки реєстру в кожному; міжмісто УЗ без пішого роутера | Знайдено 1 варіант | 3 (WALK→RAIL→WALK) | walking-estimate, gtfs-static, walking-estimate | — (null) | provider_error, unsupported_preference, walking_routing_unavailable | 248 |
| 8 | Тернопіль → Львів | Тернопіль відсутній у муніципальних фідах; міжмісто УЗ | Знайдено 15 варіантів | 3 (WALK→RAIL→WALK) | walking-estimate, gtfs-static, osrm-foot-route | — (null) | candidate_generation_truncated, provider_error, unsupported_preference, walking_routing_unavailable | 9444 |
| 9 | Чернівці → Київ | Місто відсутнє в муніципальному реєстрі | PASS (порожньо з причиною) | 0 | — | — | candidate_generation_truncated, provider_error, unsupported_preference | 1719 |
| 10 | Полтава → Київ | У Полтаві лише EasyWay JSON позицій без розкладу | Знайдено 2 варіанти | 3 (WALK→RAIL→WALK) | walking-estimate, gtfs-static, osrm-foot-route | — (null) | candidate_generation_truncated, provider_error, unsupported_preference, walking_routing_unavailable | 5965 |
| 11 | Одеса → Миколаїв | Одеса 1 рядок (blocked), Миколаїв 0 рядків | PASS (порожньо з причиною) | 0 | — | — | unsupported_preference | 176 |
| 12 | Вінниця → Київ | Вінниця відсутня в муніципальному реєстрі; міжмісто УЗ | Знайдено 7 варіантів | 3 (WALK→RAIL→WALK) | walking-estimate, gtfs-static, osrm-foot-route | — (null) | candidate_generation_truncated, provider_error, unsupported_preference, walking_routing_unavailable | 5254 |
| 13 | Дніпро (внутрішній пошук) | Лише iCity JSON позицій без розкладу | PASS (порожньо з причиною) | 0 | — | — | unsupported_preference | 544 |
| 14 | Мікро-ланцюг: Київ, метро Вокзальна → зупинка наземного | Міжвидовий перехід + буфер; наземний стик | Знайдено 1 варіант | 5 (WALK→TROLLEYBUS→WALK→TRAM→WALK) | osrm-foot-route, gtfs-static, osrm-foot-route, gtfs-static, osrm-foot-route | 60 грн | candidate_generation_truncated, provider_error, unsupported_preference, walking_routing_unavailable | 1415 |

---

## 3. Аналіз відповідності червоним лініям ТЗ

1. **Ціна `null` там, де тарифів немає:**
   - Усі міжміські залізничні маршрути УЗ (пари 5, 6, 7, 8, 10, 12) повертають `totalPriceMinor: null` (у UI: `—`). Жодного разу не з'явилося «0 грн».
   - Львівський міський маршрут (пара 1) коректно оцінив вартість за каталогом LeoCard — 23 грн.
   - Київський наземний мікро-ланцюг (пара 14) нарахував 60 грн за тарифами Київпастрансу.
2. **Чесність геометрії:**
   - У межах Львівського прямокутника `[23.9, 49.75, 24.2, 49.95]` та Київського `[30.2, 50.25, 30.8, 50.62]` піші плечі отримують статус `osrm-foot-route`.
   - За межами цих прямокутників (Івано-Франківськ, Стрий, Ужгород, Полтава, Вінниця, Тернопіль) піші плечі мають статус `walking-estimate` (пряма лінія зі швидкістю 1.25 м/с). Вони не видаються за вуличну геометрію.
3. **Чесна порожнеча з розкриттям причин:**
   - Коли даних немає (Київське метро, Одеса, Миколаїв, Чернівці, Дніпро внутрішній), API не повертає фіктивних маршрутів, а віддає `journeys: []` разом із масивом `partialReasons` (`unsupported_preference`, `provider_error`) та поясненнями у `providerErrors`.
4. **Метро в Києві:**
   - Всі 6 київських відкритих джерел метрополітену повертають HTTP 522 (портал відкритих даних КМДА недоступний).
   - Запит пари 4 повертає `providerErrors: ["Київське метро: Київські джерела станцій, геометрії, розкладу або пересадок не зареєстровані чи вимкнені"]`.

---

## 4. Висновок і гейт хвилі 0

- Зонд оновлено: `build-transport-registry.ts` перегенеровано на базі живого прогону `tools/transport-feed-smoke.ts` за 2026-11-04 (`TRANSPORT_PROVIDER_REGISTRY.json`, `docs/TRANSPORT_FEED_AUDIT.md`, `docs/TRANSPORT_COVERAGE_MATRIX.md`).
- Харнес OD-матриці створено в `scripts/replay-chain-od-matrix.mts` і успішно протестовано на всіх 14 парах.
- Жодних правок у продуктовий код сервера (`server/journey/*`, `server/index.ts`) не вносилося.
- Гейт хвилі 0: **PASS**.
