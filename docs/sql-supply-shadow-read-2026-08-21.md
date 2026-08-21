# Supply shadow-read и ручной endpoint

## Граница change set

Первый change set добавил только два изолированных backend-модуля: read-only SQL reader последнего supply mirror snapshot и чистый parity comparator. В commit `2823a57` они ещё не были подключены к server, HTTP route, startup, scheduler или пользовательскому workflow. Новых migrations и SQL-записей не появилось; source-of-truth matrix не менялась.

Commit `147f876` подключил comparator только к ручному `POST /api/admin/sql-migration/supply/shadow-compare` и развёрнут с подтверждённым production default `off`. До чтения проверяются OAuth точного владельца, `B24_APP_SUPPLY_SHADOW_COMPARE=on` и SQL runtime mode `readiness`. Route не имеет UI, scheduler или startup-вызова, не получает migration/backfill credential и не выполняет DML. Одновременно разрешён только один полный scan.

## Read contract

`readLatestSupplyMirrorSnapshot()` сначала читает ровно один самый новый checkpoint по `applied_at, id`. После этого documents, lines, links и allocations читаются только с точным `observed_at` этого checkpoint. Это обязательно, потому что writer не делает `DELETE`: старые identities остаются как исторические evidence и не должны попадать в текущий snapshot.

Reader восстанавливает стабильные document/line/link/allocation identities, читает hashes через `HEX`, DECIMAL как числа и DATETIME как timezone-independent строки. Неизвестный enum, невалидное число или hash завершают чтение ошибкой.

## Comparison contract

`compareSupplyMirrorShadow()` сверяет свежий API-plan с SQL snapshot по plan hash, source cardinalities, checkpoint/loaded counts и каждому нормализованному полю всех четырёх типов rows. Разное техническое observation time не является business-расхождением. Отчёт имеет четыре явных статуса:

- `match` — все checkpoint и row fields совпали;
- `mismatch` — план полный, но есть расхождения;
- `plan_blocked` — хотя бы один текущий source неполон или план содержит error;
- `no_snapshot` — checkpoint в SQL отсутствует.

Число детальных differences ограничено, но общий счётчик не теряется. Неполный Bitrix/ERP read никогда не сравнивается как пустой реестр.

## Baseline и проверки

До изменения текущий focused SQL/supply набор прошёл `41/41`. После изменения тот же набор вместе с 8 новыми reader/comparator тестами прошёл `49/49`; полный backend — `229/229`. Backend и workspace typecheck, а также production build завершились успешно. Одноразовый MariaDB 11.8 tmpfs rehearsal прошёл writer/read/compare для первого и изменённого snapshot, а также прежние idempotency, rollback и DML-only guards; контейнер удалён, volume не создавался.

Первый production build остановился только из-за Windows sandbox `Access is denied` при чтении Vite config; повтор той же команды вне sandbox прошёл. Прежние npm warning о deprecated single-hyphen `-ws` и Vite warning о chunk больше 500 kB не исправлялись в этом этапе.

Перед endpoint change set тот же focused SQL/supply baseline прошёл `49/49`. После добавления строгого env gate и шести route/config regression tests расширенный набор прошёл `55/55`; полный backend — `235/235`, workspace typecheck и production build успешны. Новая MariaDB rehearsal не требовалась: schema, SQL reader queries и comparator не менялись, а endpoint не имеет write path. Прежний Vite warning о chunk больше 500 kB оставлен как постороннее наблюдение.

Первый production gate 21 августа начался с повторного focused baseline `55/55` и неизменного SQL checkpoint `181e72d285b576b9b22c00993d88eb9451ceb10f669bfcc2366a4e2cf35d02e6` (`398/110/5`, `516/1002/527/716`, `22` warnings). Тот же image `147f876` был временно пересоздан с `B24_APP_SUPPLY_SHADOW_COMPARE=on`, а исходный контейнер целиком сохранён. Internal/public health, readiness, официальный ERP GET, network/mount/port/restart и owner gate прошли.

Единственный POST получил исходный placement `AUTH_ID` и завершился `403` за `1.86 ms`. Это произошло до запуска comparator и до чтения ERP/Bitrix/SQL: initial placement token снова оказался непригоден для owner OAuth, как и в прежнем dry-run. Повторный POST не выполнялся. Исходный контейнер возвращён с эффективным default `off`; post-check подтвердил тот же checkpoint и cardinalities, health/readiness, ERP API, network и restart `0`. Остановленный `b24-backend-shadow-on-first-compare-403` сохранён как диагностическое evidence; OAuth runtime и временные operator scripts удалены.

## Операторский OAuth contract

