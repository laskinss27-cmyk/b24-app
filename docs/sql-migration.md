# Поэтапное внедрение `b24_app` в MariaDB

## Статус и граница текущего этапа

На 2026-08-21 выполнены этап 0, schema/readiness-фундамент этапа 1, read-only моделирование и первый неавторитетный supply mirror этапа 2. Runtime commit `147f876` развёрнут в `B24_APP_DB_MODE=readiness` с отдельным credential и только `USAGE + SELECT`; `/ready` выполняет `SELECT 1`. Ручные one-shot runners применили `0001`-`0005`, а отдельно разрешённый DML-only process записал `516` документов, `1002` строки, `527` связей, `716` allocations и один checkpoint. Runtime workflow эти строки не читает и не пишет.

Read-only production preflight, фактические network/backup результаты и следующий change set записаны отдельно: [sql-preflight-2026-08-20.md](sql-preflight-2026-08-20.md). Реальные связи и минимальная модель первого модуля зафиксированы в [read-only аудите снаба](sql-supply-domain-audit-2026-08-20.md).

`b24_app` пока **не является источником данных**. Без production env безопасным default остаётся `B24_APP_DB_MODE=off`; текущий явно разрешённый production mode — `readiness`. Приложение открывает ограниченный pool только для dependency probe, не запускает миграции или mirror при старте и не меняет текущие workflow чтения/записи. Первый snapshot создан внешним one-shot process исключительно как mirror evidence. Исправленная пагинация Bitrix24 из `f3ae38e` остаётся рабочим fallback.

Owner-only `POST /api/admin/sql-migration/supply/dry-run` сейчас развёрнут в image `147f876`. Он строит только отчёт и детерминированный hash плана и не подключается к `b24_app`; writer присутствует в image как неактивный модуль без HTTP/startup вызова. ERPNext читается исключительно `GET /api/resource` без `ensure/setup` helpers; `ctv_transfers` и `ctv_tr_requests` читаются OAuth-токеном владельца с защищённой пагинацией. Ошибка/403 Bitrix, неполный JSON, stale request key, неоднозначная строка, отсутствующая ссылка или quantity evidence делают `readyToApply=false`, а не превращаются в пустой реестр.

Второй production dry-run прочитал все три источника полностью, получил 505 documents / 991 lines / 508 links / 705 allocations и 35 errors вместо 64. Все ожидаемые 29 ложных blockers standalone/manual исчезли без новых issue; остались 24 проявления пяти исторических transfer gaps, семь line mismatches и четыре stale revisions. Точный отчёт записан в [журнале dry-run](sql-supply-backfill-dry-run-2026-08-20.md); workflow SQL tables остались пустыми.

Третий production dry-run на `dbd7b3c` сохранил те же кардинальности и получил 40 errors / 0 warnings. Дополнительный официальный ERP read объяснил результат: все 12 references пяти исчезнувших transfer принадлежат отменённым Stock Entry `docstatus=2`, поэтому submitted-only tombstone gate правильно отказал. Follow-up `c9a3c0b` развернул отдельную canceled-evidence ветку. Четвёртый dry-run получил ожидаемые 510 documents / 991 lines / 520 links / 705 allocations, 11 errors и 12 warnings: все 29 historical errors устранены без придуманных строк, production SQL остаётся 4 migration rows и 0 domain rows.

Пятый production dry-run на `b799329` сохранил 510 documents / 991 lines / 520 links / 705 allocations и подтвердил узкую historical-line модель: 5 прежних line errors стали `historical_source_line_unavailable` warnings без allocations. Остались 6 errors (2 live `missing_line_match` + 4 `stale_request_key`) и 17 warnings. Production log подтвердил один запрос; SQL по-прежнему содержит 4 migration rows и 0 domain rows.

Read-only [аудит четырёх stale revisions](sql-supply-stale-request-audit-2026-08-20.md) показал одну старую удалённую версию `MAT-MR-2026-00002`: canceled receipt и три canceled Stock Entry не имеют пересечения SKU с новой draft-заявкой, созданной под тем же именем. Перепривязка по имени запрещена. Узкий planner change сохраняет исторические документы как evidence, исключает две ложные links canceled receipt к текущим request/PO и оставляет только доказанные links Stock Entry к canceled transfer tombstone. Focused `26/26`, полный backend `212/212` и typecheck успешны; change развёрнут в `9b6b80c` без SQL DML.

