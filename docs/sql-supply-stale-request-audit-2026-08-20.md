# Read-only аудит `stale_request_key` снаба — 2026-08-20

## Граница проверки

Проверены ровно четыре `stale_request_key` из пятого production dry-run. Один компактный повтор потребовался только потому, что первый диагностический вывод был обрезан; оба прохода использовали существующий `ErpClient` и только официальный ERPNext REST API. Bitrix OAuth не запрашивался, SQL не читался и не изменялся, production backend не перезапускался.

На `2026-08-20T17:10:31.100Z` официальный snapshot содержал 58 Material Request, 86 Purchase Order, 57 Purchase Receipt и 191 Stock Entry — всего 392 ERP-документа. Временный скрипт удалён из production-контейнера, `/tmp` production-хоста и локального workspace.

## Фактическая причина

Все четыре ошибки относятся к одной прежней версии `MAT-MR-2026-00002`:

- сохранённый immutable key: `MAT-MR-2026-00002@2026-07-17 07:59:21.605617`;
- текущая заявка с тем же ERP-именем создана позже: `MAT-MR-2026-00002@2026-07-21 05:39:37.844596`;
- текущая заявка — draft, изменённый `2026-08-19`, и содержит 20 других SKU;
- ни один SKU четырёх старых документов не присутствует в текущей заявке.

| Документ | Состояние | Исторические данные | Проверенная интерпретация |
| --- | --- | --- | --- |
| `MAT-PRE-2026-00014` | canceled, создан и отменён 2026-07-17 | item `18096`, qty `1`; поле заказа `PUR-ORD-2026-00012` | старая приёмка; текущий PO с таким именем создан только 2026-07-21, теперь standalone и содержит другой item `16656` |
| `MAT-STE-2026-00042` | canceled | transfer `20298`, phase `ship`, item `7900` | часть полностью отменённого исторического lifecycle исчезнувшего transfer |
| `MAT-STE-2026-00043` | canceled | transfer `20298`, phase `receive`, item `7900` | та же историческая версия заявки и transfer |
| `MAT-STE-2026-00044` | canceled | transfer `20298`, phase `correction_extra`, item `7900` | та же историческая версия заявки и transfer |

Все четыре документа старше 24 часов и имеют `docstatus=2`. Transfer `20298` уже доказан тремя однородными canceled Stock Entry и представлен существующей моделью `source_missing_canceled`; его identity не реконструирует отсутствующий Bitrix payload или строки.

## Реализованная локальная модель

Автоматически заменить старый key текущим нельзя: это связало бы canceled документы от 17 июля с другой заявкой от 21 июля. Совпадение ERP `name` здесь не является идентичностью ревизии.

Узкий planner change:

1. распознавать только historical canceled stale revision: корректный сохранённый key с тем же именем, отличающимся creation, `docstatus=2`, возраст не меньше 24 часов, текущий source создан позже downstream-документа и не имеет пересечения SKU;
2. сохранять сам ERP-документ и исходные custom fields в evidence payload;
3. выдавать warning `historical_request_revision_unavailable`, не переписывая key;
4. не создавать link или line allocation к текущей заявке;
5. для `MAT-PRE-2026-00014` также не создавать link к текущему `PUR-ORD-2026-00012`: текущий заказ создан после приёмки и имеет другой item, то есть его имя тоже было переиспользовано;
6. сохранять проверенные Stock Entry → tombstone transfer `20298` links и существующие `historical_transfer_line_unavailable` warnings без allocations.

Draft, submitted, свежий, смешанный, неразбираемый key, source старше downstream или любое пересечение SKU остаются `stale_request_key` error. Эта консервативная граница не объявляет общее переиспользование имён безопасным.

Для неизменного snapshot ожидаемая дельта: 510 documents / 991 lines / **518 links** / 705 allocations; 2 live `missing_line_match` errors; 20 warnings (4 новых historical revision warnings, 4 оставшихся historical source-line warnings и 12 historical transfer-line warnings).

Baseline до кода: focused planner/snapshot `22/22`, общий typecheck успешен. После изменения focused suite `26/26`, полный backend `212/212`, общий typecheck и `git diff --check` успешны. Добавлены отдельные guards для canceled receipt, canceled purchase order, трехфазного canceled Stock Entry lifecycle и случая с пересечением SKU, который обязан остаться blocker.

Это пока локальная проверяемая модель. Commit, push, deploy, новый production dry-run, SQL writer, backfill apply и source switch не выполнялись.

## Уточнение предыдущего аудита

Предыдущий line-mismatch аудит считал link `MAT-PRE-2026-00014` → `PUR-ORD-2026-00012` доказанным только по custom field. Новый временной и revision-аудит опроверг это для текущего source: нынешний PO создан спустя четыре дня после canceled receipt и содержит другой SKU. Production read-only planner всё ещё включает две ложные document links этой приёмки; локальный change их исключает. SQL пуст, поэтому неверная связь не была записана.
