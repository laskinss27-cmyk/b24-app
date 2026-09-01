# Единый механизм резервирования остатков: Stage 0

Дата аудита: 2026-09-01  
Исходная ревизия: `b738d998e0cdfbb9b3f419860fb69fece7191bc9` (`origin/main`)  
Статус на 2026-09-01: бизнес-правила зафиксированы; DDL `0009`-`0017` применён
к production после backup/restore drill; локальные runtime/API/UI реализованы и
проверены. Production runtime, backfill и source switch остаются выключены.

## Итог Stage 0

Сейчас в приложении нет единого резерва. Доступность вычисляется несколькими
несогласованными способами:

- часть маршрутов вычитает из `ERPNext Bin.actual_qty` строки Bitrix-перемещений;
- разные маршруты считают активными разные статусы одного перемещения;
- черновики реализации и списания не становятся резервами;
- `ERPNext Bin.reserved_qty` используется в аналитике, но не в проверках операций;
- Bitrix-корзина имеет собственные legacy-резервы;
- supply allocations описывают покрытие потребности, а не удержание физического
  остатка, но рядом с ними существует отдельный резерв перемещения;
- проверки и создание документов разделены сетевыми вызовами, поэтому два
  параллельных запроса могут одновременно пройти одну и ту же проверку.

Безопасный целевой контракт:

```text
available = ERPNext physical actual_qty
          - active b24_app reservation quantity
          - optional safety stock
```

`b24_app` должен стать источником истины только для обещаний/резервов приложения.
ERPNext остаётся единственным источником физического остатка и проведённых
складских документов. Supply mirror, Bitrix workflow и снимки инвентаризации не
могут становиться вторым источником физического остатка.

Это исходный аудит, на основании которого после ответов на вопросы были добавлены
DDL `0009`-`0017` и локальная реализация. Исторические формулировки Phase 0 ниже
описывают порядок принятия решения, а не текущее состояние production runtime.

## Неизменяемые границы

1. Физический остаток и проведённые складские/учётные документы читаются и
   изменяются только через официальный ERPNext API. Прямого доступа к таблицам
   ERPNext нет.
2. `b24_app` хранит только собственные резервные обязательства и их аудит. Он не
   копирует `actual_qty` как авторитетный остаток.
3. Frozen inventory snapshot не пересчитывается из-за последующих движений и не
   переписывается механизмом резервов.
4. `workflow_line_allocations` — количественная причинность supply workflow, а не
   резерв on-hand. Одна и та же единица не вычитается одновременно как allocation
   и reservation.
5. Записанный ERPNext movement потребляет резерв в той же бизнес-операции. После
   уменьшения физического остатка соответствующее количество не остаётся
   активным резервом.
6. Неопределённый результат внешней команды не трактуется как ошибка с
   автоматическим release. Резерв остаётся закрывающим доступность до сверки по
   идемпотентному ключу/ERP-документу.
7. Любой source switch требует полного checkpoint, shadow parity, отдельного
   ручного включения и сохранённого fallback.

## Что проверено в исходной ревизии

До изменения репозитория:

- `npm ci` — успешно;
- `npm -w @b24-app/backend test` — 304 основных теста и 5 OAuth pretest, все
  успешно;
- `npm run typecheck` — backend, frontend и shared успешно;
- `npm run build` — успешно вне ограниченной файловой песочницы; в самой
  песочнице Vite/esbuild не смог прочитать `vite.config.ts` из-за `Access denied`.

Последнее — ограничение среды запуска, а не ошибка проекта. Сборка сохранила
существующее предупреждение о frontend chunk больше 500 kB.

## Карта текущих фактов и источников истины

| Факт | Текущий источник | Целевой источник | Входит в available | Комментарий |
| --- | --- | --- | --- | --- |
| Физический остаток SKU на складе | ERPNext `Bin.actual_qty` через API | ERPNext API | Да, как база | Не зеркалировать как авторитетный факт |
| Проведённая реализация, списание, перемещение, приход | ERPNext документы через API | ERPNext API | Уже отражено в physical | Нельзя дополнительно вычитать завершённый резерв |
| Резерв перемещения приложения | Mutable JSON `ctv_transfers` в Bitrix | `b24_app` reservation ledger | Да, пока физическое движение не проведено | Legacy нужен как fallback до parity |
| Черновик ERP Delivery Note | ERPNext draft | Решение не принято | Возможно | Сейчас не вычитается последующими операциями |
| Черновик ERP Material Issue | ERPNext draft | Решение не принято | Возможно | Сейчас проверяется при create и submit, но сам не резервирует |
| Legacy-резерв Bitrix sale basket | Bitrix basket `reservations` | Решение о миграции/дедупликации не принято | Неизвестно | Отдельная вселенная от transfer reserve |
| ERPNext `Bin.reserved_qty` | ERPNext API | Решение не принято | В аналитике да, в enforcement нет | Возможен дубль другого обязательства |
| Потребность supply request | Material Request/Bitrix workflow | Текущий workflow; SQL mirror read-only | Нет | Это спрос, а не обещанный on-hand |
| Purchase Order allocation | Supply workflow/mirror | Текущий workflow; SQL mirror read-only | Нет | Это inbound plan, не on-hand reserve |
| `workflow_line_allocations` | `b24_app` supply mirror | Mirror evidence | Нет | `ordered/received/transferred/fulfilled/cancelled` не суммировать с резервом |
| Safety stock | Единого источника нет | Отдельная политика/таблица после решения | Да | В Stage 0 значение равно нулю |
| Frozen inventory count | Bitrix inventory point | Неизменяемый snapshot | Нет | Основа корректировки, не live availability |
| Доступность Tilda | ERPNext physical projection | В будущем Commerce API | Пока только physical | Контент/SEO Tilda не менять |

