# MARSHGO Admin та Partner — уточнене технічне завдання

Версія 1.1 · 14 жовтня 2026 · Статус: реалізація P0 розпочата

## 1. Мета та межі

Створити два адаптивні вебклієнти для операційної роботи MARSHGO: внутрішню систему Admin і кабінет транспортних організацій Partner. Обидва клієнти використовують **той самий `MarshGO-Server`**, його існуючу авторизацію, PostgreSQL/PostGIS, Redis та API. У P0 не створювати нову систему входу, окрему базу, мікросервіси, платіжний контур чи копію диспетчерської.

Порядок доставки:

| Етап | Результат | Умова приймання |
|---|---|---|
| P0 Foundation | Організації, заявки, членства, server-side authorization, Admin review, адаптивні shells | Партнер подає заявку; Admin схвалює; член бачить лише свої організації; непартнер не бачить кабінет |
| P1 Operations | Invitations, підключення провайдерів, provider health/sync UI, замовлення та state machine | Усі дії організації перевіряють membership, статус і право на модуль |
| P2 Commercial | Agreements, commission ledger, settlements, advanced analytics | Юридична/платіжна модель погоджена; суми походять з підтверджених записів |

Розділи, що потребують зовнішнього договору, ключа або налаштованої доставки повідомлень, лишаються `BLOCKED_EXTERNAL`; UI не імітує їхню роботу.

## 2. Канонічні репозиторії

- `MarshGO-Server` — авторизація, API, схеми/міграції, аудит, provider registry та доменна логіка.
- `MarshGO-Admin` — інтерфейс внутрішніх адміністраторів.
- `MarshGO-Partner` — інтерфейс усіх транспортних організацій з конфігурованими модулями.
- `MarshGO-Site` і `MarshGO-iOS` залишаються клієнтами пасажирів/водіїв; не переносять у себе партнерську бізнес-логіку.
- `MarshGO` — релізна оркестрація та міжрепозиторні перевірки.

Admin і Partner — окремі deployable applications, але не окремі backend-и. Новий GitHub-репозиторій вважається створеним лише після підтвердженого GitHub URL і push commit.

## 3. Канонічна предметна модель

Не ототожнювати організацію, перевізника, провайдера, джерело даних і підключення.

```text
User ──< OrganizationMembership >── Organization ──< ServiceModule
                                      │
                                      ├──< PartnerApplication
                                      ├──< ProviderConnection >── ProviderSource / Operator
                                      ├──< Fleet / Vehicle (P1)
                                      └──< PartnerOrderLink (P1)
```

- **Organization** — юридична/операційна компанія; один партнер може мати кілька видів послуг.
- **Membership** — роль конкретного користувача в одній організації. Користувач може мати memberships у кількох компаніях.
- **Service module** — запитаний/дозволений вид діяльності; не означає наявність API або інвентарю.
- **Provider source** — зовнішній фід/API/каталог; може представляти багато перевізників.
- **Operator** — компанія, що фактично надає транспорт.
- **Provider connection** — налаштування та стан доступу організації до джерела; секрети зберігаються поза відкритими JSON-полями.
- **Application** — заявка організації з окремим станом розгляду та історією рішення.

Комісії, валові бронювання, виручку перевізника й дохід MARSHGO зберігати та показувати як різні метрики. Приватні попутки й надалі мають комісію 0%.

## 4. Доступ та ізоляція

Використовувати наявні `sessions`, `user_roles` і bearer/refresh flow Server. Не створювати окремий JWT realm чи клієнтський admin secret.

- Admin endpoint-и перевіряють серверну роль `admin` (пізніше — гранулярні platform permissions); приховування кнопок у браузері не є контролем доступу.
- Partner endpoint-и отримують `userId` лише з автентифікованої сесії та перевіряють `organization_memberships` для кожного запиту.
- Не приймати роль, applicant user, власника, статус, суму чи ID зв’язків із клієнта без серверної перевірки.
- Tenant-запити мають включати `organization_id` **і** автентифікований `user_id` у SQL, а не завантажувати об’єкт і сподіватися на frontend-фільтр.
- Для стороннього/недоступного organization ID повертати однакове `404`, щоб не розкривати існування організації.
- Suspended membership або organization не може виконувати операційні дії; заявник може читати лише свій onboarding стан.
- Критичні переходи виконуються транзакційно, блокують рядок `FOR UPDATE`, перевіряють допустимий попередній стан і створюють `audit_events` у тій самій транзакції.
- Точні GPS-координати, API secrets, договірні документи та фінансові дані не потрапляють у загальні списки, логи чи аналітику без потрібної ролі.

