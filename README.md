# b24-app

Bitrix24-приложение, заменяющее стандартные вкладки в карточках Б24 (Товары сделки, Поставка, Инвентаризация) для портала `umniydom.bitrix24.ru`.

Постановка: `D:\Projects\b24-extension-handoff.md`.

## Стек

- **Backend**: Node.js + TypeScript + Fastify, деплой на Vercel (serverless)
- **Frontend**: React + Vite + TypeScript, грузится в iframe через placement-API Б24
- **Shared**: общие типы (доменные модели + сгенерированные из `crm.*.fields`)

## Структура

```
packages/
  backend/   — Fastify-сервер: OAuth, placement-endpoints, прокси к Б24 REST
  frontend/  — React SPA: то, что Битрикс показывает в iframe
  shared/    — TS-типы, доменные модели
scripts/
  gen-types.ts — генератор типов из crm.*.fields
```

## Команды

```bash
npm install
npm run dev:backend   # Fastify на :3000
npm run dev:frontend  # Vite на :5173
npm run gen:types     # перегенерить b24-types.ts из портала (нужен webhook)
npm run typecheck     # проверка типов во всех пакетах
```

## Sprint 1

Только вкладка «Товары» сделки: своя таблица с N/M отгружено, селектор склада с фильтром остаток>0, чекбоксы «Реализовать», свой блок итогов, кнопка массовой реализации.
