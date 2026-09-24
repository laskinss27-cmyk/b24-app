# Реквизиты организаций: production b24-app — 18.09.2026

Принимающая сторона b24-app включена для необязательного `order.business` в
событии `order.created` с `schemaVersion: 1`. Receiver и постоянный worker работают
на одном образе `b24-orders:business-20260918`, image ID
`sha256:113161b9865b559e2924c40aa8552ad1d917a72756cec41d90e379d954c94946`.

Фактическая точка приёма:
`https://201.51.12.57.sslip.io/api/integrations/umniydom/v1/orders`.
Разрешённый sourceId не менялся:
`9c0725f4-1634-423e-b11a-5168d3e47ffe`. Общий секрет не менялся и хранится только
в защищённой конфигурации receiver и отправителя.

Проверено после переключения:

- receiver — running/healthy, restart count 0;
- worker — running, restart count 0;
- локальный и публичный запросы с валидным `business` дошли до production-проверки
  режима и получили ожидаемый 403 для `test=true`; событие в очередь не записано;
- очередь до и после: 5 обработанных, 0 ожидающих, 0 истёкших аренд;
- внутренний и публичный `/health` основного backend успешны;
- read-only запрос основного backend к ERPNext успешен;
- `b24-backend` состоит в `erpnext_frappe_network`;
- monitor timer, backup timer и Docker retention работают успешно.

Перед переключением создана свежая локальная, проверенная восстановлением и внешняя
копия очереди: 5 записей, Disk file ID `110332`. Предыдущие образы сохранены для
отката: `b24-orders:routing-20260914` и `b24-orders:messages-20260914`.

Контракт для стороны магазина: [contracts/b24-business-v1.md](contracts/b24-business-v1.md).
Старые события не изменять и не отправлять повторно. Сторона магазина может
включить только новые события после установки существующих production URL,
sourceId и секрета в защищённой конфигурации.
