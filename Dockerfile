# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
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
COPY Dockerfile .dockerignore ./
COPY packages ./packages
COPY tools/telegram-pilot/server.mjs ./tools/telegram-pilot/server.mjs
COPY tools/telegram-pilot/public ./tools/telegram-pilot/public
COPY docs/contracts/order-created.v1.example.json ./docs/contracts/order-created.v1.example.json
COPY scripts/b24-release-integrity.mjs ./scripts/b24-release-integrity.mjs
COPY .release/source.json ./.release/source.json
ARG RELEASE_SHA
ARG RELEASE_TREE
# Missing provenance or a changed build context blocks the build before tests/build.
RUN node scripts/b24-release-integrity.mjs check-input "$RELEASE_SHA" "$RELEASE_TREE"
RUN npm -w @b24-app/backend test && npm -w @b24-app/frontend test
# Backend imports runtime access-policy helpers from the shared workspace.
# Bundle that workspace for plain Node.js and point only the container copy at it.
RUN npm -w @b24-app/frontend run build \
 && npm -w @b24-app/backend run build \
 && test -s packages/backend/dist/catalog-mirror/reader.js \
 && test -s packages/backend/dist/catalog-mirror/live-stock.js \
 && npx esbuild packages/shared/src/index.ts --bundle --platform=node --format=esm --outfile=packages/shared/dist/index.js \
 && sed -i 's#\./src/index\.ts#./dist/index.js#g' packages/shared/package.json \
 && node scripts/b24-release-integrity.mjs seal

LABEL org.opencontainers.image.revision=$RELEASE_SHA \
      com.b24.git-tree=$RELEASE_TREE

# ── Рантайм-настройки
ENV NODE_ENV=production
# Backend слушает 8080 внутри контейнера. На VPS порт опубликован только на 127.0.0.1:3000.
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

# Бэкенд при старте сам отдаёт статику фронта из ../frontend/dist (см. app.ts)
CMD ["node", "packages/backend/dist/server.js"]