Шестой production dry-run на `9b6b80c` полностью прочитал ERPNext `392`, `ctv_transfers` `110`, `ctv_tr_requests` `5` и получил 510 documents / 991 lines / 518 links / 705 allocations. Четыре stale revision errors стали явными warnings, две ложные links исчезли. Остались 2 live `missing_line_match` errors и 20 historical warnings, поэтому `readyToApply=false`. Независимый post-check подтвердил 4 migration rows и 0 domain rows.

Седьмой production dry-run на `4579048` получил те же 510 documents / 991 lines / 518 links / 705 allocations, 0 errors и 22 historical warnings. Две последние связи доказаны как старые app-canceled draft PO с точными request keys; document links сохранены, line allocations не придуманы. `readyToApply=true` означает паритет read-only плана, а не разрешение на запись. Post-check снова подтвердил 4 migration rows и 0 domain rows.

21 августа подготовлен [атомарный supply mirror writer](sql-supply-mirror-writer-2026-08-21.md) и append-only migration `0005` для checkpoint. Реальная изолированная MariaDB 11.8 проверка подтвердила DDL, idempotency, update, rollback и запрет DDL/`DELETE` для DML-only user. После safety backup, отдельного credential, `0005` и post-DDL restore drill writer source развёрнут в объединённом `740403a` без HTTP apply route. Затем отдельным явно разрешённым one-shot process применён свежий план `181e72d285b576b9b22c00993d88eb9451ceb10f669bfcc2366a4e2cf35d02e6`: SQL содержит `516|1002|527|716` graph rows, один checkpoint и 5 migration rows; точный повтор был no-op, orphan counts нулевые. Post-apply dump `20260821_090845-b24_app-database.sql.gz` прошёл внешний read-back и точный изолированный restore parity. Source switch не выполнялся.

Развёрнутый `147f876` добавил к [read-only reader и parity comparator ручной endpoint](sql-supply-shadow-read-2026-08-21.md). Reader берёт последний checkpoint и фильтрует каждую graph table по его `observed_at`; comparator даёт статусы `match`, `mismatch`, `plan_blocked` и `no_snapshot` и ограничивает детали отчёта. `POST /api/admin/sql-migration/supply/shadow-compare` требует точного владельца, runtime SQL mode `readiness` и отдельный `B24_APP_SUPPLY_SHADOW_COMPARE=on`; production default подтверждён как `off`. Endpoint не имеет scheduler, не вызывается пользовательским workflow, не получает write credential и отклоняет параллельный полный scan.

После активации зашифрованного owner OAuth vault первый production compare корректно показал устаревший checkpoint. Отдельно разрешённый второй mirror refresh применил полный plan `22ad151b5f2881b525d84c687583bcd23948dbc18f66219734f8091abda0f831` (`552/1064/563/753`, sources `425/119/5`, `22` warnings) ограниченным DML-only user; повтор был no-op, orphan counts нулевые. Post-apply backup, внешний read-back и изолированный restore дали полную parity, после чего второй shadow compare вернул точный `match` с `0` differences. SQL всё ещё не является source of truth; production shadow flag остаётся `off`, пользовательские чтения/записи и fallback не переключались.

31 августа выполнен следующий [production mirror refresh](sql-supply-mirror-refresh-2026-08-31.md). Append-only migration `0008` устранила конфликт стабильного внешнего line ID с изменяемым ordinal, сохранив fallback-уникальность для строк без внешнего ID. Свежий план `b411ebc943c19724a5c902a132efd381d5002c55f1b1d7bb72c5ea5259a57826` (`823/1516/847/1130`, sources `634/174/13`, `0` errors, `22` warnings) применён атомарно и повторён как no-op. Backup/restore совпали по checksums всех восьми таблиц, а независимый shadow compare вернул `match` с `0` differences. Физические append-only counts больше latest-среза из-за сохранённых исторических строк; reader по-прежнему фильтрует все graph tables по точному `latest.observed_at`. Runtime остался readiness-only, source switch не выполнялся.