Початкові ролі Partner: `organization_owner`, `organization_admin`, `dispatcher`, `fleet_manager`, `finance_manager`, `technical_manager`, `viewer`. P0 надає owner лише автору нової заявки. Запрошення та делегування ролей переходять у P1, доки не налаштовано безпечний канал доставки запрошень.

Початкова роль Admin використовує існуючий `user_roles.role='admin'`; не створювати публічний шлях самопризначення цієї ролі. MFA, гранулярні platform permissions і процес break-glass — окремий production security gate.

## 5. Стани та переходи

Organization: `PENDING_REVIEW → ACTIVE | REJECTED`; `ACTIVE → SUSPENDED`; відновлення зі `SUSPENDED` потребує окремої аудійованої дії. `ACTIVE` означає схвалення організації, але не означає, що API, фід, бронювання чи dispatch уже готові.

Application: `SUBMITTED → UNDER_REVIEW | NEEDS_INFORMATION | APPROVED | REJECTED`. Рішення про схвалення/відмову та зміна organization status атомарні. Повторне схвалення, відхилення чи блокування з недопустимого стану повертає `409`.

Інтеграція має незалежні виміри:

1. Доступ: потрібен ключ / договір / sandbox / production permission.
2. Технічний стан: не перевірена / здорова / degraded / помилка / вимкнена.
3. Тип даних і можливості: static, live, catalog, quote, booking, tracking тощо.

`PRODUCTION` може встановлювати лише підтверджена конфігурація після successful health/contract validation; сама наявність URL чи ключа цього не доводить.

## 6. API P0 та конвенції

Префікс: `/api/v1`. Успіх має `data`; помилка використовує чинний error envelope з `code`, `message`, `requestId`.

| Метод і шлях | Доступ | Призначення |
|---|---|---|
| `POST /partner/applications` | автентифікований користувач | Створити organization, application, owner membership і requested modules атомарно |
| `GET /partner/me` | автентифікований користувач | Список власних активних memberships та їхніх onboarding станів |
| `GET /partner/organizations` | автентифікований користувач | Лише організації, де є активне membership |
| `GET /partner/organizations/:id` | член організації | Деталі лише після серверної перевірки membership |
| `GET /partner/organizations/:id/permissions` | член організації | Обчислені сервером permissions; зручність UI, не заміна авторизації дій |
| `GET /admin/dashboard` | Admin | KPI лише з наявних БД записів; null/відсутні домени не маскувати нулями |
| `GET /admin/partners` | Admin | Пагінація, пошук, фільтр стану, обмеження розміру сторінки |
| `POST /admin/partners/:id/approve` | Admin | Атомарно схвалити заявку та активувати організацію |
| `POST /admin/partners/:id/reject` | Admin | Відхилити заявку з аудійованою приміткою |
| `POST /admin/partners/:id/suspend` | Admin | Призупинити активну організацію з причиною |

Не використовувати довільний `PATCH status`. Існуючий `/admin/mobility/providers` лишається канонічним реєстром джерел мобільності; партнерські організації не дублюють цей реєстр.

P1 endpoint-и для invitations, connections, orders, fleet, sync/test і finance вводити лише разом із відповідними схемами, tenant permission checks, аудитом та contract tests. Не оголошувати їх реалізованими за самим записом у цьому документі.

## 7. Інтерфейси

### Admin P0

- Огляд реальних лічильників заявок/партнерів/провайдерів.
- Таблиця заявок із пошуком, фільтром, пагінацією, порожнім/помилковим станами.
- Перегляд транспортних джерел через існуючий Admin mobility API.
- Дії approve/reject/suspend мають підтвердження, пояснення і результат з API.
- Не показувати замовлення, дохід, GPS або графіки, поки відповідний домен не доступний.

