# Runbook: сборка, деплой, откат, диагностика

## Сборка и проверка

```powershell
cd D:\Projects\b24-app
npm run typecheck   # все workspaces
npm run build       # backend tsc + frontend vite → packages/frontend/dist
```

Локальный смоук фронта: launch-конфиг `b24front` (http-server на `packages/frontend/dist`, порт 5183) — dev-мок без BX24, кнопки записи заблокированы.

## Деплой на прод (домашний сервер — СПЕЙР 192.168.0.69)

> ⚠️ С Yandex Cloud УШЛИ 2026-06-16 (флип на свою инфру). Боевое приложение теперь — docker-контейнер
> `b24-backend` на спейре (бэкенд раздаёт собранный фронт из `../frontend/dist`), наружу его выставляет
> VPS reg.ru через обратный ssh-туннель. Образ собирается локально и переносится на спейр через
> `docker save`/`scp` — **в реестр cr.yandex НЕ пушится** (тег `cr.yandex/...` остался просто именем).
> Яндекс-ревизия `bba5gk4...` оставлена как холодный фолбэк (откат = вернуть URL приложения на неё в Б24).

```bash
# 1. Собрать образ (provenance=false ОБЯЗАТЕЛЬНО — иначе manifest-list с аттестацией не запустится на спейре)
docker build --provenance=false --platform linux/amd64 -t cr.yandex/crpj8ipjmjimigbf8dq7/b24-app:latest .

# 2. Сохранить и скопировать на спейр (~96 МБ)
docker save cr.yandex/crpj8ipjmjimigbf8dq7/b24-app:latest | gzip > /d/b24-deploy.tar.gz
scp -i ~/.ssh/b24_homeserver /d/b24-deploy.tar.gz rey@192.168.0.69:~/b24-deploy.tar.gz

# 3. На спейре: запомнить старый образ (для отката!), загрузить новый, пересоздать контейнер
ssh -i ~/.ssh/b24_homeserver rey@192.168.0.69 '
  OLD=$(docker inspect b24-backend --format "{{.Image}}"); echo "ОТКАТ НА: $OLD";
  gunzip -c ~/b24-deploy.tar.gz | docker load;
  docker rm -f b24-backend;
  docker run -d --name b24-backend --network erpnext_frappe_network -p 3000:8080 \
    --env-file ~/erpnext/backend.env --restart unless-stopped \
    cr.yandex/crpj8ipjmjimigbf8dq7/b24-app:latest;
  sleep 4; curl -s -o /dev/null -w "health=%{http_code}\n" http://localhost:3000/health;
  rm -f ~/b24-deploy.tar.gz'
```

ГРАБЛИ: `docker build && docker save` в одной `&&`-цепочке — если build упал, save/scp всё равно утащит
СТАРЫЙ `:latest` («SCP_OK» обманет). Проверяй `npm -w @b24-app/backend run build` БЕЗ `tail`-обрезки.

## Проверка после деплоя

На спейре проще всего — команда **`status`** (см. SOS.md): покажет health/дверь/контейнеры разом.
Или вручную:
```bash
ssh -i ~/.ssh/b24_homeserver rey@192.168.0.69 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health'   # 200
curl -s -o /dev/null -w "%{http_code}\n" https://194-226-97-154.regru.cloud/health   # 200 — дверь снаружи
```
Дальше — живой тест канарейкой (Сергей) в портале.

## Откат

`:latest` перезаписывается при каждом деплое, прежний образ остаётся dangling по своему sha:
```bash
ssh -i ~/.ssh/b24_homeserver rey@192.168.0.69 '
  docker rm -f b24-backend;
  docker run -d --name b24-backend --network erpnext_frappe_network -p 3000:8080 \
    --env-file ~/erpnext/backend.env --restart unless-stopped <СТАРЫЙ_SHA>'
```
Заведомо рабочий образ «до доработок ремонтов 2026-06-17»: `sha256:a39f14bf54cbc896978bbf8c114113af551b466c394fc000ca7aa95baa2bca72`.
Актуальные sha откатов Claude держит в памяти `project_repairs`. Аварийная шпаргалка для человека — **`docs/SOS.md`**.

## Секреты

`APP_CLIENT_ID`/`APP_CLIENT_SECRET` — креды локального приложения Б24 (живут в env ревизии; при деплое переносить программно, в логи/чаты не светить). `DEV_WEBHOOK` — в `.env` репо (не коммитится), только dev/скрипты.

## Диагностика

- **Быстрый осмотр всей системы**: команда `status` на спейре (см. `docs/SOS.md`) — ядро/backend/дверь/туннель/контейнеры/синк разом, по-русски.
- **Логи приложения**: на спейре `docker logs --tail 50 b24-backend` (пишущие роуты логируют шаги — видно, на чём упало и что успело создаться). Логи ядра: `docker logs --tail 50 erpnext-backend-1`.
- **«Вкладка пустая» / «таймаут 15с»** — флап фронтового BX24 (см. b24-rest-grabli.md); проверь, что данные идут через `/api/*`, а не BX24.
- **`fetch failed` в скриптах** — сеть/портал моргнул: повтор. Если на ноутбуке включён VPN-клиент (socks 127.0.0.1:10808 / http 10809) — Node напрямую НЕ ходит, скрипты миграции читают Б24 через `curl -x` (см. sklad-vynos.md).
- **Канарейка**: новое видят только `BETA_USER_IDS` — «у менеджера не появилось» это норма, а не баг.

## Правила проекта (не нарушать)

1. Не писать код без обсуждения и явного «добро».
2. **Не удалять сущности портала** (сделки/контакты/заказы/документы) — зачистка тестов за Сергеем; единственное исключение — авто-дубль от `sale.order.add` с гардом.
3. Write-тесты — только на тестовых сделках, с отчётом о созданных ID.
4. Прод-деплой — по слову Сергея; пароль-ритуал сессии соблюдается.
5. Меняешь поведение — правишь docs/ в том же коммите.
