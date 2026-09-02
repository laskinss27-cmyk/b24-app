# Полное SQL-чтение перемещений снаба — подготовка 2 сентября 2026

## Граница change set

Изменение подготовлено, проверено локально и 2 сентября развёрнуто в production.
После успешной стадии `shadow` backend переключён на
`B24_APP_SUPPLY_SQL_READ=verified`: при точном совпадении с живым реестром
карточки перемещений для расчёта `/api/supply/orders` восстанавливаются из SQL.
При stale/mismatch/error режим автоматически сохраняет старый Bitrix response.

Нормализованный graph mirror сам по себе не содержит всей пользовательской
карточки. Специализированный canonical payload закрывает эту переходную потерю
и позволяет доказать эквивалентность ответа. Независимый прямой режим `sql`
по-прежнему запрещён: текущий `verified` ещё читает живой Bitrix для сверки, а
все рабочие write-paths пока не переведены на транзакционные SQL-записи.

## Подготовленная модель

Migration `0022_create_supply_transfer_payloads.sql` создаёт специализированную
таблицу `supply_transfer_payloads`, привязанную к `workflow_documents`. Она хранит
канонический `TransferData` одного живого Bitrix transfer, его display name,
external ID, точное время mirror observation и SHA-256. Это не универсальное
хранилище произвольного JSON и не копия ERPNext: ERP stock/accounting data
по-прежнему читаются и изменяются только официальным API.

Mirror plan теперь:

- требует один полный payload для каждой живой Bitrix transfer-записи;
- сверяет число payloads с полной cardinality исходного реестра;
- проверяет совпадение ID, статуса, deal, основных строк и складов с
  нормализованным graph document;
- включает payload hashes в детерминированный plan hash;
- блокирует apply при неполной или противоречивой payload-модели.

Writer записывает graph и transfer payloads одной транзакцией перед checkpoint.
Reader выбирает payloads только по точному `observed_at` последнего checkpoint,
восстанавливает `TransferData`, повторно считает SHA-256 и fail-closed завершает
чтение при повреждении JSON, identity или hash.

## Переходный режим `verified`

Локально добавлен opt-in `B24_APP_SUPPLY_SQL_READ=verified`. Это ещё не отказ от
Bitrix24. На каждом запросе backend сначала читает полный живой реестр Bitrix,
затем сравнивает его с SQL, включая полное состояние карточек. Только при точном
совпадении дальнейший расчёт `/api/supply/orders` получает объекты,
восстановленные из SQL. При stale checkpoint, mismatch, пропущенной записи,
повреждённом payload или недоступной MariaDB ответ автоматически остаётся на
Bitrix. Порядок документов также сохраняется по живому реестру.

Таким образом, `verified` проверяет реальное формирование ответа из SQL, но ещё
не уменьшает зависимость от Bitrix. Независимый SQL source switch потребует
отдельного runtime write/dual-write этапа с idempotency и transaction recovery.

## Проверки

- focused migration/planner/writer/reader/shadow suite: `57/57`;
- полный backend suite: `351/351`;
- frontend suite: `129/129`;
- workspace typecheck: успешно;
- backend и production frontend build: успешно (остаётся прежнее предупреждение
  Vite о chunk больше 500 kB);
- одноразовая MariaDB `11.8.8`: migration, повторный migration no-op,
  транзакционный writer, checkpoint/read parity, rollback и запреты DDL/DELETE
  для DML-only user — успешно;
- временный MariaDB container после проверки удалён.

## Production deployment 2 сентября 2026

Перед DDL standalone backup `20260902_130703-b24_app-database.sql.gz` прошёл
gzip/checksum, внешний Bitrix Disk read-back и изолированный restore drill.
Source и restore совпали по schema hash
`a1d03731d7cd09262ba5a454ce59fcfdb187fec01ee0738c3f52a1a6cba569d1`
и data hash
`220d86ec244c824c75c4e2234981286c4468fe27176b7a54778a2623de3af1d4`.
Два более ранних safety dump (`130543` и `130620`) также сохранены: первый
остановился на дополнительной проверке относительного checksum path, второй
успешно прошёл внешний read-back, но restore runner отклонил формат имени
изолированной БД до её создания. Retention и удаление backup-файлов не
запускались.