## Аудит текущих операций

### Перемещения

Основная проверка находится в
`packages/backend/src/routes/transfer-reservation-service.ts`:

- читает актуальный ERPNext physical stock;
- полностью загружает Bitrix registry перемещений;
- вычитает только статусы `draft` и `collected`;
- исключает текущее перемещение при редактировании/отправке;
- выполняет read/check отдельно от записи Bitrix или ERPNext.

При этом supply display и создание supply documents в
`api-supply-orders-route.ts` и `api-supply-document-creation-route.ts` считают
активным также `requested`. `deal-core-realization-route.ts` тоже вычитает
`requested`, а общий `validateFreeStock` — нет. Один и тот же остаток поэтому
зависит от маршрута.

Текущий lifecycle:

| Событие | Текущее состояние | Текущий эффект на остаток | Целевое событие |
| --- | --- | --- | --- |
| Создан transfer draft | `draft` | Плановые `lines` считаются резервом | `created/reserved` |
| Изменены строки | `draft/collected/requested` | Полная повторная проверка, затем overwrite JSON | `quantity_adjusted` с delta и версией |
| Собрано | `collected` | Резерв остаётся по planned `lines`, даже при расхождении сборки | Обычно без изменения; отдельный adjust при принятии расхождения |
| Отправлено | ERP Stock Entry submitted, затем `in_transit` | Physical source уменьшается; статус перестаёт считаться резервом | `consumed` после подтверждённого ERP submit |
| Отменено до отправки | `canceled` | Резерв исчезает | `cancelled`/полный release |
| Удалено после ERP movement | ERP документы отменяются/удаляются, Bitrix record удаляется | Physical может вернуться, история source исчезает | Новый резерв не воскрешать автоматически; сохранить audit event |
| В accepted добавлено сверх shipped | `accepted` | Проверяется только extra, но accepted не входит в active set | Краткий резерв delta до post либо атомарная команда |
| Проведено в destination | `posted` | Physical уже перемещён | Резерв source остаётся consumed |

Внутрипроцессные locks для отдельных transfer/supply operations не защищают от
другой replica и не образуют транзакцию с Bitrix/ERPNext. Параллельные create
могут пройти одинаковую проверку.

### Supply workflow и риск двойного учёта

Supply request, purchase, receipt, transfer и allocation образуют причинную
цепочку, но не все её звенья являются резервом:

```text
Material Request (спрос)
  -> Purchase Order (план входящего товара)
  -> Purchase Receipt submitted (physical увеличился)
  -> Transfer draft (резерв physical на source)
  -> Stock Entry submitted (physical source уменьшился, резерв consumed)
```

`workflow_line_allocations.transferred` связывает движение с потребностью. Это
не второй резерв того же количества. В reservation line должна храниться ссылка
на source workflow, но availability суммирует только активное количество
reservation ledger.

Текущая отмена Purchase Order считается терминальным разрешением прикреплённой
потребности и не открывает её заново. Это существующая бизнес-семантика, которую
нельзя молча менять в проекте резервов.

### Реализация сделки

Core route создаёт ERPNext Delivery Note drafts после проверки
`physical - active transfer JSON`. Созданные draft Delivery Note сами не
участвуют в последующей доступности; submit не повторяет unified check. Поэтому:

- два параллельных draft могут обещать один остаток;
- draft реализации и transfer могут конкурировать;
- ERPNext остаётся последним ограничителем только в момент submit, если его
  stock policy запрещает отрицательный остаток;
- permission `deals.reserve` существует, но отдельный доменный резерв в коде не
  найден.

Legacy `/api/deal/realize` использует Bitrix sale order/basket/shipment и читает
Bitrix basket reservations. Этот контур не согласован с core Delivery Note и
transfer reserve. Deal UI и stock enrichment в основном показывают raw ERPNext
physical stock, поэтому могут показывать уже обещанный товар как доступный.

### Списание и приход

Material Issue draft проходит `validateFreeStock` при создании и ещё раз перед
submit. Между ними он не удерживает товар, а другие issue drafts не вычитаются.
Приходной draft резерв не создаёт, что корректно: физический остаток увеличится
только после submit.

**Принятое решение:** Material Issue draft — только краткоживущая подготовка
документа и активного резерва не создаёт. Активный резерв не участвует в
валидации и не блокирует проведение Material Issue: документ проверяется и
проводится по physical stock средствами ERPNext. После достоверного submit
reservation reconciler читает новый physical stock через официальный ERPNext API
и, если активных обязательств стало больше физического остатка, необратимо
сокращает их через `shortfall` events. Неизвестный результат submit остаётся
`pending_reconcile` до проверки ERP-документа; TTL для такого результата не
используется.

