# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS base
WORKDIR /app

# ── Слой 1: зависимости.
# Кешируется пока package.json/lock не меняются — пересборка кода не дёргает npm install.
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --ignore-scripts

# ── Слой 2: код и сборка.
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm -w @b24-app/frontend run build \
 && npm -w @b24-app/backend run build

# ── Рантайм-настройки
ENV NODE_ENV=production
# Y.Cloud Serverless Containers по дефолту стучатся на 8080 — Fastify тоже должен слушать его.
# Если меняешь — синхронно меняй и --port в `yc serverless container revision deploy`.
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

# Бэкенд при старте сам отдаёт статику фронта из ../frontend/dist (см. app.ts)
CMD ["node", "packages/backend/dist/server.js"]
