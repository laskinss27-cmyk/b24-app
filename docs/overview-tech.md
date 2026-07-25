# Технический обзор

## Стек

- Node.js 20, TypeScript, Fastify 5;
- React 18, Vite 6;
- npm workspaces;
- ERPNext 16 / Frappe;
- MariaDB, Redis и workers в Docker Compose;
- nginx и Let's Encrypt.

## Runtime

Frontend и backend собираются в один Docker-образ `b24-app:<commit>`. Fastify раздаёт frontend и обслуживает placement/API. Контейнер подключён к `erpnext_frappe_network` и обращается к ERPNext по `http://frontend:8080`.

На хосте:

- backend — `127.0.0.1:3000`;
- ERPNext — `127.0.0.1:8080`;
- nginx — публичные `80/443`.

## Интеграция с Битрикс24

- серверное локальное приложение;
- placement для вкладки сделки, левого меню, отчёта и задачи;
- токен текущего пользователя для обычных API-запросов;
- OAuth cookie для мобильного режима;
- entity-хранилища для служебного состояния;
- Диск для документов и внешней копии дампа БД.

## Интеграция с ERPNext

Backend использует REST API с отдельным токеном. Проводки выполняются штатными документами ERPNext и проверяются после submit. Внешний интерфейс ERPNext пользователям не публикуется.

## Эксплуатация

- деплой по immutable-тегу короткого git hash;
- предыдущий контейнер сохраняется;
- внутренний и публичный health-check обязательны;
- ежедневный дамп БД и недельные архивы файлов;
- миграционные скрипты не входят в runtime и не запускаются по расписанию.

Схема и процедуры: [architecture.md](architecture.md), [network.md](network.md), [runbook.md](runbook.md).
