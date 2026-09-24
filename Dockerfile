# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:20-alpine
FROM ${NODE_IMAGE} AS base
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
# Backend imports runtime access-policy helpers from the shared workspace.
# Bundle that workspace for plain Node.js and point only the container copy at it.
RUN npm -w @b24-app/frontend run build \
 && npm -w @b24-app/backend run build \
 && test -s packages/backend/dist/catalog-mirror/reader.js \
 && test -s packages/backend/dist/catalog-mirror/live-stock.js \
 && npx esbuild packages/shared/src/index.ts --bundle --platform=node --format=esm --outfile=packages/shared/dist/index.js \
 && sed -i 's#\./src/index\.ts#./dist/index.js#g' packages/shared/package.json

# ── Рантайм-настройки
ENV NODE_ENV=production
# Backend слушает 8080 внутри контейнера. На VPS порт опубликован только на 127.0.0.1:3000.
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

# Бэкенд при старте сам отдаёт статику фронта из ../frontend/dist (см. app.ts)
CMD ["node", "packages/backend/dist/server.js"]