2 сентября выполнен ещё один [production mirror refresh](sql-supply-mirror-refresh-2026-09-02.md) после серии изменений рабочего приложения. Owner-authorized план `a2de30d3237ca438c2e96fdb29665e0897eed8d279b0bcf567ed2659e4207fd7` (`862/1582/890/1188`, sources `665/182/14`, `0` errors, `22` warnings) применён одной транзакцией и повторён как точный no-op. Независимый compare дал `match` и `0` differences, orphan counts `0/0/0`; pre/post backups прошли внешний read-back, а post-apply restore совпал по детерминированным row hashes всех `17` таблиц. `B24_APP_SUPPLY_SQL_READ=off`, source switch и production config не менялись.

[Read foundation](sql-supply-read-foundation-2026-08-31.md) добавляет только opt-in `off|shadow` проверку покрытой transfer-проекции. 2 сентября production переключён на `B24_APP_SUPPLY_SQL_READ=shadow` без смены image; первый реальный `/api/supply/orders` сохранил legacy HTTP-ответ и дал SQL `match` для `182/182` transfers с `0` differences. Полный режим `sql` намеренно отсутствует, потому что текущая mirror schema ещё не хранит UI-поля карточки, историю и action facts. Bitrix/ERPNext fallback остаётся источником пользовательского ответа.

## Текущая source-of-truth matrix

| Область | Текущий источник правды | Физическое хранение и связи | Текущий риск |
|---|---|---|---|
| пользователи, права, OAuth, сделки, контакты, компании | Битрикс24 | CRM REST и пользовательские поля | доступность портала и права текущего пользователя |
| задачи, уведомления, файлы ремонтов, Disk | Битрикс24 | задачи CRM; у ремонта в JSON хранится ссылка на файл | внешняя ссылка и REST-доступность |
| каталог, SKU, цены, склады, фактические остатки | ERPNext | `Item`, `Item Price`, `Warehouse`, `Bin`, `Stock Ledger Entry` | только официальный REST; прямой SQL запрещён |
| план сделки и варианты | ERPNext | `Sales Order`, связанный с внешним Bitrix deal ID | Bitrix ID — внешняя ссылка |
| складские проводки | ERPNext | `Delivery Note`, `Purchase Receipt`, `Stock Entry`, `Stock Reconciliation` | истинный остаток меняет только проведённый документ |
| заявка снаба | ERPNext | `Material Request` и её строки; связь со сделкой в custom field | прогресс вычисляется повторным объединением нескольких реестров |
| заказ поставщику и приёмка | ERPNext | `Purchase Order` и `Purchase Receipt`; custom fields заявки/ключа | связь частично выводится из полей и строк |
| перемещения приложения | Битрикс24 + ERPNext | `ctv_transfers.DETAIL_TEXT` хранит workflow JSON и имена ERP `Stock Entry`; проводки — ERPNext | полное сканирование entity store, связь не нормализована |
| ручные заявки на перемещение/снаб | Битрикс24 | `ctv_tr_requests.DETAIL_TEXT`, ссылки на transfer/task | JSON без локальных ограничений ссылочной целостности |
| инвентаризация | Битрикс24 + ERPNext | `ctv_inv.DETAIL_TEXT`: документ, точки и замороженный snapshot; итоговые документы — ERPNext | вся инвентаризация обновляется одной JSON-записью |
| ремонты | Битрикс24 + ERPNext | `ctv_repairs.DETAIL_TEXT`: workflow, история, deal/task/file refs и имена ERP-документов; физическое движение — ERPNext | JSON и повторные entity reads |
| старые партии реализаций | Битрикс24 | `ctv_realize`, используется как legacy-память для сделок | legacy-зависимость сохраняется до отдельной миграции |
| договоры | filesystem backend | `/app/state/contracts/**`: DOCX и JSON metadata; номера в `/app/state/contract-sequences.json` | отдельный volume и атомарные файловые записи |
| шаблоны матрицы | filesystem backend | `/app/state/assortment-matrix/templates.json` | отдельный файловый source of truth |
| конструктор отчётов | filesystem backend | `/app/state/report-builder/<ownerId>.json` | изоляция по владельцу реализована в коде |
| operation log | filesystem backend | `/app/state/operation-log/events.jsonl` | ограниченный журнал, не полный аудит workflow |
| блокировки и кэши | память процесса | locks снаба/перемещений/инвентаризации, кэши каталога, реализаций и имён | исчезают при restart и не координируют несколько replicas |
| сопоставление и проекция товаров Tilda | `b24_app` хранит identity; остаток всегда ERPNext | 177 SQL mappings: 134 confirmed, 43 ignored; Tilda содержит одностороннюю проекцию 132 обратимых остатков | one-time parity подтверждён; scheduler пока отсутствует, 2 unlimited строки не затрагиваются |