One-shot migrator применил ровно
`0022_create_supply_transfer_payloads.sql` с checksum
`8106e8a2985ede895edd631c94a43ba7a92dd920aeaba23832ba6d1a877138a0`;
повтор вернул `No pending migrations`. Затем image `b24-app:ecc37d4` заменил
backend с сохранением прежнего контейнера как
`b24-backend-prev-before-ecc37d4`. Effective env, `/srv/b24-state`, локальный
порт и public URL были получены из работавшего контейнера. Новый backend имеет
restart `0`, policy `unless-stopped`, подключён к `erpnext_frappe_network`; оба
health, readiness `database/reservations: up` и официальный ERPNext read
успешны.

Owner-authorized dry-run получил полный plan
`e306a97fcc490e3c28d34690e502d5a30ad1506e27f5386d56a6e63fb1dc10a6`:
источники `665 ERP / 182 transfers / 14 transfer requests`, итог
`862 documents / 1582 lines / 890 links / 1188 allocations`, `0` errors и
`22` historical warnings. DML-only backfill применил только этот hash одной
транзакцией; точный повтор in-memory plan вернул no-op. SQL latest slice имеет
те же counts и `182` полных payload, orphan counts `0|0|0|0`. Runtime identity
имеет только schema-level `SELECT`; migration/backfill credentials отсутствуют
в backend env.

Root-only audits mode `0600`:

- `/root/b24-app-audits/20260902T131657Z-supply-full-payload-dry.json`, SHA-256
  `c9bc09ac9d7fbc9248ebcc92b992a1d2c47df29c4f49431c117946665dbd0e32`;
- `/root/b24-app-audits/20260902T131723Z-supply-full-payload-apply.json`, SHA-256
  `60df8ea8f86ff5c7487ff952ebce2cb02d214566f5f99d11aed024bb8c7eb474`;
- `/root/b24-app-audits/20260902T132049Z-supply-runtime-shadow-postcheck.json`,
  SHA-256
  `99e981d032c731bf29db78a208a7c5981e7b1477eff8852894973bc0f43c1e44`.

Независимый runtime postcheck заново прочитал живые источники через точного
владельца, загрузил checkpoint постоянным read-only SQL user и получил полный
`match`, `0` differences. Проверка request-level resolver также дала `match`,
но ожидаемо сохранила `responseSource=legacy` и
`legacyResponsePreserved=true`: `verified` не включён.

После записи backup `20260902_131829-b24_app-database.sql.gz` размером `353058`
bytes содержит `18` таблиц, прошёл checksum/gzip, внешний read-back и restore
drill. Source/restore hashes:
`21cb366a5a341371832005f70cc5ba65a70d59c0029cbf3c6cb5825f28454751`
(schema) и
`aa0c07b4c5f82ab7dc781028c4f90741e5e00a1df508eebe6400f5c28bd60a28`
(data). Временная restore schema удалена штатным guarded cleanup; backup и
rollback сохранены.

## Production switch на `verified`

Первый pre-switch gate корректно остановил переключение: live plan успел
измениться с `e306…10a6` на
`8f8af8fe66fc6895137607ddbb9a2385421d987b7374b2226adb80a2a4a8fb56`,
и comparator нашёл `42` differences при `0` source errors. До SQL write создан
backup `20260902_133752-b24_app-database.sql.gz` (`18` tables), прошедший
checksum/gzip, внешний read-back и полный restore parity; retention не
запускался.

Свежий owner plan с источниками `669 ERP / 183 transfers / 14 transfer requests`
построил `867 documents / 1594 lines / 893 links / 1191 allocations`, `0`
errors и `22` historical warnings. DML-only runner применил точный hash одной
транзакцией, повтор стал no-op, payload cardinality `183`, post-apply match `0`
differences. После этого реальный `/api/supply/orders` в `shadow` вернул HTTP
`200`, `99` orders, а backend log подтвердил `responseSource=legacy`.

