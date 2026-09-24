# Способ получения заказа: production b24-app — 18.09.2026

Принимающая сторона b24-app включена для необязательного `order.fulfillment` в
событии `order.created` с `schemaVersion: 1`. Receiver и постоянный worker работают
на одном образе `b24-orders:fulfillment-20260918`, image ID
`sha256:a1a37db5019eac7bdbf4d182e16699ddc03dfef5b268fdfcfa56a1967863741d`.

Endpoint, sourceId и секрет не менялись:

- endpoint: `https://201.51.12.57.sslip.io/api/integrations/umniydom/v1/orders`;
- sourceId: `9c0725f4-1634-423e-b11a-5168d3e47ffe`;
- общий production-секрет остаётся в защищённой конфигурации receiver и отправителя.

Проверено после переключения:

- receiver — running/healthy, restart count 0;
- worker — running, restart count 0;
- локальный delivery, публичные delivery, pickup и старое событие без fulfillment
  прошли контрактную проверку и получили ожидаемый 403 для `test=true`;
- тестовые события не записаны и CRM-операций не создавали;
- очередь до и после: 8 обработанных, 0 ожидающих, 0 истёкших аренд;
- интеграционные тесты: 25 passed; typecheck backend/frontend/shared успешен;
- smoke: 20 параллельных повторов дали одну запись и стабильную квитанцию;
- внутренний и публичный `/health` основного backend успешны;
- read-only запрос основного backend к ERPNext успешен;
- `b24-backend` состоит в `erpnext_frappe_network`;
- monitor timer, backup timer и Docker retention работают успешно.

Перед переключением создана свежая локальная, проверенная восстановлением и внешняя
копия очереди: 8 записей, Disk file ID `110334`. Предыдущий production-образ
`b24-orders:business-20260918` сохранён для отката.

Контракт: [contracts/b24-fulfillment-v1.md](contracts/b24-fulfillment-v1.md).

Сторона магазина может обновлять витрину и постоянный orders worker. Для новых
событий передавать строгий pickup либо delivery с адресом. Старые сохранённые
события не перестраивать и повторно не отправлять. Остальные поля, endpoint,
sourceId, секрет, hash, идемпотентность и `schemaVersion: 1` не менять.
