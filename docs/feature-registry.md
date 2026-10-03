# Реестр правил интеграции заявок

Этот документ фиксирует новый модуль в ветке отдельного приёмника заявок сайта.
Он не заменяет реестр основного приложения и не подтверждает его готовность к выпуску.

| Правило | Поведение | Код и проверки |
| --- | --- | --- |
| CALLBACK-01 | `callback.requested` принимается отдельным API, после авторизации, проверки sourceId, режима, хеша и idempotency-key. Один лид «Заказ звонка», телефон, имя по желанию, страница без query/fragment, доказательство согласия. Уведомление в прежний чат менеджеров. | `integrations/umniydom/callback/`, `callback.test.ts` |
| CALLBACK-02 | Аддитивная callback_inbox_v1 в прежней резервируемой orders.sqlite. Повтор не создаёт второй лид. Неопределённый исход создания сверяется по внешнему идентификатору; неопределённое уведомление останавливается для ручной проверки. | `callback/store.ts`, `callback/worker.ts`, `callback.test.ts` |
| CALLBACK-03 | Opt-in UMNIYDOM_CALLBACK_ENABLED=1. Sandbox не вызывает live CRM. Команда тестов автоматически находит src/**/*.test.ts(x), включая новый модуль. | `integrations/umniydom/cli.ts`, `scripts/test-source.mjs` |
| CALLBACK-04 | Отдельный receiver/worker выпускается через `B24_RELEASE_TARGET=orders node scripts/b24-release.mjs build` и `B24_RELEASE_TARGET=orders bash scripts/b24-deploy.sh IMAGE FULL_SHA BASELINE`. Чистый отправленный Git, manifest всех исходников и собранных файлов, full-SHA labels/health, обязательная проверка непрерывности исходников. Остановленные кандидаты проверяются до переключения, старые контейнеры сохраняются; сбой восстанавливает оба ID и конфигурацию. | `b24-orders-guard.mjs`, `b24-orders-deploy.py`, `b24-release.test.mjs`, `b24-orders-deploy.test.py` |
| CALLBACK-05 | SQLite backup проверяется до миграции; монитор суммирует callback очереди сайта и приёмника без персональных данных. Основной b24-backend, ERP и существующие секреты не изменяются. | `deploy/orders-monitor.py`, `b24-orders-deploy.py` |

ERP, основной backend и форматы прежних заказов/планировщика не изменены.
Перед production нужен отдельный выпуск приёмника и проверка provenance относительно текущего b24-orders.

