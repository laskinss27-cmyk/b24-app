# Индекс scripts/

Скрипты живут untracked (кроме случаев, когда решим коммитить), запускаются `npx tsx scripts/<имя>.ts` из корня. Авторизация: `DEV_WEBHOOK` из `.env` (Б24), `ERPNEXT_TOKEN`/inline (ERPNext). **Конвенции:** read-only разведки — префикс `recon-`, write-тесты — `test-` (только на тестовых сделках, с перечнем созданных ID в выводе), зачистка — за Сергеем. Во всех сетевых вызовах — ретраи (`fetch failed` у Б24 — норма).

## Рабочие инструменты (хранить и поддерживать)

| Скрипт | Назначение |
|---|---|
| `erp-migrate-catalog.ts` | **Миграция Б24 → ERPNext**: склады/товары/остатки/сверка, идемпотентно (см. sklad-vynos.md) |
| `erp-poc-realization.ts` | POC «покрывала»: Delivery Note с `b24_deal_id`, проводка, обратное чтение |
| `cleanup-list.ts` / `cleanup-do.ts` | Перечень/зачистка тестовых артефактов (запуск — только по слову Сергея) |

## Ключевые разведки (история знаний; выводы перенесены в b24-rest-grabli.md)

| Скрипт | Что доказал |
|---|---|
| `recon-fable-deep.ts` | crm.orderentity.* существует и пишет (стена 1 пробита) |
| `recon-store-into-shipment.ts`, `recon-shipment-store.ts`, `recon-real-create-foundation.ts` | стена 2: складских методов отгрузки нет |
| `recon-productrow-storeid.ts` | storeId в строках сделки: заполнен у товаров проведённых реализаций; на запись read-only |
| `recon-draft-reserve-store.ts` | склад ЧЕРНОВИКА читается из резервов корзины |
| `recon-real-deal-link.ts`, `recon-crmpr-to-deal.ts`, `recon-real2deal-chain.ts` | цепочка отгрузка→`crm_pr_`→сделка (8/8) |
| `recon-order-client.ts` | userId заказа = менеджер; свойства клиента 40/44; propertyvalue.modify существует |
| `recon-equipment-order.ts`, `recon-supply-process.ts`, `recon-supply-1110.ts`, `recon-supply-rows.ts`, `recon-supply-positions.ts`, `recon-supply-who-creates.ts` | анатомия снабжения: 1110/1114, робот создаёт позиции на смене стадии |
| `recon-monitor-type.ts` | TYPE=4 у вариаций в строках сделки (баг «пропавший монитор») |
| `recon-orderentity-bydeal.ts` | crm.orderentity.list фильтруется по ownerId (сделке) |
| `recon-iblock60.ts` | справочник складов процесса: iblock 60, у вебхука нет scope lists |
| `recon-baza*`, `recon-product*`, `recon-offer*`, `recon-stock`, `recon-inventory` | каталог/вариации/остатки (фундамент Базы товаров) |
| `recon-sales-report.ts`, `recon-report-validate.ts` | отчёт по продажам и валидация математики |
| `test-orderentity-netzero.ts`, `test-shipment-draft.ts` | write-тесты пробития стены 1 (сделка 36754, заказ 956, #956/2) |
| `test-addproduct-netzero.ts` | net-zero тест «Добавить товар» |
| `bitrix-to-erpnext-leads.ts`, `erpnext-loop-demo.ts` | пилот интеграции Б24↔ERPNext (полный круг) |
| `test-proxy.ts` | поведение undici с локальным прокси (для истории граблей) |

Остальные `recon-*` — точечные разведки своего времени; перед удалением убедиться, что вывод перенесён в доки.