### Marketplace

Продажа и bundle сначала проверяют `physical - transfer reserve`, затем сразу
создают ERPNext документы. Долгоживущий резерв здесь не нужен, но нужен общий
сериализованный availability gate:

1. создать короткий reservation command;
2. вызвать ERPNext с идемпотентной source identity;
3. при подтверждённом submit — consume;
4. при подтверждённой ошибке — release;
5. при неопределённом сетевом результате — `pending_reconcile`, не release.

Return увеличивает physical после submit и ограничивается остатком исходной
продажи, а не on-hand reserve.

### Ремонты

Customer repair использует отдельные `REPAIR-*` item codes и немедленные
проведённые движения. Это не обычный резерв продаваемого SKU.

Presale repair выбирает существующий товар и пытается сразу провести transfer в
ERPNext. Он должен входить в тот же короткий availability gate, иначе конкурирует
с продажей/перемещением. Текущий helper некоторых последующих status movements
преобразует ERP-ошибку в warning; резервный проект не должен скрывать такую
неопределённость.

### Инвентаризация

Новый путь создаёт issue/receipt adjustment drafts из frozen difference. Движения
после открытия инвентаризации не являются основанием переписать снимок. Механизм
резервов не меняет snapshot и не пересчитывает его относительно live stock.

**Принятое решение:** инвентаризация и резерв не пересекаются. Инвентаризация
считает и корректирует только физический ERPNext stock, не читает SQL reservations
и не блокируется ими. Резерв не уменьшает physical stock: он лишь скрывает
зарезервированное количество от продажи и нецелевого перемещения. После
подтверждённой инвентаризационной корректировки отдельный reconciler сравнивает
обновлённый physical с суммой активных обещаний и при дефиците создаёт необратимые
`shortfall` events. Сам inventory workflow не создаёт, не consume и не release
reservation events и не изменяет frozen snapshot.

### Аналитика и внешняя витрина

`assortment-matrix.ts` и `turnover-report.ts` читают ERPNext
`Bin.reserved_qty`, тогда как operational validators его не вычитают. Нельзя
добавить его в формулу автоматически: он может быть либо отдельным реальным
обязательством, либо дублем Bitrix/ERP workflow.

Tilda projection сейчас публикует ERPNext physical Shelly. До Commerce API и
проверенной reservation read model менять её нельзя.

## Целевая модель состояний

### Резерв — overlay доступности, а не складское движение

SQL reservation никогда не меняет ERPNext physical stock. Он участвует только в
решении, можно ли обещать или направить товар другой операции:

```text
available_for_unrelated_operation = physical
                                  - active reservations
                                  - safety stock
```

Исходная реализация сделки и целевое перемещение, породившие собственный резерв,
могут использовать его по своей source identity. Продажи и перемещения с другой
source identity видят зарезервированное количество как недоступное.
Инвентаризация всегда работает с raw physical и полностью обходит reservation
overlay.

Резерв — мягкое обещание, а не запрет на проведение физического документа.
Списание, инвентаризационная корректировка и иное подтверждённое уменьшение
physical stock проводятся независимо от резерва. После такого движения активное
количество резервов по warehouse/item сокращается до величины, которую ещё
поддерживает physical stock. Например, при `physical = 4` и `active reserve = 4`
инвентаризационное списание одной единицы даёт `physical = 3`, `active reserve =
3`, `shortfall_qty = 1`. Последующий приход не восстанавливает потерянную единицу
резерва: новое обещание требует нового approval.

### Принятое решение: резерв сделки одобряет снабжение

Менеджер сделки не создаёт активный резерв напрямую. Кнопка в сделке создаёт
**заявку на резерв** и передаёт в снабжение:

- сделку и стабильную revision исходных строк;
- склад, товар и количество;
- желаемый срок окончания резерва;
- автора и время запроса.

Пока заявка ожидает решения снабжения, она не уменьшает `available`. Снабжение
может:

1. одобрить заявку с запрошенным сроком;
2. изменить срок и затем одобрить заявку;
3. отклонить заявку без создания резерва.

Одобрение — единственная команда, создающая активный резерв сделки. Она должна в
одной SQL-транзакции заблокировать все `(warehouse, item)`, повторно получить
physical stock через ERPNext API, проверить актуальные активные резервы и либо
создать весь согласованный резерв, либо не создать ничего. Недостаточный или
неполный ERP-ответ завершает approval fail closed и оставляет заявку без
активного резерва.

Частичное одобрение запрещено. Заявка одобряется только целиком по всем строкам и
количествам. Если хотя бы одной позиции недостаточно, ни одна строка не попадает
в активный резерв. Чтобы запросить другой состав или количество, менеджер
создаёт новую revision заявки; снабжение при рассмотрении может менять только
срок резерва.

Запрошенный и утверждённый сроки хранятся отдельно. Изменение срока снабжением,
approval, rejection и последующее expiry записываются append-only событиями с
акторами. После наступления утверждённого срока активный остаток резерва
освобождается отдельной идемпотентной expiry-командой.

Permission `deals.reserve` в этой модели разрешает только отправить заявку.
Одобрение, изменение срока и отклонение требуют отдельного права снабжения,
например `supply.manage_reservations`.

