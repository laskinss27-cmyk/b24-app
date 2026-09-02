# Supply mirror refresh — 2 сентября 2026

## Граница этапа

Этап обновил только неавторитетное SQL-зеркало снаба. Рабочие чтения снабжения
остались на Bitrix24/ERPNext: `B24_APP_SUPPLY_SQL_READ=off`. Backend продолжил
работать в `B24_APP_DB_MODE=readiness`, резервы — в отдельно разрешённом
`B24_APP_RESERVATIONS=active`. Migration, DDL, source switch и изменение
production-конфигурации не выполнялись.

## Read-only план и apply

Owner-authorized dry-run полностью прочитал три источника и построил план:

- hash `a2de30d3237ca438c2e96fdb29665e0897eed8d279b0bcf567ed2659e4207fd7`;
- ERPNext `665`, Bitrix transfers `182`, transfer requests `14`;
- documents `862`, lines `1582`, links `890`, allocations `1188`;
- `0` errors и `22` документированных historical warnings;
- `readyToApply=true`.

Отдельный DML-only runner потребовал точный ожидаемый hash до открытия writer
pool. Writer применил план одной транзакцией без `DELETE`; немедленный повтор
того же in-memory plan вернул `alreadyApplied=true`. Latest checkpoint стал
четвёртым. Физические append-only counts после записи: documents `862`, lines
`1614`, links `890`, allocations `1215`; точный latest-срез совпал с checkpoint:
`862/1582/890/1188`.

Независимый shadow compare после apply повторно прочитал живые источники и вернул
`match`, одинаковый hash, `0` differences и `0` plan errors. Orphan counts для
lines/links/allocations равны `0/0/0`, writer lock свободен. Root-only audits:

- `/root/b24-app-audits/20260902_1200-supply-mirror-apply.json`;
- `/root/b24-app-audits/20260902_1204-supply-mirror-verify.json`.

## Backup и restore

Штатный retention job не запускался: на момент операции уже существовало 14
локальных backup-копий, а ручной запуск удалил бы старые пары. Вместо этого до и
после apply созданы две дополнительные root-only копии без retention:

- `20260902_115538-b24_app-database.sql.gz` — pre-apply, `289041` bytes;
- `20260902_120327-b24_app-database.sql.gz` — post-apply, `301432` bytes.

Обе пары прошли local SHA-256/gzip, были загружены в изолированную папку Bitrix
Disk без retention и скачаны обратно для проверки SHA-256. Для обеих записаны
`.uploaded` markers, поэтому штатный backup job не сочтёт их неполными.

Обе копии восстановлены только в отдельные временные schema. Post-apply source и
restore совпали по списку таблиц, row counts и детерминированным row dump hashes
всех `17` таблиц. Обычный InnoDB `CHECKSUM TABLE` для
`workflow_document_lines` различался между schema при идентичном содержимом;
побайтовые детерминированные экспорты строк имели одинаковый SHA-256, поэтому
финальный parity gate использовал именно их. Audit:
`/root/b24-app-audits/20260902_120422-post-mirror-restore-parity.log`.

Созданные оператором временные runner scripts, named containers и restore schema
удалены после успешной проверки. Production backup и audit artifacts сохранены.
Финальные internal/public health, SQL readiness, reservation readiness,
авторизованный ERPNext read и `erpnext_frappe_network` успешны; backend image
`b24-app:24eb5ff`, restart count `0`.

## Production shadow

После отдельного разрешения backend пересоздан с единственным изменением
`B24_APP_SUPPLY_SQL_READ=shadow`; image остался `b24-app:24eb5ff`. Предыдущий
контейнер с `off` сохранён как
`b24-backend-prev-before-supply-shadow-20260902-1215`. Internal/public health,
SQL и reservation readiness, ERPNext read, state mount и
`erpnext_frappe_network` успешны; restart count `0`.

Один owner-authorized рабочий `POST /api/supply/orders` вернул прежний успешный
legacy-ответ: HTTP `200`, `98` карточек (`97` заявок и самостоятельный блок).
Сопутствующий per-request SQL shadow дал `match`: legacy/stored transfers
`182/182`, checkpoint hash `a2de30d…`, differences `0`. Токен использовался
только в памяти временного процесса; временный runner и container удалены.

SQL всё ещё не является источником ответа снабжения. Следующий gate — серия
реальных `match` во времени, затем расширение schema полями карточки, истории и
action facts. Значение режима `sql` намеренно отсутствует, а Bitrix/ERPNext
fallback остаётся рабочим.
