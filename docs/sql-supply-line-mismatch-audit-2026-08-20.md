# Read-only аудит `missing_line_match` снаба — 2026-08-20

## Граница проверки

Проверены семь `missing_line_match` из четвёртого production dry-run. Аудит использовал только официальный ERPNext REST API и уже известные из отчёта идентификаторы документов; читались исходные документы и непосредственно связанные с ними downstream-документы. Bitrix, ERPNext и `b24_app` не изменялись, SQL writer и source switch не запускались.

Временный скрипт удалён из production-контейнера, production-хоста и локального workspace. OAuth token для этого аудита не запрашивался и не использовался.

## Результат

Семь проявлений делятся на две разные группы. Их нельзя исправлять одной догадкой по совпадающему количеству.

| Группа | Downstream | Строка без match | Текущий source | Вывод |
| --- | --- | --- | --- | --- |
| app-canceled draft | `PUR-ORD-2026-00032` | item `11280`, qty `4`, request qty `4` | draft `MAT-MR-2026-00009` содержит только `16836` qty `1` и `18510` qty `4`; PO имеет точный request key и `b24_supply_stage=cancelled` | исходная строка отсутствует; link документа доказан, line allocation запрещён |
| app-canceled draft | `PUR-ORD-2026-00038` | item `16784`, qty `35`, request qty `35` | draft `MAT-MR-2026-00014` содержит `18010`, `18008`, `17938`, `12252`, `18462`; отдельный `PUR-ORD-2026-00040` уже использует `18462` qty `35` | canceled PO — историческое evidence; автоматически связывать `16784` с `18462` нельзя |
| historical canceled | `MAT-PRE-2026-00014` | item `18096`, qty `1` | поле содержит `PUR-ORD-2026-00012`; текущий draft заказа содержит только `16656` qty `1` | уточнено последующим revision-аудитом: текущее имя PO переиспользовано, link не доказан |
| historical submitted | `MAT-PRE-2026-00088` | item `20328`, qty `1` | явная ссылка на `PUR-ORD-2026-00017`; текущий draft заказа содержит только `20332` и `19964` | document link доказан, исходная строка больше недоступна |
| historical submitted | `MAT-PRE-2026-00088` | item `13590`, qty `1` | та же явная ссылка на `PUR-ORD-2026-00017` | document link доказан, исходная строка больше недоступна |
| historical submitted | transfer `20724` / `MAT-STE-2026-00198` | item `20328`, qty `1` | submitted Stock Entry явно ссылается на `MAT-MR-2026-00002` и `PUR-ORD-2026-00017`; строки заказа нет | связь документов доказана, line allocation не доказан |
| historical submitted | transfer `20724` / `MAT-STE-2026-00199` | item `13590`, qty `1` | submitted Stock Entry явно ссылается на те же request/order; строки заказа нет | связь документов доказана, line allocation не доказан |

`MAT-STE-2026-00198` и `MAT-STE-2026-00199` вместе содержат `20328`, `20332`, `13590`, `19964` qty `1`; это объясняет две transfer-to-order ошибки для строк, исчезнувших из текущего `PUR-ORD-2026-00017`. Это не восстанавливает прежние child-row keys и не даёт права создавать предполагаемые allocations.

## Реализованная модель

Planner переводит `missing_line_match` в warning `historical_source_line_unavailable` только при одновременном выполнении всех условий:

1. между source и downstream есть явная устойчивая document link;
2. downstream ERP-документ проведён или отменён (`docstatus=1/2`), либо transfer имеет подтверждённые проведённые ERP ship/receive references;
3. evidence старше 24 часов и имеет читаемый timestamp;
4. source document существует, но точная строка по item/line identity отсутствует;
5. planner сохраняет document link, но не создаёт и не угадывает line allocation.

Для Purchase Receipt terminal evidence означает `docstatus=1/2` и возраст не менее 24 часов. Для transfer модель дополнительно требует явную ссылку именно на Purchase Order, статус `posted`/`received`, существующий source order и полный старше 24 часов submitted lifecycle: одновременно ship и receive/legacy_receive, без draft/canceled/mixed Stock Entry references.