Config-only switch изменил только `B24_APP_SUPPLY_SQL_READ=verified` в effective
env того же image `b24-app:ecc37d4`. Перед switch прошёл canary с read-only
state. Предыдущий shadow-контейнер сохранён как
`b24-backend-prev-before-verified-20260902-1340`. Новый backend имеет restart
`0`, policy `unless-stopped`, `/srv/b24-state:/app/state`, порт
`127.0.0.1:3000` и обязательную сеть `erpnext_frappe_network`.

Первый реальный verified request вернул HTTP `200`, те же `99` orders; log дал
`status=match`, `responseSource=sql`. Сырые JSON hashes shadow/verified
различались из-за порядка ключей. Поэтому сохранённый shadow был отдельно
поднят как временный read-only canary, а оба endpoint вызваны одновременно с
одним owner OAuth context. После рекурсивной сортировки object keys ответы
получили одинаковый canonical SHA-256
`1a0a57a59916e44f5a33aadd9ebac36302dfdf35c4e2dd5a2c43322000fdcd7f`;
оба вернули `99` orders. Логи одновременно подтвердили `legacy` у shadow и
`sql` у verified. Canary удалён.

Post-switch backup `20260902_134425-b24_app-database.sql.gz` (`354939` bytes,
`18` tables) прошёл checksum/gzip, внешний read-back и restore parity. Его
schema/data hashes:
`298f513e9ba8c0d2d77aa8d91c247443898af782482a2f9553a9f099914a0742` и
`9e26992402022618144aee47bcc3070a88fefa5a28a44eb4636d22b5c59f96e9`.
Temporary restore schema удалена, backup и оба rollback-контейнера сохранены.
Финальная проверка: internal/public health, readiness database/reservations,
официальный ERP read, runtime `SELECT` only, current checkpoint counts, network
и restart зелёные; с момента switch `0` fallback и `0` application errors.

Новые root-only audits mode `0600`:

- refresh: `/root/b24-app-audits/20260902T133817Z-supply-refresh-before-verified.json`,
  SHA-256 `79713bb44d7858d96bbdabade3c4927ae6bc750bb9d8a81095f332c6bbc45468`;
- shadow request: `/root/b24-app-audits/20260902T133837Z-supply-shadow-real-request.json`,
  SHA-256 `3da217ed4d025efc8cffac9ca61d125d645cc7036a65594b320202ed12076602`;
- verified request: `/root/b24-app-audits/20260902T134105Z-supply-verified-real-request.json`,
  SHA-256 `657c5059e1af4135424af74683542bb0e17699c01f18ced54b636a9116f1662e`;
- canonical comparison:
  `/root/b24-app-audits/20260902T134329Z-supply-shadow-vs-verified-response.json`,
  SHA-256 `c27c10ec821824d8598f59a521b55cbb3af5ac6168fcbc1ea70ccbd5c537ae36`;
- final check:
  `/root/b24-app-audits/20260902T134603Z-supply-verified-final-check.txt`,
  SHA-256 `6c8123d217db9944d032fcc61e3e7d6262f15f6eabacdc1594ccdba80f38267f`.

## Следующая архитектурная граница

Для фактического отказа от Bitrix JSON как источника требуется отдельный change
set и отдельное разрешение:

1. спроектировать нормализованные SQL tables для изменяемого состояния transfer,
   его фаз, history/comment/task references и idempotency keys;
2. перевести create/update/status paths на один транзакционный SQL writer с
   контролируемой совместимостью или dual-write;
3. доказать recovery после частичного отказа и обратимый rollback;
4. только после длительной parity убрать обязательное live Bitrix read из
   `verified`. Существующие JSON-записи не удалять: оставить архивом до отдельной
   команды и подтверждённого срока хранения.
