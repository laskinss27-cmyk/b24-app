# Runbook: сборка, деплой, откат, диагностика

## Сборка и проверка

```powershell
cd D:\Projects\b24-app
npm run typecheck   # все workspaces
npm run build       # backend tsc + frontend vite → packages/frontend/dist
```

Локальный смоук фронта: launch-конфиг `b24front` (http-server на `packages/frontend/dist`, порт 5183) — dev-мок без BX24, кнопки записи заблокированы.

## Деплой на прод (Yandex Cloud Serverless Containers)

```powershell
# 1. Образ
docker build -t cr.yandex/crpj8ipjmjimigbf8dq7/b24-app:latest .
docker push cr.yandex/crpj8ipjmjimigbf8dq7/b24-app:latest   # запомнить digest из вывода!

# 2. Ревизия — спека 1:1, env переносим из ПРОШЛОЙ ревизии (не наследуются сами!)
$prev = yc serverless container revision get <ПРОШЛАЯ_РЕВИЗИЯ> --format json | ConvertFrom-Json
$e = $prev.image.environment
# ВСЕ ключи динамически (их 6: APP_CLIENT_ID/SECRET, APP_SECTION_URL, ERPNEXT_URL, ERPNEXT_TOKEN, INVENTORY_NOTIFY).
# НЕ хардкодить подсписок — потеряешь ERPNEXT_* и отвалишь ядро (выстрадано 2026-06-15).
$envStr = (($e.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ',')
yc serverless container revision deploy --container-name b24-app `
  --image "cr.yandex/crpj8ipjmjimigbf8dq7/b24-app@sha256:<DIGEST>" `
  --memory 256MB --cores 1 --concurrency 4 --execution-timeout 60s `
  --service-account-id ajeprv5aiiqimilfrbv6 --environment $envStr
```

Деплой по образу-digest (не `:latest`) — откат всегда детерминирован.

## Проверка после деплоя

```powershell
$url = "https://bba0fouaqgab742ohki8.containers.yandexcloud.net"
Invoke-WebRequest "$url/health"                       # 200
Invoke-WebRequest "$url/assets/index-<HASH>.js"       # 200 (имя из vite build; первые секунды возможен 404 — прогрев, повторить)
# пишущие роуты без auth обязаны отдавать 403:
Invoke-WebRequest "$url/api/deal/realize" -Method POST -ContentType 'application/json' -Body '{}'
```

Дальше — живой тест канарейкой (Сергей) в портале.

## Откат

```powershell
yc serverless container revision list --container-name b24-app   # найти прошлую ACTIVE
yc serverless container rollback --name b24-app --revision-id <ID>
```

История ревизий с описаниями — в памяти проекта и git-логе (коммит ↔ ревизия фиксируются в сообщениях отчётов).

## Секреты

`APP_CLIENT_ID`/`APP_CLIENT_SECRET` — креды локального приложения Б24 (живут в env ревизии; при деплое переносить программно, в логи/чаты не светить). `DEV_WEBHOOK` — в `.env` репо (не коммитится), только dev/скрипты.

## Диагностика

- **Логи**: консоль Y.Cloud → контейнер b24-app → Logs (folder `b1gq8egrdkqh1oj2prq2`). Пишущие роуты логируют шаги — видно, на чём упало и что успело создаться.
- **«Вкладка пустая» / «таймаут 15с»** — флап фронтового BX24 (см. b24-rest-grabli.md); проверь, что данные идут через `/api/*`, а не BX24.
- **`fetch failed` в скриптах** — сеть/портал моргнул: повтор. Если на ноутбуке включён VPN-клиент (socks 127.0.0.1:10808 / http 10809) — Node напрямую НЕ ходит, скрипты миграции читают Б24 через `curl -x` (см. sklad-vynos.md).
- **Канарейка**: новое видят только `BETA_USER_IDS` — «у менеджера не появилось» это норма, а не баг.

## Правила проекта (не нарушать)

1. Не писать код без обсуждения и явного «добро».
2. **Не удалять сущности портала** (сделки/контакты/заказы/документы) — зачистка тестов за Сергеем; единственное исключение — авто-дубль от `sale.order.add` с гардом.
3. Write-тесты — только на тестовых сделках, с отчётом о созданных ID.
4. Прод-деплой — по слову Сергея; пароль-ритуал сессии соблюдается.
5. Меняешь поведение — правишь docs/ в том же коммите.