### Досрочное снятие и реализация своей сделки

Менеджер не освобождает одобренный резерв напрямую. Кнопка в сделке создаёт
запрос на досрочное снятие; активное количество продолжает уменьшать
`available`, пока снабжение не одобрит release. Решение снабжения и причина
сохраняются в append-only audit.

Исключение — проведённая реализация той же сделки, для которой резерв был
одобрен. Такой документ не должен блокироваться собственным резервом:

```text
available_for_own_deal = physical
                       - active reservations of other sources
                       - safety stock
```

Связь подтверждается одновременно по deal/source identity, warehouse, item и
активной revision резерва. Чужой резерв исключать из проверки нельзя. Если
реализуется количество больше собственного active reserve, превышение должно
помещаться в обычный свободный остаток после вычета всех чужих резервов.

Создание Delivery Note draft резерв не погашает. Только подтверждённый ERPNext
submit создаёт идемпотентное событие `consumed` по фактически проведённым строкам.
При частичной реализации уменьшается только соответствующее количество, а
остаток продолжает действовать до следующей реализации, одобренного release или
expiry. Неопределённый результат submit не освобождает резерв и переводит команду
в `pending_reconcile` до проверки ERP-документа через API.

Резерв одноразовый и после approval монотонный: `reserved_qty` неизменяемо, а
`active_qty` может только уменьшаться через consume/release/expiry. Отмена
Delivery Note, возврат покупателя, повторная покупка или любые последующие
движения не уменьшают `consumed_qty` и не воскрешают резерв. Вернувшийся в ERPNext
physical stock становится обычным доступным остатком. Если товар нужно обещать
снова, создаётся новая заявка и проходит новое одобрение снабжением независимо от
покупателя и истории прежней реализации.

### Принятое решение: перемещение снабжения резервирует сразу

Если перемещение создаёт сотрудник снабжения, отдельная заявка и дополнительный
approval не нужны: само создание перемещения является решением снабжения и
атомарно создаёт активный резерв по складу-источнику. Создание выполняется
all-or-nothing по всем строкам после блокировки availability keys и повторной
проверки ERPNext physical stock.

Запрос на перемещение, созданный вне снабжения, активного резерва не создаёт.
Резерв появляется только когда снабжение принимает запрос и создаёт из него
рабочее перемещение. Поэтому целевой статус `requested` сам по себе не участвует
в availability; stable source identity рабочего transfer начинается с принятого
снабжением документа.

До отправки снабжение может изменить строки рабочего перемещения. Изменение
выполняется одной versioned-командой: увеличение проходит новую проверку
доступности целиком, уменьшение создаёт release event. После подтверждённого
ERPNext Stock Entry submit резерв source-склада consume. Отмена до отправки
release активное количество. Отмена или удаление уже проведённого движения не
воскрешает consumed reserve автоматически.

У резерва перемещения нет TTL и автоматического expiry. Он действует до
подтверждённой отправки или явной отмены; зависший workflow требует сверки, а не
освобождения по времени.

### Header state

- `active` — есть `active_qty > 0` хотя бы в одной строке;
- `consumed` — всё удержанное количество подтверждённо превратилось в проведённое
  физическое движение;
- `released` — обязательство снято без отмены source;
- `cancelled` — source document/operation отменён;
- `expired` — TTL закончился и expiry-команда зафиксирована;
- `shortfall` — весь остаток обещания необратимо утрачен из-за подтверждённого
  уменьшения physical stock;
- `closed` — `active_qty = 0`, но итог составлен из нескольких причин
  (`consumed/released/shortfall`), поэтому одна причина не описывает весь header;
- `pending_reconcile` — результат внешнего ERP/Bitrix действия неизвестен;
- `superseded` — legacy source заменён новым source revision без двойного учёта.

Для частичного consume/release/shortfall состояние header вычисляется после
обновления всех строк. Пока хотя бы у одной строки есть `active_qty > 0`, header
остаётся `active`; терминальная причина определяется после полного обнуления.
Количества строки:

```text
active_qty = reserved_qty - consumed_qty - released_qty - shortfall_qty
reserved_qty >= 0
consumed_qty >= 0
released_qty >= 0
shortfall_qty >= 0
consumed_qty + released_qty + shortfall_qty <= reserved_qty
```

`cancelled` и `expired` — причины полного release, а не отрицательные движения.
`consumed_qty`, `released_qty`, `shortfall_qty` и вычисляемое из них уменьшение
`active_qty` необратимы; отрицательных compensate/reopen events в reservation
ledger нет. `shortfall_qty` означает часть первоначального обещания, которую
больше не поддерживает подтверждённый physical stock; это не consume сделки и не
release по решению пользователя.
Любое изменение количества создаёт append-only event. Проекция header/line может
обновляться в той же SQL-транзакции, но event не обновляется и не удаляется.

### События по типу source

