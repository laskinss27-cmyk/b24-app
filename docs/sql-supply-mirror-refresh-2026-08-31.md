# Supply mirror refresh — 31 августа 2026

## Граница этапа

Этап обновил только неавторитетное SQL-зеркало снаба. Пользовательские чтения и
записи не переключались: production backend остался на `b24-app:aaf8730`,
`B24_APP_DB_MODE=readiness`, shadow flag выключен, Bitrix/ERPNext fallback
сохранён. Deploy и restart backend не выполнялись.

## Найденный конфликт схемы

Первый mirror apply безопасно откатился на строке Material Request, которая
после удаления соседних строк получила новый `line_ordinal`. Стабильный
`external_line_key` указывал на существующую строку, но старый уникальный индекс
`(document_id, line_ordinal)` одновременно указывал на историческую строку.

Append-only migration
`0008_make_line_ordinal_identity_conditional.sql` оставила внешние line IDs
основной идентичностью, а уникальность ordinal сохранила только для fallback-строк
без `external_line_key` через STORED generated column. Исходная `0002` не
изменялась. Регрессионный тест сначала воспроизводит `Duplicate entry` на
миграциях `0001`–`0007`, затем применяет `0008` и подтверждает успешный writer,
latest-checkpoint reader и сохранённый запрет дублей fallback ordinal. Изолированная
MariaDB 11.8.8, focused tests `61/61` и workspace typecheck прошли.

## Production DDL

Перед DDL создан и внешне проверен safety dump
`20260831_143157-b24_app-database.sql.gz`. Отдельный migrator применил только
`0008`, checksum
`f6e7356aa3e6fb9da349d1e97bfb6ed0f56fb1ef2339e753c61b0c289e8c7538`.
Количество domain rows не изменилось: `552/1064/563/753`, checkpoints `2`,
orphans `0`. Post-DDL dump `20260831_144012-b24_app-database.sql.gz` прошёл
checksum, gzip, Bitrix Disk read-back и полный isolated restore parity по таблицам,
колонкам, индексам и migrations. Временная restore schema удалена guarded-командой.

## Production mirror apply

Два независимых owner-authorized плана имели одинаковый hash
`b411ebc943c19724a5c902a132efd381d5002c55f1b1d7bb72c5ea5259a57826`:

- sources: ERPNext `634`, Bitrix transfers `174`, transfer requests `13`;
- graph: documents `823`, lines `1516`, links `847`, allocations `1130`;
- errors `0`, warnings `22` (`4` historical request revisions, `6` historical
  source lines и `12` historical transfer lines).

DML-only writer записал план одной транзакцией; повтор того же in-memory плана
вернул `alreadyApplied=true`. Checkpoint увеличился с `2` до `3`, latest hash и
его counts совпали с планом, orphan counts остались нулевыми. Root-only audits:

- `/root/b24-app-audits/20260831_151303-supply-plan-1.json`;
- `/root/b24-app-audits/20260831_151303-supply-plan-2.json`;
- `/root/b24-app-audits/20260831_151303-supply-mirror-apply.json`.

Первоначальный внешний post-validator завершился ошибкой уже после успешного
apply, потому что сравнивал физические counts append-only таблиц с counts текущего
плана. Физически сохранены исторические наблюдения: `823/1547/847/1156`, тогда
как точный срез по `latest.observed_at` равен checkpoint и плану:
`823/1516/847/1130`. Это не повторная или частичная запись; apply audit подтвердил
успешный first apply и точный no-op repeat. Apply не повторялся.

## Backup, restore и shadow parity

Post-apply dump `20260831_151622-b24_app-database.sql.gz` прошёл локальные
checksum/gzip, Bitrix Disk read-back и isolated restore. Source и restore совпали
по схеме, индексам, checksums всех восьми таблиц, physical counts, latest counts и
checkpoint hash. Generated identity корректна для всех `296` fallback-строк,
нарушений `0`; временная restore schema удалена.

Независимый свежий shadow compare вернул `match`: expected/checkpoint/loaded
counts `823/1516/847/1130`, plan errors `0`, differences `0`. Audit:
`/root/b24-app-audits/20260831_152204-supply-shadow-postapply.json`, mode `0600`.

Финальный post-check подтвердил internal/public health, SQL readiness `up`,
официальный ERPNext Company GET, restart count `0`, сеть
`erpnext_frappe_network`, свободные migration/writer locks, отсутствие one-shot
containers и migration/backfill credentials в runtime. SQL остаётся зеркалом;
source switch не выполнен.