Инвентаризационный snapshot намеренно заморожен при создании. Движения после открытия компенсируются пользователем в пересчёте; будущая SQL-модель обязана хранить исходный snapshot неизменным и не заменять его текущим остатком ERPNext.

## Явный граф снаба

Текущий логический граф, который сначала нужно зеркалировать без изменения поведения:

```text
Bitrix deal
  -> ERP Material Request (заявка снаба, request name + immutable request key)
  -> ERP Purchase Order (заказ поставщику)
  -> ERP Purchase Receipt (приёмка)
  -> Bitrix ctv_transfers workflow (перемещение)
  -> ERP Stock Entry (отправка/приёмка/коррекция)
  -> ERP Delivery Note (реализация)
```

Production baseline подтвердил граф: 54 заявки связаны с 89 перемещениями, 78 заказами поставщикам и 54 приёмками; на одну заявку приходится до 7 перемещений, 9 закупок и 13 transfer/purchase документов суммарно. Одна заявка и одна закупка могут иметь несколько строк и downstream-документов. Поэтому будущая связь не должна кодироваться одним nullable foreign key в `documents`: нужны отдельные `document_links`, `document_lines` и количественные line allocations с внешней системой, внешним ID и стабильным ключом строки.

Семь `missing_line_match` проверены отдельным [read-only аудитом](sql-supply-line-mismatch-audit-2026-08-20.md). Две ошибки находятся в живых draft order/request связках и остаются fail-closed blockers. Пять относятся к проведённым/отменённым downstream-документам: явная document link доказана, но соответствующая строка исчезла из текущего source. Развёрнутый узкий change set сохраняет такие links и возвращает warning без line allocation только по документированным terminal/age/evidence условиям; production dry-run подтвердил ожидаемое поведение.

## Минимальная будущая схема домена

Read-only аудит снаба сузил и локально зафиксировал первый DDL change set из четырёх one-statement migrations:

- `workflow_documents`: тип, внешний статус/docstatus, внешняя система и ID, deal ID, source timestamps, observed time/hash;
- `workflow_document_lines`: внешний child-row key, SKU, план/request/fact quantity и nullable склад строки;
- `workflow_document_links`: направленная типизированная связь между документами;
- `workflow_line_allocations`: количественная связь строк для split между несколькими закупками, приёмками и перемещениями.

`workflow_events`/business idempotency относятся к этапу 4. Узкий технический `supply_mirror_checkpoints` подготовлен локально вместе с управляемым writer и хранит только hash/cardinalities/timestamps, без JSON payload и scheduler. Общий `sync_jobs` пока не добавляется. Точные поля, ограничения и relation types перечислены в [аудите домена](sql-supply-domain-audit-2026-08-20.md).

Отдельно от workflow-каркаса будущей интеграции Tilda нужна специализированная таблица `tilda_product_mappings`, а не новый файл в `/app/state`. Минимальные поля-кандидаты: уникальные `tilda_uid` и `tilda_external_id`, `tilda_sku`, nullable внешние ссылки `erp_item_code`/`erp_product_id`, `mapping_status` (`confirmed`, `unresolved`, `ignored`), явный тип строки parent/variant, nullable `parent_tilda_uid` и variant metadata, `audit_source`, `created_at`, `updated_at`, `last_seen_at` и nullable `confirmed_at`. Точный состав variant metadata и типы колонок определяются по исходному экспорту до миграции; универсальный payload «на всякий случай» не добавляется. Уникальность ERP-ссылки и SKU заранее не предполагается, пока аудит не подтвердит кардинальности.