| Source | Create | Extend/adjust | Consume | Release/expire |
| --- | --- | --- | --- | --- |
| Transfer | Сразу при создании перемещения снабжением или принятии внешнего запроса; pending request не резервирует | Versioned all-or-nothing adjust до ship | После подтверждённого ERP source Stock Entry submit | Без TTL; cancel до ship release; после consume автоматического воскрешения нет |
| Core deal | После approval заявки снабжением; pending request не удерживает stock | После approval количество не увеличивается и строки не переписываются | Delivery Note submit той же сделки частично/полностью consume свой reserve и не блокируется им; cancel/return не воскрешает consume | Rejection до approval не создаёт резерв; досрочный release одобряет снабжение; active remainder освобождается при release/expiry |
| Material Issue | Draft не резервирует; reserve overlay не блокирует submit | Изменение draft не влияет на reservation | Подтверждённый Stock Entry submit меняет physical и запускает shrink reconciliation | Подтверждённая ошибка не меняет reserve; unknown остаётся pending_reconcile без TTL |
| Marketplace | В начале короткой команды | Обычно нет | Успешный ERP submit | Подтверждённая ошибка; unknown остаётся reconcile |
| Presale repair | Перед первым ERP movement | Обычно нет | Успешный ERP submit | Подтверждённая ошибка; unknown остаётся reconcile |
| Manual transfer request | Не резервирует до принятия снабжением и conversion в рабочее перемещение | При conversion создаётся transfer reserve | По lifecycle рабочего transfer | Cancel request без reservation event |
| Supply demand/purchase | Не создаёт on-hand reserve | — | — | — |
| Inventory adjustment | Не создаёт reserve и не читает reservation overlay | — | Меняет только ERPNext physical stock | Snapshot не менять; reservation lifecycle не затрагивать |

## Минимальная SQL-схема для следующего этапа

Логическая схема зафиксирована в DDL `0009`-`0017`. Полный и повторный
изолированный MariaDB 11.8 rehearsal подтвердил 9 reservation tables, 32 CHECK
constraints и 11 foreign keys. После отдельного разрешения файлы применены к
production, а post-DDL dump успешно восстановлен и сравнен. Таблицы пусты,
`B24_APP_RESERVATIONS=off`.

### `stock_availability_keys`

Строка сериализации для каждой пары `(erp_warehouse_name, item_code)`:

- `erp_warehouse_name VARCHAR(...)`;
- `item_code VARCHAR(...)`;
- `version BIGINT UNSIGNED`;
- `updated_at DATETIME(6)`;
- primary key `(erp_warehouse_name, item_code)`.

Отдельная lock row нужна даже когда активных резервов ещё нет: `SELECT ... FOR
UPDATE` по пустому набору reservation lines не сериализует два первых запроса.
Ключи всегда блокируются в отсортированном порядке, чтобы избежать deadlock.

Warehouse identity — каноническое ERPNext `Warehouse.name`, полученное через API,
а не изменяемый UI title. Legacy backfill должен fail closed, если title нельзя
однозначно сопоставить.

### `stock_reservations`

- `id BIGINT UNSIGNED` primary key;
- `reservation_key CHAR(36) CHARACTER SET ascii` unique;
- `source_system VARCHAR(...) CHARACTER SET ascii`;
- `source_type VARCHAR(...) CHARACTER SET ascii`;
- `source_id VARCHAR(...)`;
- `source_revision_key VARCHAR(...)` для номера, hash или другого стабильного
  ключа ревизии;
- `status VARCHAR(...) CHARACTER SET ascii`;
- `expires_at DATETIME(6) NULL`;
- `approved_at DATETIME(6)` — также определяет приоритет shortfall;
- `version BIGINT UNSIGNED` для optimistic concurrency;
- `created_by`, `created_at`, `updated_at`;
- `approved_request_id BIGINT UNSIGNED NULL` unique для резерва сделки;
- unique canonical source identity после утверждения cardinality.

Не использовать MariaDB `ENUM`: состояния будут вводиться по фазам и должны
валидироваться приложением/constraint без table rebuild.

### `stock_reservation_requests`

Заявка снабжению существует отдельно от активного резерва:

- `id BIGINT UNSIGNED` primary key;
- `request_key CHAR(36) CHARACTER SET ascii` unique;
- `source_system`, `source_type`, `source_id`, `source_revision_key`;
- `status`: `pending/approved/rejected/withdrawn`;
- `requested_expires_at DATETIME(6)`;
- `approved_expires_at DATETIME(6) NULL`;
- `requested_by`, `requested_at`;
- `reviewed_by`, `reviewed_at`, `rejection_reason` nullable;
- `version BIGINT UNSIGNED` и timestamps;
- unique canonical source revision, исключающий две активные pending-заявки на
  одно состояние сделки.

`pending` не участвует в формуле availability. `approved` обязан ссылаться ровно
на один созданный `stock_reservations`; `rejected` не создаёт reservation.

### `stock_reservation_request_lines`

- `id BIGINT UNSIGNED` primary key;
- `request_id` foreign key;
- `source_line_key`, `erp_warehouse_name`, `item_code`;
- `requested_qty DECIMAL(21,9)`;
- unique `(request_id, source_line_key, erp_warehouse_name, item_code)`;
- checks для положительного количества.

После approval строки заявки остаются неизменяемым audit input. В reservation
lines копируется утверждённый набор; последующие изменения активного резерва не
переписывают исходную заявку.

### `stock_reservation_release_requests`

Запрос менеджера на досрочное снятие хранится отдельно от reservation projection:

- `request_key` unique и `reservation_id` foreign key;
- `status`: `pending/approved/rejected/withdrawn`;
- автор, время и причина запроса;
- автор, время и причина решения;
- generated nullable `pending_reservation_id` с unique key, поэтому для одного
  резерва существует не больше одного ожидающего запроса.

В первой версии запрос относится ко всему активному остатку резерва на момент
approval. Частичный ручной release потребует отдельного line-level решения и не
подразумевается этой схемой.

### `stock_reservation_lines`

- `id BIGINT UNSIGNED` primary key;
- `reservation_id` foreign key;
- `source_line_key VARCHAR(...)`;
- `erp_warehouse_name VARCHAR(...)`;
- `item_code VARCHAR(...)`;
- `reserved_qty DECIMAL(21,9)`;
- `consumed_qty DECIMAL(21,9)`;
- `released_qty DECIMAL(21,9)`;
- `shortfall_qty DECIMAL(21,9)`;
- stored generated `active_qty = reserved - consumed - released - shortfall`;
- `version BIGINT UNSIGNED`;
- timestamps;
- unique `(reservation_id, source_line_key, erp_warehouse_name, item_code)`;
- checks для неотрицательных количеств и
  `consumed + released + shortfall <= reserved`;
- index для active sum по warehouse/item/status.

`productId` недостаточен: ERP item code строковый, а часть доменов использует
нечисловые коды. Optional link на supply workflow хранится как source identity,
не как количество, участвующее в availability.

### `stock_reservation_commands`

- `id BIGINT UNSIGNED` primary key;
- `idempotency_key VARCHAR(...) CHARACTER SET ascii` unique;
- `reservation_id` nullable до результата create, optional links на исходную
  reserve/release request;
- `command_type`, `request_hash BINARY(32)`;
- `status`: `started/applied/failed/pending_reconcile`;
- `external_doctype`, `external_document_name` nullable;
- `started_at`, `finished_at` nullable;
- actor/correlation/causation identifiers.

Повтор с тем же ключом и тем же hash возвращает прежний результат; тот же ключ с
другим hash отклоняется. `pending_reconcile` нельзя автоматически превращать в
release.

### `stock_reservation_events`

- `id BIGINT UNSIGNED` monotonic primary key;
- `reservation_id` обязателен, `reservation_line_id` nullable для header events;
- `command_id` foreign key;
- `event_index` и unique `(command_id, event_index)`;
- `event_type`;
- `quantity DECIMAL(21,9) NULL`;
- `from_status`, `to_status` nullable;
- `reservation_version`;
- actor fields и `occurred_at DATETIME(6)`;
- составной foreign key не позволяет привязать line event к чужому reservation.

Таблица append-only. Runtime writer получает `SELECT/INSERT` на events и только
необходимые `SELECT/INSERT/UPDATE` на projection tables; без `DELETE`, DDL и
доступа к ERPNext DB.

### `stock_reservation_backfill_checkpoints`

Ручной legacy apply допускается только для полного deterministic plan без errors.
Checkpoint хранит `plan_hash`, единый `observed_at`, counts трёх исходных наборов,
число созданных reservation/line/shortfall projections и warnings. Unique
`plan_hash` делает точный повтор no-op; другой hash требует нового явного apply.

### Least-privilege роли для reservation rollout

Production grants этим DDL не выдаются. Перед первым authoritative write нужны
отдельные identities:

- migrator: DDL только на `b24_app`, отсутствует в backend environment;
- reservation runtime: `SELECT` на рабочие reservation tables, `INSERT` на
  commands/events/requests/projections и только column-scoped `UPDATE` состояний,
  audit-полей, version и трёх reduction quantities; без `DELETE`, DDL и ERPNext DB;
- backup: `SELECT/SHOW VIEW/TRIGGER`, server-only option file;
- one-shot legacy backfill: временные `SELECT/INSERT/UPDATE`, без DDL и `DELETE`,
  после apply удаляется из окружения.

Request lines и events после insert не получают runtime `UPDATE`. Точные grants
создаются только после backup/restore drill и отдельного production разрешения.

### Safety stock

Safety stock — отдельная policy/read model, не тип reservation. До решения о
приоритетах, расписании и областях действия он равен нулю. В будущем правило
может быть keyed by warehouse/item и иметь effective interval/version, но не
должно смешиваться с ledger событий обязательств.

## Атомарный алгоритм reserve-aware availability command

Внешний ERPNext и MariaDB нельзя объединить одной транзакцией. Минимальная
безопасная модель — serialized reservation transaction плюс явная saga:

1. Нормализовать source identity, canonical ERP warehouse/item и агрегировать
   повторяющиеся строки.
2. Начать SQL-транзакцию и зарегистрировать/прочитать idempotency command.
3. Создать отсутствующие availability keys, затем заблокировать все ключи
   `FOR UPDATE` в детерминированном порядке.
4. Пока locks удерживаются, повторно прочитать physical stock через официальный
   ERPNext API. Timeout/неполный ответ — fail closed.
5. Суммировать активные SQL reservation quantities, исключая редактируемый
   reservation, и применить safety policy.
6. Если `requested > physical - active - safety`, отклонить команду без partial
   reservation.