### Partner P0

- OTP вхід через наявний MARSHGO auth.
- Onboarding заявка та список/деталі власних організацій.
- Показ стану перевірки, запитаних модулів і dispatch mode.
- До схвалення показувати статус і довідковий чекліст, але не робочі кнопки операцій.
- Показувати активованими лише функції, що реально підключені й дозволені.

Обидва клієнти — українською, з доступністю WCAG 2.2 AA як ціллю, підтримкою клавіатури/reduced motion, mobile/tablet/desktop layout та явними loading/empty/error states. Вони мають бути різними продуктовими оболонками на спільних токенах, а не двома окремими кодовими версіями для mobile і desktop.

## 8. Інтеграції та секрети

Інтеграції під’єднувати через наявний Provider Integration Gateway / адаптери. Перед реалізацією зафіксувати офіційну документацію, права показу/кешування/бронювання, credential status і контрактну відповідь. Provider API failures ізолюються від інших провайдерів.

- Токени не віддавати frontend-клієнтам, не записувати в логи, не зберігати відкрито в `jsonb`.
- P0 не створює live GPS, цін, бронювань, комісій чи payout fixture у production.
- API ключі можуть передаватися лише server-to-server через захищене збереження; UI бачить `configured: true/false`, ніколи саме значення.
- Webhooks мають підпис, timestamp window, idempotency/dedupe і tenant/provider binding до обробки payload.
- Платні API, бронювання, скасування та виплати не запускаються автоматично в тестах.

## 9. Дані, міграції та експлуатація

Міграції адитивні, повторно застосовні згідно з чинним runner, з FK/CHECK/індексами. Не змінювати/видаляти користувацькі дані та не додавати production seed. Базові tenant-таблиці індексуються за `organization_id`, `user_id`, status і timestamps; геометрія — GiST лише якщо геоколонки з’являться.

Усі значущі події мають актора, entity ID, час і мінімальний metadata без PII/secrets. Audit log append-only на рівні застосунку; виправлення/retention визначити політикою, не редагувати історію мовчки.

Frontend env: тільки публічний API origin. Backend secrets лишаються у deployment secret store. CORS allowlist і refresh cookie конфігурація мають явно включати фактичні домени Admin/Partner до релізу. Перед staging — міграція на ізольованій копії; production migration має rollback/forward-fix plan і backup.

## 10. Тести та acceptance

Обов’язкові для P0:

- unit: всі role/status комбінації та state transitions;
- API/integration: заявка створює рівно одну org, membership owner, requested modules і audit event у транзакції;
- security: інший користувач отримує 404 на tenant detail; suspended/rejected membership не отримує доступ; user без Admin ролі не може читати чи змінювати admin ресурси;
- concurrency: два рішення модерації не можуть одночасно перевести ту саму заявку у різні стани;
- frontend: OTP/refresh, порожній стан, помилка API, admin approval, partner onboarding, mobile navigation/overflow;
- CI: format/lint, typecheck, unit, build, Playwright smoke, dependency audit.

Тести з БД запускаються тільки на loopback `marshgo_e2e` або ізольованому CI DB. Перевірити `DATABASE_URL` до запуску. Не запускати setup, який перестворює довільну чи production БД.

Acceptance P0 вимагає API + UI + реального auth flow + tenant isolation tests; скриншот або мокап окремо не є доказом. P0 не дорівнює production-ready: перед production потрібні MFA/platform role policy, домени/CORS/cookies, secret vault, monitoring, backups, privacy/legal review, ручний acceptance і підтверджена deployment target.

## 11. Звітність

Для кожного репозиторію зафіксувати URL, гілку, commit, PR і CI. Для кожного функціонального пункту використовувати `IMPLEMENTED_AND_TESTED`, `IMPLEMENTED_NEEDS_FIX`, `PARTIAL`, `BLOCKED_EXTERNAL`, `NOT_STARTED`. Не називати skipped тест успішним, не плутати branch preview зі staging/production і не стверджувати, що репозиторій/домен створений без перевірки.