Обновлённый аудит экспорта Tilda: 177 строк = 131 parent + 46 variants; 150 stock-bearing SKU. Все `tilda_uid`, `tilda_external_id` и непустые SKU уникальны. Из stock-bearing строк 134 подтверждены по структурированным ERP-полям и ручной проверке, 16 товаров отсутствуют в ERPNext и по решению владельца имеют статус `ignored`; автоматически создавать их запрещено. Ещё 27 строк являются родителями вариантов без собственного SKU и также `ignored`. Нерешённых строк в seed 2026-08-21 нет. Это не разрешение применить migration/backfill или запустить публикацию; порядок первого запуска и rollback описан в `docs/tilda-stock-sync.md`.

До подтверждения реального домена не создаются универсальные JSON-таблицы «на всякий случай» и не копируются ERPNext-таблицы.

## Безопасность и роли

- MariaDB root не используется приложением, миграциями или backup job.
- `b24_app_runtime`: постоянный read-only доступ только к `b24_app`; на текущем этапе используется лишь для readiness и не получает workflow DML.
- `b24_app_migrator`: отдельный секрет и DDL-права только на `b24_app`; отсутствует в постоянном env контейнера.
- `b24_app_backup`: отдельный read-only секрет для dump.
- `b24_app_backfill`: one-shot credential только с `SELECT/INSERT/UPDATE`, без DDL/`DELETE`; создан отдельно 21 августа, хранится root-only и отсутствует в постоянном env.
- `b24_app_tilda_sync`: scheduler credential с `SELECT` на mappings и две таблицы резервирования, а также `SELECT/INSERT/UPDATE` run journal; не получает workflow DML, DDL или `DELETE` и не хранится в backend env. Доступ к резервам нужен только для проекции свободного остатка Tilda (`физический Shelly - активный резерв`).
- имя хоста базы берётся из проверенной production-конфигурации; имя контейнера не считается стабильным DNS-контрактом.
- backend по-прежнему запускается в `erpnext_frappe_network`, но никогда не пишет напрямую в ERPNext schema.

Первичный provision выполняет DBA интерактивно, не сохраняя пароли в shell history. Значения host part и секреты берутся из закрытой конфигурации; `%` допустим только если порт MariaDB не опубликован и доступ ограничен Docker network/firewall.

```sql
CREATE DATABASE b24_app CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'b24_app_runtime'@'<APP_HOST_PART>' IDENTIFIED BY '<RANDOM_RUNTIME_SECRET>';
CREATE USER 'b24_app_migrator'@'<ADMIN_HOST_PART>' IDENTIFIED BY '<RANDOM_MIGRATION_SECRET>';
CREATE USER 'b24_app_backup'@'<BACKUP_HOST_PART>' IDENTIFIED BY '<RANDOM_BACKUP_SECRET>';

GRANT SELECT ON b24_app.* TO 'b24_app_runtime'@'<APP_HOST_PART>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES
  ON b24_app.* TO 'b24_app_migrator'@'<ADMIN_HOST_PART>';
GRANT SELECT, SHOW VIEW, TRIGGER ON b24_app.* TO 'b24_app_backup'@'<BACKUP_HOST_PART>';
```

Runtime DML-права не выдаются: первый mirror apply использует отдельный one-shot backfill credential только с `SELECT/INSERT/UPDATE` на пяти supply tables. `DELETE` writer не использует. Provision базы и users выполняет существующая DBA-роль, не MariaDB root из backend-команд.

## Миграции и readiness

- `GET /health` не изменён и проверяет процесс backend.
- `GET /ready` при `B24_APP_DB_MODE=off` возвращает database `disabled`; при `readiness` выполняет `SELECT 1` и отдаёт 503 при недоступности.
- `npm -w @b24-app/backend run db:migrate` — только ручная команда. Она требует отдельные `B24_APP_MIGRATION_DB_USER/PASSWORD`, advisory lock и проверяет checksum уже применённых файлов.
- каталог `packages/backend/migrations` содержит применённые production `0001`-`0005`: первые четыре supply identity/graph tables и checkpoint. Отдельный runner 2026-08-21 применил только `0005` с hash `885e8222db301725daf7fa3ef792ddbdc07328f0afaad5f1d6e6991e35a5fd97`; все пять workflow/checkpoint tables пусты, runtime их не читает и не пишет.
- после применения файл миграции неизменяем; исправление оформляется новой миграцией.