Initial placement `AUTH_ID` запрещено использовать для owner-only compare: reload или новая placement-вкладка не доказывают его свежесть. Нужен только результат `BX24.getAuth()` после инициализации SDK. Если browser isolation не даёт обратиться к `BX24` напрямую, разрешённый fallback — заранее включить узкое наблюдение и взять `domain/accessToken` из одного обычного JSON POST, который frontend отправляет к собственному backend после SDK init (`/api/supply/orders` или `/api/stock/form-data`), но не из placement POST. Значение остаётся только в памяти, не попадает в output/files/log/shell history; наблюдение прекращается сразу после capture, а browser runtime очищается после единственного согласованного диагностического запроса. Отсутствие такого live request — стоп, а не повод снова перебирать initial tokens, reloads, tabs или webhook.

Этот browser contract остаётся fallback, пока отдельный `B24_APP_OAUTH_VAULT` не развёрнут, явно включён и инициализирован повторной авторизацией точного владельца. После этого server-side compare может использовать зашифрованный rotating token только вместе с отдельным operator bearer и повторной проверкой `user.current`; bearer и OAuth-токены не выводятся и не передаются frontend.

## Первый успешный production compare

21 августа после активации vault выполнен ровно один owner-authorized compare через отдельный canary `b24-app:ef4fecb`. Рабочий `b24-backend` не пересоздавался; canary находился только в `erpnext_frappe_network`, получил `/srv/b24-state:/app/state` read-only и единственный имел `B24_APP_SUPPLY_SHADOW_COMPARE=on`. Canary health/readiness прошли, после запроса он удалён вместе с временным root-only env-файлом.

Отчёт имеет `status=mismatch`, но план полный и сравнимый: `planErrors=0`, `comparable=true`. SQL checkpoint от `09:03:35 UTC` содержит `516/1002/527/716`, а свежий план от `12:43:38 UTC` — `552/1064/563/753`; warnings остались `22`. Hash изменился с `181e72d285b576b9b22c00993d88eb9451ceb10f669bfcc2366a4e2cf35d02e6` на `22ad151b5f2881b525d84c687583bcd23948dbc18f66219734f8091abda0f831`. Comparator насчитал `233` differences и сохранил ограниченные контрактом первые `100`: семь checkpoint-полей, 32 изменившихся document fields, 36 новых documents, два изменившихся line fields и 23 новые lines. Среди изменившихся полей видны status/docstatus, modified time, actual quantity и зависящие от них source hashes; это согласуется с движением workflow после старого snapshot, но из-за truncation не доказывает полный row-level parity.

Root-only audit сохранён как `/root/b24-app-audits/20260821-124338-supply-shadow-report.json`, mode `0600`, SHA-256 `6109cf4c0cee74107a4c575c7392ca0fca6a4acbe32f285adc0e555ac7167f9a`. После удаления canary повторены те же production checks: internal/public health, readiness `database: up`, официальный ERP Item GET, network/mount/port/restart. SQL остался `516/1002/527/716`, один checkpoint, пять migrations и прежний hash. Ни SQL DML, ни migration, ни source switch не выполнялись.

Перед возможным refresh mirror проверены оба retention-контура: локально и в отдельной папке Bitrix Disk было по `11` dump-пар при лимите `14`. Safety job создал двенадцатый `20260821_124850-b24_app-database.sql.gz` (`163253` bytes, 6 definitions), локальные checksum/gzip и внешний read-back прошли; Disk IDs `103948/103946`, старейший локальный dump сохранён. Следующий owner dry-run от `12:49:24 UTC` повторил hash `22ad151b5f2881b525d84c687583bcd23948dbc18f66219734f8091abda0f831`, полные sources `425/119/5`, rows `552/1064/563/753`, `0` errors, `22` warnings и `readyToApply=true`. После dry-run health/readiness и SQL counts/hash не изменились. Это только pre-DML gate; новый checkpoint ещё не записан.

После отдельно разрешённого mirror refresh второй shadow compare выполнен один раз через новый read-only canary. Он дал `status=match`, `matches=true`, `comparable=true`, одинаковый current/stored hash `22ad151b5f2881b525d84c687583bcd23948dbc18f66219734f8091abda0f831`, одинаковые expected/checkpoint/loaded counts `552/1064/563/753`, `22` warnings, `0` plan errors, `0` differences и `truncated=false`. Отчёт сохранён как `/root/b24-app-audits/20260821-130225-supply-shadow-report-match.json`, mode `0600`, SHA-256 `8755697d248189ebb4242307c0dd8fcaa4ee6200a73647faf2411427b2f01381`; canary и временный env удалены. Production shadow flag остался `off`.

## Следующие отдельные gates

1. OAuth-vault, его config-активация и однократная переавторизация локального приложения завершены; initial placement `AUTH_ID` больше не нужен для штатного owner compare.
2. Первый owner comparison завершён безопасным `mismatch` к ожидаемо устаревшему snapshot; workflow всё время оставался на Bitrix/ERP.
3. Второй неавторитетный mirror apply и первый точный production `match` завершены; повторить shadow compare на следующем отдельно согласованном свежем snapshot, чтобы получить несколько независимых `match` во времени.
4. Только после нескольких успешных production `match` проектировать SQL read path с Bitrix fallback.
