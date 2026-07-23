# HTTP-роуты бэкенда

Все `/api/*` принимают POST JSON `{domain, accessToken, ...}` (токен юзера из `BX24.getAuth()`), проверяют домен по allowlist и ходят в Б24 этим токеном. Ошибки бизнес-уровня возвращаются как `200 {ok:false, error}` (фронт показывает текст); `403` — плохой auth/домен; `400` — кривые аргументы.

## Служебные

| Роут | Что делает |
|---|---|
| `GET /health` | живость контейнера |
| `POST /install`, `/uninstall` | установка/снятие приложения на портале |
| `POST /app/handler` | обработчик приложения (включая обмен OAuth-кода — Б24 шлёт код сюда всегда) |
| `GET /m`, `/m/callback` | мобильный режим (QR-подсчёт): автономный OAuth + страница |
| `POST /placement-*` | точки встраивания (вкладка сделки, левое меню, шапка, задачи) — отдают HTML с бандлом |

## Каталог и инвентаризация

| Роут | Что делает |
|---|---|
| `POST /api/catalog/browse` | сборка Базы товаров (каталог+вариации+остатки+цены), кэш 5 мин, `force` |
| `POST /api/inventory/*` | CRUD инвентаризаций поверх entity `ctv_inv` (list/create/update/факты/удаление точки) |
| `POST /api/reports/sales` | отчёт по продажам за период |
| `POST /api/realizations/list` | окно «Реализации»: отгрузки → сделки (`from`/`to`, кэш 5 мин, `force`) |

## Вкладка сделки

| Роут | Вход (помимо auth) | Что делает |
|---|---|---|
| `POST /api/deal/search-products` | `q` | поиск товара по имени (iblock 24+26) + BASE-цена |
| `POST /api/deal/add-products` | `dealId, items[{productId,quantity,price?}]` | пачка `crm.item.productrow.add` (существующие строки не трогает) |
| `POST /api/deal/add-product` | `dealId, productId, quantity, price?` | одна строка (легаси одиночного флоу) |
| `POST /api/deal/variant-selection-cancel` | `dealId` | отменяет выбор клиента до начала складских операций и сохраняет текущий рабочий состав в ранее выбранном варианте КП |
| `POST /api/deal/fulfillment-setup` | `from` | административно создаёт служебное поле «Все позиции реализованы» и пересчитывает сделки с указанной даты |
| `POST /api/deal/export-xlsx` | `dealId, variantId?` | формирует Excel-снимок сделки или варианта КП без внутреннего названия варианта: товары идут перед работами, внизу расположены раздельные суммы и общий итог |
| `POST /api/deal/shipped` | `dealId` | состояние сделки: `rows` (строки серверным клиентом), `shipped` (rowId→отгружено), `reserves` (rowId→склады из резервов черновиков), `shipments` (партии с раскладкой `items`), `supply` (заявки снабжения), `orderId` |
| `POST /api/deal/realize` | `dealId, items[{rowId,productId,quantity,rowQuantity,price,name}]` | черновик-партия реализации (цикл см. features.md); ответ `{orderId, orderReused, shipmentId, accountNumber, dupRemoved}`; при ошибке `{ok:false, error, created{...}}` — артефакты для ручной зачистки |
| `POST /api/deal/supply-request` | `dealId, items[{name,quantity,measure}], storeToName?` | заявка снабжения: append в открытую или создание «Поставка № N_…» (+галка на сделке против робота); ответ `{mode:'created'\|'appended', cardId, title}` |
| `POST /api/supply/create-documents` | `requestName, dealId, toStore, lines[{productId,itemName,qty,action,fromStore?,supplier?}]` | создаёт сгруппированные документы по решению снабжения: перемещения сразу в транзит, закупки черновиками; повторно сверяет незакрытое количество и остатки |
| `POST /api/supply/purchase-receive` | `requestName, dealId, purchaseOrder, lines[{productId,qty,rate}]` | частично или полностью приходует заказ на серверно заданный приходный склад; проверяет статус «Заказано», связь документов и остаток к приёмке |
| `POST /api/supply/purchase-transfer` | `requestName, dealId, purchaseOrder, lines[{productId,qty}]` | создаёт и проводит перемещение фактически оприходованного товара со Склада Прихода в транзит к складу заявки; не перемещает закупленный запас сверх потребности точки |

## Снаб

| Роут | Вход (помимо auth) | Что делает |
|---|---|---|
| `POST /api/supply/request` | `dealId, lines[{productId,itemName,qty,note?}]` | кнопка «Заказ» во вкладке сделки: создаёт Material Request ядра по выбранным товарам |
| `POST /api/supply/orders` | — | рабочее место «Снаб»: все Material Request ядра по сделкам + название сделки из Б24 |

## Конвенции

- Серверные походы в Б24 — только `B24Client` (throttle, batch, типизированные ошибки).
- Пишущие роуты логируют шаги (`app.log.info`) — по логам ревизии восстанавливается, что успело создаться.
- Никаких автоматических удалений сущностей портала, кроме согласованного исключения: свежерождённый авто-дубль сделки/контакта от `sale.order.add` (гард «создан < 15 минут», только из авто-привязки этого заказа).
