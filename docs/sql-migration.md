# Поэтапное внедрение `b24_app` в MariaDB

## Статус и граница текущего этапа

На 2026-08-20 выполнены этап 0 и отключённый фундамент этапа 1. Disabled-каркас commit `596bddb06cf853a0a8816281bb2468ccdf9b3cfd` развёрнут с единственной SQL-переменной `B24_APP_DB_MODE=off`, без credentials и runtime-соединения. Отдельным bootstrap созданы schema `b24_app` и три ограниченные роли. Ручной migration runner создал только `b24_app_schema_migrations`; доменных таблиц нет, metadata-таблица содержит 0 применённых migration rows.

Read-only production preflight, фактические network/backup результаты и следующий change set записаны отдельно: [sql-preflight-2026-08-20.md](sql-preflight-2026-08-20.md).

`b24_app` пока **не является источником данных**. `B24_APP_DB_MODE=off` по умолчанию; приложение не открывает SQL-соединение, не запускает миграции при старте, не зеркалирует данные и не меняет текущие чтения/записи. Исправленная пагинация Bitrix24 из `f3ae38e` остаётся рабочим fallback.

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
| сопоставление товаров Tilda (будущий контур, сейчас не работает) | `b24_app` после отдельной миграции; остаток всегда ERPNext | отдельная SQL-таблица внешних идентификаторов Tilda и ссылок на ERP Item; Tilda получает только проекцию | 33 из 150 stock-bearing строк требуют ручного подтверждения; до него экспорт для них запрещён |

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

Одна заявка и одна закупка могут иметь несколько строк и downstream-документов. Поэтому будущая связь не должна кодироваться одним nullable foreign key в `documents`: нужны отдельные `document_links` и `document_lines` с типом связи, внешней системой, внешним ID и стабильным ключом строки.

## Минимальная будущая схема домена

На этапе 1 доменные таблицы намеренно не создаются. После read-only выборки реальных JSON и проверки кардинальностей минимальный кандидат:

- `documents`: тип, статус, версия snapshot, внешний Bitrix/ERP ID, timestamps;
- `document_lines`: стабильный line key, SKU, план/факт и замороженный payload;
- `document_links`: направленная типизированная связь между документами и внешними ссылками;
- `events`: append-only аудит переходов и actor/idempotency key;
- `sync_jobs`: курсор, попытки, ошибка и состояние backfill/shadow comparison.

Отдельно от workflow-каркаса будущей интеграции Tilda нужна специализированная таблица `tilda_product_mappings`, а не новый файл в `/app/state`. Минимальные поля-кандидаты: уникальные `tilda_uid` и `tilda_external_id`, `tilda_sku`, nullable внешние ссылки `erp_item_code`/`erp_product_id`, `mapping_status` (`confirmed`, `unresolved`, `ignored`), явный тип строки parent/variant, nullable `parent_tilda_uid` и variant metadata, `audit_source`, `created_at`, `updated_at`, `last_seen_at` и nullable `confirmed_at`. Точный состав variant metadata и типы колонок определяются по исходному экспорту до миграции; универсальный payload «на всякий случай» не добавляется. Уникальность ERP-ссылки и SKU заранее не предполагается, пока аудит не подтвердит кардинальности.

Исходный аудит экспорта Tilda: 177 строк = 131 parent + 46 variants; 150 stock-bearing SKU. Все `tilda_uid` и `tilda_external_id` уникальны. Из stock-bearing строк 117 однозначно сопоставляются с ERP, 33 остаются `unresolved` до ручной сверки. Эти числа являются baseline для будущего backfill/shadow-отчёта, а не разрешением создать таблицу или запустить синхронизацию.

До подтверждения реального домена не создаются универсальные JSON-таблицы «на всякий случай» и не копируются ERPNext-таблицы.

## Безопасность и роли

- MariaDB root не используется приложением, миграциями или backup job.
- `b24_app_runtime`: доступ только к `b24_app`; на текущем этапе нужен лишь connect/readiness, позже выдаются только необходимые DML-права.
- `b24_app_migrator`: отдельный секрет и DDL-права только на `b24_app`; отсутствует в постоянном env контейнера.
- `b24_app_backup`: отдельный read-only секрет для dump.
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

Runtime DML-права не выдаются заранее: `INSERT/UPDATE/DELETE` добавляются по таблицам только на этапе первого разрешённого writer. Provision базы и users выполняет существующая DBA-роль, не MariaDB root из backend-команд.

## Миграции и readiness

- `GET /health` не изменён и проверяет процесс backend.
- `GET /ready` при `B24_APP_DB_MODE=off` возвращает database `disabled`; при `readiness` выполняет `SELECT 1` и отдаёт 503 при недоступности.
- `npm -w @b24-app/backend run db:migrate` — только ручная команда. Она требует отдельные `B24_APP_MIGRATION_DB_USER/PASSWORD`, advisory lock и проверяет checksum уже применённых файлов.
- каталог `packages/backend/migrations` пока не содержит доменных SQL. Первый ручной запуск 2026-08-20 создал только `b24_app_schema_migrations`; до запуска было 0 таблиц, после — одна metadata-таблица с 0 строк.
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

Restore drill выполняется не поверх production: административный оператор создаёт временную БД, импортирует выбранный dump, проверяет `b24_app_schema_migrations`, counts и выборочные link chains, после чего удаляет только явно названную временную БД.

Production restore требует остановить записи приложения, сделать свежий safety dump и восстановить выбранную копию в новую БД. После проверки контейнер пересоздаётся с новым `B24_APP_DB_NAME`; старая БД и rollback-контейнер сохраняются до подтверждения. Для текущего этапа rollback проще: вернуть `B24_APP_DB_MODE=off` или прежний контейнер — действующие Bitrix/ERPNext пути не менялись.

## Порядок следующих малых этапов

1. Provision database/users, disabled deploy, отдельный backup и metadata migration выполнены; runtime остаётся `off`.
2. Сделать свежий dump и restore drill одной metadata-таблицы, не затрагивая рабочую schema.
3. Отдельным deploy включить только `B24_APP_DB_MODE=readiness` с read-only runtime credential и проверить `/ready`; workflow остаётся на Bitrix/ERPNext.
4. Добавить минимальные таблицы только после выборки реальных кардинальностей.
5. Read-only backfill с checkpoint и отчётом, без переключения.
6. Shadow reads и автоматическое сравнение с Bitrix/ERPNext.
7. Idempotency/events, затем по одному модулю: снаб, остальные workflow; сначала reads, потом writes.

Каждый пункт имеет собственные тесты «до/после», сравнение результатов и отдельный список посторонних ошибок. Коммит, push и deploy требуют явной команды.