7. Записать projection и append-only events одной SQL-транзакцией.
8. Для долгого обязательства commit завершает create/adjust.
9. Для немедленного ERP movement вызвать ERPNext после commit. После достоверного
   результата отдельной идемпотентной командой consume или release; неизвестный
   результат переводит command/reservation в `pending_reconcile`.
10. Reconciler ищет ERP document только через API и завершает тот же command. Он
    не создаёт новый резерв и не угадывает результат по изменению общего остатка.

Этот gate обязателен для approval/create/increase резерва и для app-операций,
которые по бизнес-правилу должны уважать чужой резерв: продажа и нецелевое
перемещение. Он устраняет гонки между репликами приложения, но не является
глобальным складским замком и не применяется для списания, инвентаризационной
корректировки или другого разрешённого физического документа.

После подтверждённого уменьшения physical stock выполняется отдельная
идемпотентная shrink reconciliation:

1. Через официальный ERPNext API получить актуальный physical stock для
   затронутых warehouse/item.
2. В SQL-транзакции заблокировать соответствующие availability keys в
   детерминированном порядке. Если физический документ имеет source identity
   собственного резерва (реализация сделки или отправка целевого перемещения),
   сначала consume фактически проведённые строки этого резерва. Эти единицы не
   являются shortfall.
3. После собственного consume посчитать total active reservations. Если
   `total_active <= physical`, ничего не менять: приход не увеличивает ранее
   сокращённый резерв.
4. Если `total_active > physical`, вычислить deficit и снимать его с самых новых
   активных обещаний: `approved_at DESC`, затем `reservation_id DESC`, затем
   `reservation_line_id DESC`. Более ранние approvals защищены. Одна транзакция
   продолжает этот порядок до полного покрытия deficit.
5. На каждое уменьшение увеличить `shortfall_qty` и записать append-only
   `shortfall` event с identity физического документа/checkpoint. Повтор той же
   reconciliation не создаёт второе уменьшение.
6. При внешнем движении, которое не прошло через приложение, периодический
   reconciler выполняет тот же алгоритм; неполный ответ ERP fail closed и не
   меняет projection.

Ни reconciliation, ни reservation ledger не изменяют ERPNext stock. Они только
приводят мягкие обещания в соответствие с подтверждённым физическим фактом.

## Поэтапное внедрение

### Phase 0 — этот документ

- Никакого DDL/runtime/config change.
- Зафиксированы источники, расхождения, lifecycle, схема и вопросы.
- После бизнес-ответов — отдельный review схемы и DDL.

### Phase 1 — DDL disabled

- Добавить отдельные миграции только после утверждения вопросов.
- Миграции остаются ручными; startup migration запрещена.
- `B24_APP_RESERVATIONS=off` по умолчанию и единственное разрешённое значение на
  первом шаге.
- До любых authoritative SQL writes: расширить отдельный backup, провести restore
  drill, зафиксировать checkpoint/rollback, создать least-privilege роли.

### Phase 2 — read-only legacy plan/backfill/mirror

- Снять полный checkpoint transfer registry и выбранных legacy reservations.
- Построить deterministic plan без DML: source counts, unmapped warehouse/items,
  invalid quantities, duplicate identities, status distribution.
- Автоматически допустимы только однозначные активные Bitrix transfers в
  `draft/collected`. Они получают source identity по entity ID и hash текущей
  revision; terminal transfers остаются evidence и не создают active reserve.
- Legacy `requested` блокирует plan: текущие validators расходятся в том,
  резервирует ли этот статус товар, поэтому backfill не угадывает смысл.
- Native basket reservations без зафиксированных supply approval и approved TTL,
  а также положительный ERPNext `Bin.reserved_qty` без stable source identity
  являются blockers, а не строками для автоматического импорта или дедупликации.
- Если сумма однозначных legacy transfers превышает подтверждённый physical,
  plan сразу создаёт monotonic shortfall от новых transfers к старым; исходный
  `reserved_qty` сохраняется как audit fact.
- Неполный/error plan запрещено применять.
- Manual atomic apply отдельной командой только после явного разрешения.
- Повторный snapshot доказывает полноту; legacy Bitrix path остаётся fallback.

### Phase 3 — shadow calculation

- Новый режим `shadow`, но ответы и enforcement остаются legacy.
- На одном и том же запросе сравнивать physical, legacy active reserve и SQL
  active reserve из одного полного reservation checkpoint.
- Записывать только агрегированные метрики/безопасные IDs, не токены и не
  чувствительные payloads.
- Unknown/incomplete source не превращать в ноль или успешное сравнение.
- Gate: ноль необъяснённых double counts, status mismatches и отрицательной
  availability на согласованном окне.

### Phase 4 — availability display

- Сначала только read model/UI: physical, reserved, safety, available, freshness и
  completeness.
- Rollout по endpoint/warehouse, с feature flag и немедленным fallback.
- Никаких write/enforcement изменений на этой фазе.
- Tilda не переключать; будущая витрина читает только Commerce API.

### Phase 5 — enforcement и writes

- Включать по одному source type: сначала transfer, затем явно выбранные deal/
  stock drafts, затем короткие marketplace/presale команды.
- Для каждого типа обязательны create, adjust, partial consume, release, cancel,
  expiry (если разрешён), retry/idempotency, unknown-result reconciliation и
  concurrency tests.
