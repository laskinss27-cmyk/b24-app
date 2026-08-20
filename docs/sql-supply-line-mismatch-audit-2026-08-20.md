# Read-only аудит `missing_line_match` снаба — 2026-08-20

## Граница проверки

Проверены семь `missing_line_match` из четвёртого production dry-run. Аудит использовал только официальный ERPNext REST API и уже известные из отчёта идентификаторы документов; читались исходные документы и непосредственно связанные с ними downstream-документы. Bitrix, ERPNext и `b24_app` не изменялись, SQL writer и source switch не запускались.

Временный скрипт удалён из production-контейнера, production-хоста и локального workspace. OAuth token для этого аудита не запрашивался и не использовался.

## Результат

Семь проявлений делятся на две разные группы. Их нельзя исправлять одной догадкой по совпадающему количеству.

| Группа | Downstream | Строка без match | Текущий source | Вывод |
| --- | --- | --- | --- | --- |
| live draft | `PUR-ORD-2026-00032` | item `11280`, qty `4`, request qty `4` | draft `MAT-MR-2026-00009` содержит только `16836` qty `1` и `18510` qty `4` | исходная строка отсутствует; безопасного соответствия нет |
| live draft | `PUR-ORD-2026-00038` | item `16784`, qty `35`, request qty `35` | draft `MAT-MR-2026-00014` содержит `18010`, `18008`, `17938`, `12252`, `18462`; отдельный `PUR-ORD-2026-00040` уже использует `18462` qty `35` | замена или дубликат не доказаны; автоматически выбирать `18462` нельзя |
| historical canceled | `MAT-PRE-2026-00014` | item `18096`, qty `1` | явная ссылка на `PUR-ORD-2026-00012`; текущий draft заказа содержит только `16656` qty `1` | document link доказан, исходная строка больше недоступна |
| historical submitted | `MAT-PRE-2026-00088` | item `20328`, qty `1` | явная ссылка на `PUR-ORD-2026-00017`; текущий draft заказа содержит только `20332` и `19964` | document link доказан, исходная строка больше недоступна |
| historical submitted | `MAT-PRE-2026-00088` | item `13590`, qty `1` | та же явная ссылка на `PUR-ORD-2026-00017` | document link доказан, исходная строка больше недоступна |
| historical submitted | transfer `20724` / `MAT-STE-2026-00198` | item `20328`, qty `1` | submitted Stock Entry явно ссылается на `MAT-MR-2026-00002` и `PUR-ORD-2026-00017`; строки заказа нет | связь документов доказана, line allocation не доказан |
| historical submitted | transfer `20724` / `MAT-STE-2026-00199` | item `13590`, qty `1` | submitted Stock Entry явно ссылается на те же request/order; строки заказа нет | связь документов доказана, line allocation не доказан |

`MAT-STE-2026-00198` и `MAT-STE-2026-00199` вместе содержат `20328`, `20332`, `13590`, `19964` qty `1`; это объясняет две transfer-to-order ошибки для строк, исчезнувших из текущего `PUR-ORD-2026-00017`. Это не восстанавливает прежние child-row keys и не даёт права создавать предполагаемые allocations.

## Реализованная локальная модель

Локальный planner change переводит `missing_line_match` в warning `historical_source_line_unavailable` только при одновременном выполнении всех условий:

1. между source и downstream есть явная устойчивая document link;
2. downstream ERP-документ проведён или отменён (`docstatus=1/2`), либо transfer имеет подтверждённые проведённые ERP ship/receive references;
3. evidence старше 24 часов и имеет читаемый timestamp;
4. source document существует, но точная строка по item/line identity отсутствует;
5. planner сохраняет document link, но не создаёт и не угадывает line allocation.

Для Purchase Receipt terminal evidence означает `docstatus=1/2` и возраст не менее 24 часов. Для transfer модель дополнительно требует явную ссылку именно на Purchase Order, статус `posted`/`received`, существующий source order и полный старше 24 часов submitted lifecycle: одновременно ship и receive/legacy_receive, без draft/canceled/mixed Stock Entry references.

Draft/current, свежие, смешанные, неоднозначные и неразбираемые случаи остаются errors. В частности, `PUR-ORD-2026-00032` и `PUR-ORD-2026-00038` продолжат блокировать apply. `ambiguous_line_match` никогда не понижается до warning.

На неизменном снимке ожидаемая дельта локального change set: 510 documents / 991 lines / 520 links / 705 allocations остаются без изменений; errors уменьшаются с 11 до 6 (2 live line mismatch + 4 stale request key), warnings увеличиваются с 12 до 17. Это только проверяемое ожидание, не разрешение на writer, backfill, deploy или source switch.

Baseline до кода: focused planner/snapshot `17/17`, backend typecheck успешен. После изменения focused suite `22/22`, полный backend `208/208`, backend typecheck и `git diff --check` успешны. Посторонних ошибок не обнаружено.

## Отдельно найденное, но не исправленное

Текущие draft-источники изменились относительно исторических downstream-документов. Аудит не определяет, было ли это ручной заменой SKU, пересозданием строки или legacy-поведением ERP/интеграции. Исправлять сами ERP-документы в рамках SQL-миграции нельзя.

Локальный planner change готов, но не развёрнут. Следующий gate — отдельные commit/push/deploy и один owner-only production dry-run только после явного разрешения. До этого production продолжает возвращать прежние 11 errors / 12 warnings, SQL domain tables остаются пустыми.