## Обязательный gate перед авторитетными записями

До этапа, где `b24_app` принимает хотя бы одну авторитетную запись:

1. подключить отдельный consistent dump базы `b24_app` к проверяемому расписанию, не смешивая его retention с ERPNext;
2. не включать `b24_app` в bench backup по предположению: bench сохраняет ERPNext site DB, а не отдельную базу;
3. проверить `gzip -t`, checksum и наличие dump во внешнем хранилище;
4. восстановить dump в отдельную временную БД и проверить migrations, row counts и выборочные связи;
5. записать измеренные RPO/RTO и ответственного;
6. только затем разрешать backfill writes, shadow data и тем более переключение source of truth.

## Backup, restore и rollback

Точная server-команда должна использовать filesystem root-only option file для ограниченного `b24_app_backup`, а не пароль в CLI или логах. Для `mariadb-dump --databases b24_app` нужен отдельный option file без строки `database=b24_app`: MariaDB 11.8 разбирает её как неоднозначный префикс опции `databases` и выдаёт предупреждение. В существующую backup job добавляется отдельный consistent dump, запись во временный файл, `gzip -t`, проверка ожидаемой schema, checksum и только затем атомарное переименование. Retention: подтверждённые 14 DB backups; внешняя копия должна идти тем же проверяемым каналом, что и ERPNext backup.

Безопасная форма фрагмента для ревью существующего `/root/sync/core-backup.sh` (не запускать отдельно без проверки фактических переменных и upload-функции):

```bash
umask 077
B24_APP_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
B24_APP_FINAL="/root/core-backups/b24_app/${B24_APP_STAMP}-b24_app-database.sql.gz"
B24_APP_TEMP=$(mktemp /root/core-backups/b24_app/.b24_app.XXXXXX.sql.gz)
docker run --rm --network erpnext_frappe_network \
  -v /root/b24-app-secrets:/run/b24-app-secrets:ro mariadb:11.8 \
  mariadb-dump --defaults-extra-file=/run/b24-app-secrets/backup-dump.cnf \
  --single-transaction --quick --skip-lock-tables --triggers --hex-blob \
  --default-character-set=utf8mb4 --databases b24_app \
  | gzip -9 > "$B24_APP_TEMP"
gzip -t "$B24_APP_TEMP"
zgrep -q '^CREATE DATABASE.*`b24_app`' "$B24_APP_TEMP"
mv "$B24_APP_TEMP" "$B24_APP_FINAL"
sha256sum "$B24_APP_FINAL" > "${B24_APP_FINAL}.sha256"
```

Версионированная standalone-реализация находится в [`scripts/b24-app-backup.sh`](../scripts/b24-app-backup.sh). Она использует lock, удаляет только собственные незавершённые файлы по trap и публикует dump/checksum атомарными переименованиями. [`scripts/b24-app-backup-job.sh`](../scripts/b24-app-backup-job.sh) запускает dump, отдельный Disk uploader и только после успешного read-back применяет локальный retention. ERPNext `core-backup.sh` не изменён: job подключена независимой cron-строкой.

20 августа 2026 года scheduled-кандидаты размещены отдельно от ERPNext в `/root/core-backups/b24_app`; ручные эталоны — в `manual/`, первый dump с предупреждением — в `diagnostic/`. Это устраняет пересечение с ERPNext-маской `*-database.sql.gz`. Полный ручной job создал `20260820_085654-b24_app-database.sql.gz`, проверил gzip/checksum/schema, загрузил dump и checksum в отдельную папку Bitrix Disk `b24_app_backups`, скачал оба файла обратно и подтвердил SHA-256. Локальный и внешний retention настроены на 14 пар; ветка фактического удаления ещё не исполнялась, потому что scheduled-пар меньше лимита.

