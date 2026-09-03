# Проверенное SQL-чтение перемещений — 2026-09-03

## Граница этапа

Перемещения приложения теперь могут возвращаться из нормализованных SQL-таблиц,
но только после точного сравнения с текущим реестром Bitrix24. Режим
`B24_APP_TRANSFER_SQL_READ=verified` не является независимым SQL source switch:
на каждом запросе Bitrix24 всё ещё читается первым, а mismatch, недоступность SQL
или ошибка проверки автоматически оставляют пользователю legacy-ответ.

Запись не менялась: Bitrix24 остаётся первичным writer, после него
`B24_APP_TRANSFER_SQL_WRITE=shadow` добавляет неизменяемую SQL revision. Складские
документы по-прежнему проводятся только через официальный ERPNext API.

## Что проверено до переключения

- 35 обычных `bitrix_dual_write` revisions для 9 реальных перемещений появились
  после включения shadow writer;
- первый полный аудит нашёл 182 расхождения из 191 записей, но shape-анализ
  доказал единственную причину: старый payload сохранял необязательное
  `history[].changes: []`, а нормализованная модель это пустое поле опускала;
- commit `82c2eb0` перенёс канонизацию в сам hash gate, после чего повторный
  production-аудит дал `191/191`, `0` differences;
- verified-read change `d25c0f4` прошёл `374/374` backend tests, workspace
  typecheck и production build.

Пустое необязательное `changes` и отсутствующее поле считаются одним состоянием.
Это не теряет событие или изменение: непустой список продолжает храниться и
сравниваться. Frontend использует поле как optional.

## Production rollout

Image `b24-app:d25c0f4` сначала развёрнут с выключенным новым read gate. Текущий
до switch image `b24-app:82c2eb0` сохранён в
`b24-backend-prev-before-d25c0f4`.

Затем тот же image переключён последовательно:

1. `shadow`: реальный owner-authenticated `/api/transfers/list` вернул 191
   запись из Bitrix24; журнал сравнения показал SQL `191`, `matches=true`,
   `0` differences и `responseSource=legacy`.
2. `verified`: повторный запрос вернул 191 запись; журнал показал те же
   `191/191`, `0` differences и `responseSource=sql`.

OAuth был получен из зашифрованного server-side vault только в памяти процесса.
Перед запросом выполнен точный `user.current`; токен не печатался, не сохранялся
в audit-файл и не передавался в URL или shell history.

После каждого switch подтверждены internal/public `/health`, `/ready` со
статусами `database`, `reservations`, `transferSqlWriter = up`, официальный
read-only ERPNext запрос, `/srv/b24-state:/app/state`, restart policy
`unless-stopped`, `RestartCount=0` и членство в `erpnext_frappe_network`.

Дополнительные rollback-контейнеры сохранены и не удалены:

- `b24-backend-prev-before-transfer-read-shadow-20260903` — тот же image с
  read gate `off`;
- `b24-backend-prev-before-transfer-read-verified-20260903` — тот же image в
  режиме `shadow`.

## Что ещё не завершено

JSON в Bitrix24 пока остаётся первичной записью перемещения и обязательным
аварийным источником чтения. Следующий отдельный этап должен перевести запись на
SQL-транзакцию и оставить Bitrix24 совместимым mirror/fallback. До доказательства
этого write path удалять Bitrix entity или старые payload нельзя.
