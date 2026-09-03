# SQL-нумерация перемещений — локальный фундамент 3 сентября 2026

## Зачем это нужно

Сейчас номер перемещения совпадает с ID записи `ctv_transfers` в Bitrix24.
Поэтому нельзя безопасно сделать создание SQL-first простой перестановкой
вызовов: до обращения к Bitrix у приложения нет номера документа, а сбой между
двумя системами оставляет сироту и делает повторный клик неидемпотентным.

Следующий source switch должен отделить пользовательский номер документа от
технического ID Bitrix. При этом существующие номера обязаны остаться прежними.

## Подготовленный change set

Миграции `0032`-`0034` только готовят идентичность:

- `stock_transfer_records.public_id` — nullable и unique, поэтому DDL можно
  применить без мгновенного изменения рабочих данных;
- `stock_transfer_public_ids` — SQL-аллокатор будущих номеров; в него сначала
  заносятся все существующие Bitrix ID, поэтому следующий автоматический номер
  будет больше текущего максимума без жёстко заданного диапазона;
- `stock_transfer_identity_checkpoints` — доказательство одного точного
  детерминированного backfill.

One-shot runner `transfers:identity-backfill` строит план без записи. Для каждого
существующего transfer целевое значение строго равно текущему Bitrix ID. Apply
возможен только с точным SHA-256 плана, под named lock и одной транзакцией. Он
fail-closed останавливается при дубликате, изменившемся наборе строк, конфликте
уже назначенного номера или занятом allocator ID. Повтор того же плана читает
checkpoint и является no-op.

SQL `JSON`, физическое удаление и доступ к ERPNext таблицам не используются.

## Проверено локально

- unit tests: стабильный hash до/после заполнения, conflict gate, atomic apply,
  checkpoint no-op и запрет неподтверждённого hash;
- migration contract и workspace typecheck;
- изолированная MariaDB `11.8.8`: `0023`-`0034`, повтор migrations no-op,
  transfer backfill, identity backfill, повтор identity no-op, parity номеров,
  append-only revision flow и запрет `DELETE`/DDL для DML-only пользователя.

Временная база, пользователь и контейнер репетиции удалены.

## Чего этот этап пока не делает

- миграции и backfill не запускались в production;
- runtime по-прежнему читает живой Bitrix для verified parity;
- Bitrix по-прежнему первым создаёт transfer и выдаёт его ID;
- `bitrix_external_id` остаётся обязательным;
- никаких env-флагов и production-контейнеров не менялось.

## Следующие отдельные ворота

1. Перед DDL расширить production backup `b24_app`, выполнить внешний read-back
   и restore drill.
2. Применить только `0032`-`0034`, не меняя runtime.
3. Отдельным DML-only пользователем получить dry-run hash и после явного
   подтверждения применить ровно его; проверить parity и повторный no-op.
4. Только после этого добавить SQL-native create: аллокацию `public_id`,
   idempotency command и transactional revision/outbox.
5. Доказать восстановление после сбоя Bitrix mirror. Затем отдельно включать
   SQL-primary write/read. Старые Bitrix JSON-записи не удалять.