Полный последовательный rehearsal обеих cron-команд повторён в 10:25 UTC: неизменённый ERPNext job завершился за 21 секунду с успешным Disk upload и ротацией до 14 локальных копий; `b24_app` job завершился за 4 секунды и создал `20260820_102633-b24_app-database.sql.gz` с подтверждённым внешним read-back. Cron daemon был active, post-checks зелёные. Эти длительности относятся к пустой `b24_app` и не являются измеренным RPO/RTO для будущих доменных данных.

Проверенным dump выполнен restore drill через [`scripts/b24-app-restore-drill.sh`](../scripts/b24-app-restore-drill.sh). Создана отдельная schema `b24_app_restore_20260820_084026` с `utf8mb4/utf8mb4_unicode_ci`, восстановлено 0 таблиц согласно пустому dump; число таблиц рабочей `b24_app` до и после осталось 0. Negative tests подтвердили отказ для имени `b24_app` и для уже существующей restore schema. После фиксации результата временная schema удалена guarded-скриптом с точным confirmation; повторная проверка показала 0 таблиц в рабочей `b24_app`. Backup gate для будущих авторитетных данных ещё не закрыт: после появления доменных таблиц restore drill повторяется с migrations, row counts и выборочными link chains; отдельно проверяется реальное срабатывание retention и измеряются RPO/RTO.

После первой metadata migration полный job создал `20260820_112406-b24_app-database.sql.gz` размером 924 bytes с одной table definition и 0 data rows. Локальные gzip/checksum и внешний Bitrix Disk read-back прошли; upload IDs: dump `103522`, checksum `103520`. Временная schema `b24_app_restore_20260820_112406` восстановила одну `b24_app_schema_migrations` с 0 строк. Независимое сравнение подтвердило одинаковые charset/collation, сигнатуры колонок и индексов; рабочая schema оставалась 1/0. Guarded cleanup удалил только временную schema, после чего restore schema count равен 0. Этот результат достаточен для отдельного read-only readiness rollout, но не заменяет повторный drill после появления доменных таблиц и данных.

Перед первым доменным apply создан более свежий metadata-only safety dump `20260820_122411-b24_app-database.sql.gz`; gzip/checksum и внешний read-back прошли, Disk IDs `103574/103572`. Точные локальные migrations `0001`-`0004` успешно прошли server-level rehearsal в отдельной MariaDB 11.8: первый runner применил 4 файла, второй был идемпотентен, структура дала 5 tables / 54 columns / 5 FK / 20 CHECK / 21 indexes, а positive/negative constraint tests прошли. Rehearsal отдельно зафиксировала требование создавать database с явным `utf8mb4/utf8mb4_unicode_ci`: новый default MariaDB 11.8 — `utf8mb4_uca1400_ai_ci`. Рабочая `b24_app` уже имеет правильную явную collation и в rehearsal не использовалась.

После production DDL полный job создал `20260820_131030-b24_app-database.sql.gz` размером 2511 bytes с 5 table definitions, 4 metadata rows и 0 domain rows. Checksum/gzip и внешний Bitrix Disk read-back прошли; upload IDs: dump `103618`, checksum `103616`. Dump восстановлен только во временную `b24_app_restore_20260820_131030`. Независимые SHA-256 signatures совпали для table settings, 54 columns, 21 indexes, 5 FK и 20 CHECK; migration filenames/checksums и `0|0|0|0` domain rows также совпали. После отдельного разрешения guarded cleanup удалил restore schema, exited runner и два root-only parity staging-файла. Финальный post-check подтвердил отсутствие временных целей и неизменную production schema 5/4/0.

Restore drill выполняется не поверх production: административный оператор создаёт временную БД, импортирует выбранный dump, проверяет `b24_app_schema_migrations`, counts и выборочные link chains, после чего удаляет только явно названную временную БД.

Production restore требует остановить записи приложения, сделать свежий safety dump и восстановить выбранную копию в новую БД. После проверки контейнер пересоздаётся с новым `B24_APP_DB_NAME`; старая БД и rollback-контейнер сохраняются до подтверждения. Для текущего этапа rollback проще: вернуть `B24_APP_DB_MODE=off` или прежний контейнер — действующие Bitrix/ERPNext пути не менялись.