- Старый validator остаётся fallback до доказанной parity и отдельного source
  switch.
- Нельзя считать фазу завершённой без multi-replica concurrency test и проверки,
  что один physical movement не остаётся также active reservation.

### Phase 6 — Commerce API

- Единый API возвращает безопасную доступность, а не раскрывает внутренние
  ERPNext/Bitrix детали.
- Tilda использует только Commerce API; content/SEO остаются отдельно.
- Cart/order TTL и подтверждение оплаты вводятся как отдельные source lifecycle,
  не наследуют TTL transfer по умолчанию.

## Критерии качества и тестовый контур следующего этапа

- Два параллельных reserve одного последнего остатка: ровно один success.
- Параллельный transfer и marketplace sale: нет oversell.
- Повтор command с тем же idempotency key: тот же результат, без второго event.
- Тот же key с другим request hash: conflict.
- Partial consume/release сохраняет точный active remainder.
- При `physical 4 -> 3` и активном reserve 4 складской документ проводится,
  reserve становится 3, `shortfall_qty = 1`.
- Последующий приход не восстанавливает shortfall; увеличение возможно только
  новым approved request.
- При двух резервах одного warehouse/item физический дефицит сначала сокращает
  самый новый approval; одинаковое `approved_at` разрешается по
  `reservation_id DESC`, затем `reservation_line_id DESC`.
- Cancel/return после consume не воскрешает резерв; повторное обещание требует
  новой одобренной заявки.
- ERP success + потерянный HTTP response: `pending_reconcile`, затем consume по
  найденному document identity, без release/retry duplicate.
- Transfer ship уменьшает physical и одновременно обнуляет active source reserve.
- Своя реализация/целевое перемещение использует собственный reserve; чужая
  продажа или нецелевое движение видит это количество недоступным.
- Подтверждённое движение собственного source сначала consume его reserve и не
  записывается как shortfall; дефицит считается только после этого consume.
- Supply allocation и transfer reserve не суммируются как два удержания.
- Legacy и SQL source identity не дают двойного резерва в shadow.
- Expiry не освобождает типы source, для которых TTL запрещён.
- Frozen inventory snapshot byte-for-byte/semantic unchanged после movement и
  reservation events.
- Inventory preview/save/submit читает raw ERPNext physical stock, не блокируется
  активными reservations и не создаёт reservation events.
- Неполный checkpoint/ERP response fail closed.
- Backfill plan/apply повторяем и детерминирован.

## Вопросы, без которых нельзя утверждать DDL и lifecycle

1. **Решено: сделка обещает товар только после approval снабжением.** Кнопка
   менеджера создаёт pending-заявку с желаемым сроком и не уменьшает available.
   Снабжение может изменить срок, одобрить или отклонить заявку. Approval всегда
   all-or-nothing: состав и количество снабжение не меняет. Менеджер может только
   запросить досрочное снятие, release одобряет снабжение. Проведённая реализация
   исходной сделки не блокируется своим резервом и consume его по фактическим
   строкам.
2. **Решено: Material Issue draft не резервирует, а активный резерв не блокирует
   его submit.** ERPNext проводит документ по physical stock. После
   подтверждённого уменьшения physical reconciler необратимо сокращает
   неподдерживаемую часть резервов через `shortfall`; unknown ERP result остаётся
   `pending_reconcile`, а не трактуется как подтверждённое движение.
3. **Решено для rollout: неоднозначный legacy не угадывается.** Автоматический
   plan принимает только `draft/collected` transfers. `requested`, native Bitrix
   basket reservations без supply approval/TTL и положительный ERPNext
   `Bin.reserved_qty` без stable source identity остаются blockers до отдельной
   атрибуции; совпадение количеств не считается доказательством дубля.
4. **Решено: TTL имеет только одобренный резерв сделки** и равен сроку,
   утверждённому снабжением. Transfer действует без TTL до ship/cancel. Material
   Issue submit и другие короткие внешние команды не освобождаются по timeout:
   unknown result остаётся `pending_reconcile` до явной сверки.
5. **Решено: инвентаризация и резерв не конфликтуют на уровне исполнения.**
   Инвентаризация читает и корректирует raw ERPNext physical stock, не проверяет
   reservation overlay и не блокируется им. После подтверждённой корректировки
   отдельный reconciler уменьшает active reserve до поддерживаемого physical;
   само inventory workflow reservation ledger не редактирует.
6. **Решено: shortfall распределяется от новых резервов к старым.** Более ранние
   одобренные обещания защищены; дефицит снимается в порядке `approved_at DESC`,
   затем `reservation_id DESC`, затем `reservation_line_id DESC`. Правило
   применяется одинаково в синхронной и периодической reconciliation.
7. **Решено: текущую семантику cancelled Purchase Order сохраняем.** Отмена
   продолжает закрывать соответствующую потребность и не открывает её снова. Это
   отдельное правило demand planning и оно не создаёт on-hand reservation.

Ответы получены и отражены выше. Отдельно разрешён и выполнен только production
DDL с backup/restore drill. Backfill, runtime DML, source switch, deployment и
изменение production-конфигурации по-прежнему требуют отдельной команды.