Draft/current, свежие, `approval`/`approved`/`ordered`, смешанные, неоднозначные и неразбираемые случаи остаются errors. Отдельное узкое исключение ниже относится только к старым ERP draft Purchase Order с явным прикладным `b24_supply_stage=cancelled`, точным текущим request key и существующим request-документом. `ambiguous_line_match` никогда не понижается до warning.

Предсказанная дельта подтверждена production dry-run: 510 documents / 991 lines / 520 links / 705 allocations остались без изменений; errors уменьшились с 11 до 6 (2 live line mismatch + 4 stale request key), warnings увеличились с 12 до 17.

Baseline до кода: focused planner/snapshot `17/17`, backend typecheck успешен. После изменения focused suite `22/22`, полный backend `208/208`, backend typecheck и `git diff --check` успешны. Посторонних ошибок не обнаружено.

## Отдельно найденное, но не исправленное

Текущие draft-источники изменились относительно исторических downstream-документов. Аудит не определяет, было ли это ручной заменой SKU, пересозданием строки или legacy-поведением ERP/интеграции. Исправлять сами ERP-документы в рамках SQL-миграции нельзя.

Planner change развёрнут в `b24-app:b799329`. Owner-only production dry-run `2026-08-20T17:01:10.827Z` подтвердил 2 оставшихся live blockers и 5 historical warnings без allocations; SQL domain tables остались пустыми. Следующий отдельный change set — read-only аудит четырёх `stale_request_key`; writer, backfill apply и source switch этим результатом не разрешены.

Последующий [аудит stale revision](sql-supply-stale-request-audit-2026-08-20.md) установил, что `MAT-PRE-2026-00014` создан раньше текущего `PUR-ORD-2026-00012`, а их SKU различаются. Узкий change `9b6b80c` уже исключил две ложные links этой canceled receipt; шестой production dry-run подтвердил результат, SQL остался пустым.

## Повторный аудит двух оставшихся blockers

В `2026-08-20T18:25:37.125Z` официальный ERPNext API повторно прочитал ровно два request, четыре связанных Purchase Order, их доступную Version history, четыре Item и связанные Purchase Receipt. SQL и Bitrix не читались и не изменялись; временный скрипт удалён из container, production host и workspace.

Оба прежних «live draft» оказались завершёнными на прикладном уровне:

- `PUR-ORD-2026-00032` имеет точный immutable key `MAT-MR-2026-00009@2026-07-25 07:09:02.219893`, `docstatus=0`, но `b24_supply_stage=cancelled`; Version фиксирует `draft → cancelled` 29 июля. Приёмок по заявке нет. Item `11280` — монтажная коробка; текущая заявка изменена и строки `11280` больше не содержит.
- `PUR-ORD-2026-00038` имеет точный key `MAT-MR-2026-00014@2026-07-29 06:11:19.534797`; Version фиксирует `draft → ordered → cancelled` 30 июля. Note заявки прямо говорит о замене приводов на `VT.TE3043.A.024`; старый item `16784` и новый `18462` — два термоэлектрических привода. Новый `PUR-ORD-2026-00040` для `18462` имеет stage `ordered`, а `MAT-PRE-2026-00072` проведён против него. Это доказывает отмену старого PO, но не тождество строк и не разрешает allocation `16784 → 18462`.

Локальный узкий change считает missing source line историческим только когда Purchase Order одновременно `docstatus=0`, `b24_supply_stage=cancelled`, старше 24 часов, с точным current request key и существующим request-документом. Document link сохраняется, line allocation не создаётся, issue становится `historical_source_line_unavailable`. Свежий canceled draft и старый `ordered` draft остаются `missing_line_match` errors; stale key и ambiguous match не маскируются.

Baseline перед change: focused `26/26`, общий typecheck успешен. После change focused `29/29`, полный backend `215/215`, общий typecheck и `git diff --check` успешны. Для неизменного production snapshot ожидаются прежние 510 documents / 991 lines / 518 links / 705 allocations, 0 errors и 22 warnings. `readyToApply=true` здесь будет означать только структурно объяснённый read-only план; это не разрешение на SQL writer, backfill apply или source switch. Commit, deploy и production dry-run пока не выполнялись.