## Порядок следующих малых этапов

1. Provision database/users, disabled deploy, отдельный backup, metadata migration и restore drill одной metadata-таблицы выполнены.
2. `B24_APP_DB_MODE=readiness` включён с read-only runtime credential; internal/public `/ready` показывает `database: up`, workflow остаётся на Bitrix/ERPNext.
3. Read-only кардинальности проверены; четыре локальных one-statement DDL migrations и их статические contract tests подготовлены без применения.
4. Отсутствие target tables, свежий safety dump, isolated MariaDB rehearsal и production DDL apply закрыты. Независимая сверка подтвердила 5 tables / 4 migration rows / 54 columns / 5 FK / 20 CHECK / 21 indexes при 0 domain rows.
5. Post-DDL backup, external read-back и isolated restore gate пустой новой схемы выполнены; source/restore signatures и 0 domain rows совпали, временные объекты удалены guarded cleanup.
6. Read-only route развёрнут, первый production dry-run выполнен и fail-closed остановлен на 64 коррелированных legacy issues; workflow остаётся на Bitrix/ERPNext, SQL domain tables пусты.
7. Standalone roots и ручные transfer requests смоделированы и развёрнуты без SQL/runtime-записи; второй dry-run подтвердил устранение ожидаемых 29 ложных blockers без новых issue, SQL domain rows остались нулевыми.
8. Submitted-only gate доказал, что реальные 12 ERP references отменены; отдельная canceled-evidence ветка развёрнута. Четвёртый dry-run подтвердил пять tombstone, 12 восстановленных links, 12 warnings и отсутствие придуманных line allocations.
9. Read-only аудит семи line mismatch завершён: две live draft-связки не имеют доказанного соответствия, пять historical downstream-связок имеют явные document links, но не доказанные line allocations. Узкая warning-модель прошла focused `22/22`, полный backend `208/208`, typecheck и production dry-run `6 errors / 17 warnings`; SQL domain rows остались нулевыми.
10. Четыре stale revisions разобраны как одна старая canceled версия переиспользованного request name. Fail-closed модель прошла focused `26/26`, полный backend `212/212`, typecheck, commit/deploy и шестой production dry-run; ожидаемая дельта подтверждена, SQL domain rows остались нулевыми.
11. Две последние `missing_line_match` официально разобраны как старые app-canceled draft PO с точными request keys. Evidence-only модель прошла focused `29/29`, backend `215/215`, typecheck, commit/deploy и седьмой production dry-run; подтверждены 0 errors / 22 warnings и нулевые SQL domain rows.
12. Идемпотентный mirror writer/checkpoint подготовлен: focused `41/41`, backend `220/220`, общий typecheck и изолированный MariaDB 11.8 rehearsal успешны. Отдельный DML-only credential создан, `0005` применена one-shot runner, post-DDL backup/external read-back/restore parity успешны; writer source развёрнут без HTTP/startup вызова.
13. Первый production mirror apply выполнен отдельным разрешённым one-shot process: свежий план имел 0 errors / 22 warnings, атомарная запись и точный no-op repeat подтверждены, graph/orphan checks успешны, post-apply backup/external read-back/restore parity точны. Runtime остался readiness-only, source switch не выполнялся.
14. Owner OAuth vault, ручной shadow endpoint и первый refresh-cycle завершены: устаревший checkpoint дал объяснимый `mismatch`, новый mirror apply прошёл backup/restore, следующий compare дал точный `match` с 0 differences. До source switch нужны несколько независимых `match` во времени.
15. Idempotency/events, затем по одному модулю: снаб, остальные workflow; сначала reads, потом writes.

Отдельный Tilda mapping foundation применён 21 августа: migration `0006`, 177
mapping rows, idempotent repeat, post-write backup/restore и свежий официальный
ERP preview прошли. Runtime backend не менялся и Tilda publication не
выполнялась; точные hashes/counts и следующий разрешительный gate находятся в
[`tilda-stock-sync.md`](tilda-stock-sync.md).

Каждый пункт имеет собственные тесты «до/после», сравнение результатов и отдельный список посторонних ошибок. Коммит, push и deploy требуют явной команды.
