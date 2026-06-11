# b24-app

Bitrix24-приложение для портала `umniydom.bitrix24.ru`: свои вкладки и окна поверх Б24 — товары сделки с партиями реализации, База товаров, инвентаризация (+мобильный QR-подсчёт), окно «Реализации ↔ сделки», отчёт по продажам, заявки снабжения. Стратегически — «покрывало»: складской учёт выезжает в headless ERPNext, люди продолжают работать в наших кнопках внутри Б24.

**📚 Документация: [docs/](docs/README.md)** — архитектура, фичи, роуты, runbook деплоя и энциклопедия граблей Б24 REST. Начинать оттуда.

## Стек

- **Backend**: Node.js + TypeScript + Fastify; хостинг — **Yandex Cloud Serverless Containers** (контейнер `b24-app`)
- **Frontend**: React + Vite + TypeScript, один бандл в iframe через placement-API Б24
- **Shared**: общие типы
- **Складское ядро (в работе)**: ERPNext (headless), см. [docs/sklad-vynos.md](docs/sklad-vynos.md)

## Структура

```
packages/
  backend/   — Fastify: OAuth, placement-роуты, /api/* (серверные походы в Б24 REST)
  frontend/  — React SPA (то, что Битрикс показывает в iframe)
  shared/    — TS-типы
scripts/     — разведки/тесты/миграции (см. docs/scripts.md)
docs/        — документация
```

## Команды

```bash
npm install
npm run dev:backend   # Fastify на :3000
npm run dev:frontend  # Vite на :5173 (dev-мок без BX24)
npm run typecheck     # все пакеты
npm run build         # все пакеты (фронт → packages/frontend/dist)
```

Деплой и откат — [docs/runbook.md](docs/runbook.md).

## Правила проекта

1. Не писать код без обсуждения и явного «добро».
2. Не удалять сущности портала — зачистка тестов за Сергеем.
3. Новые фичи — за канарейкой (`BETA_USER_IDS`), прод ≠ виден всем.
4. Меняешь поведение — правишь `docs/` в том же коммите.
