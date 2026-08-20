# Поэтапное внедрение `b24_app` в MariaDB

## Статус и граница текущего этапа

На 2026-08-20 выполнены только этап 0 и отключённый фундамент этапа 1. Исходный код проверен на commit `aabda5173872302752a27165b079bbd1dc9abc97`: 176 backend-тестов, typecheck и полная сборка прошли до изменений.

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
- каталог `packages/backend/migrations` пока не содержит доменных SQL. Первый ручной запуск создаст только `b24_app_schema_migrations`.
- после применения файл миграции неизменяем; исправление оформляется новой миграцией.

## Обязательный gate перед авторитетными записями

До этапа, где `b24_app` принимает хотя бы одну авторитетную запись:

1. расширить фактический `/root/sync/core-backup.sh` отдельным consistent dump базы `b24_app`;
2. не включать `b24_app` в bench backup по предположению: bench сохраняет ERPNext site DB, а не отдельную базу;
3. проверить `gzip -t`, checksum и наличие dump во внешнем хранилище;
4. восстановить dump в отдельную временную БД и проверить migrations, row counts и выборочные связи;
5. записать измеренные RPO/RTO и ответственного;
6. только затем разрешать backfill writes, shadow data и тем более переключение source of truth.

## Backup, restore и rollback

Точная server-команда должна использовать filesystem root-only option file для ограниченного `b24_app_backup`, а не пароль в CLI или логах. В существующую backup job добавляется отдельный `mariadb-dump --single-transaction --quick --skip-lock-tables --triggers b24_app`, запись во временный файл, `gzip -t`, checksum и только затем атомарное переименование. Retention: подтверждённые 14 DB backups; внешняя копия должна идти тем же проверяемым каналом, что и ERPNext backup.

Безопасная форма фрагмента для ревью существующего `/root/sync/core-backup.sh` (не запускать отдельно без проверки фактических переменных и upload-функции):

```bash
umask 077
B24_APP_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
B24_APP_FINAL="/root/sync/backups/b24_app-${B24_APP_STAMP}.sql.gz"
B24_APP_TEMP=$(mktemp /root/sync/backups/.b24_app.XXXXXX.sql.gz)
mariadb-dump --defaults-extra-file=/root/sync/b24-app-backup.cnf \
  --single-transaction --quick --skip-lock-tables --triggers b24_app \
  | gzip -c > "$B24_APP_TEMP"
gzip -t "$B24_APP_TEMP"
mv "$B24_APP_TEMP" "$B24_APP_FINAL"
sha256sum "$B24_APP_FINAL" > "${B24_APP_FINAL}.sha256"
```

Скрипт обязан удалять незавершённый temporary file по trap, а внешний upload должен считаться успешным только после проверки удалённого файла/размера. Эти строки пока не применялись к production.

Restore drill выполняется не поверх production: административный оператор создаёт временную БД, импортирует выбранный dump, проверяет `b24_app_schema_migrations`, counts и выборочные link chains, после чего удаляет только явно названную временную БД.

Production restore требует остановить записи приложения, сделать свежий safety dump и восстановить выбранную копию в новую БД. После проверки контейнер пересоздаётся с новым `B24_APP_DB_NAME`; старая БД и rollback-контейнер сохраняются до подтверждения. Для текущего этапа rollback проще: вернуть `B24_APP_DB_MODE=off` или прежний контейнер — действующие Bitrix/ERPNext пути не менялись.

## Порядок следующих малых этапов

1. Отдельно provision database/users и проверить `/ready`; без доменных таблиц.
2. Подключить backup и пройти restore drill.
3. Добавить минимальные таблицы только после выборки реальных кардинальностей.
4. Read-only backfill с checkpoint и отчётом, без переключения.
5. Shadow reads и автоматическое сравнение с Bitrix/ERPNext.
6. Idempotency/events, затем по одному модулю: снаб, остальные workflow; сначала reads, потом writes.

Каждый пункт имеет собственные тесты «до/после», сравнение результатов и отдельный список посторонних ошибок. Коммит, push и deploy требуют явной команды.
