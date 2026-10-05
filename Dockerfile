# Multi-stage: una imagen pequeña para app (Next standalone), worker, mock y migraciones.
FROM node:22-alpine AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_STANDALONE=1
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY app/package.json app/
COPY worker/package.json worker/
COPY mock/package.json mock/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @ploot/app

# Dependencias de producción solo de worker/mock/scripts (Next va trazado dentro del standalone).
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY app/package.json app/
COPY worker/package.json worker/
COPY mock/package.json mock/
RUN npm ci --omit=dev --no-audit --no-fund -w @ploot/shared -w @ploot/worker -w @ploot/mock --include-workspace-root

FROM node:22-alpine
WORKDIR /repo
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json ./
COPY shared shared
COPY worker worker
COPY mock mock
COPY scripts scripts
COPY db db
COPY --from=build /repo/app/.next/standalone ./app-standalone
COPY --from=build /repo/app/.next/static ./app-standalone/app/.next/static
USER node
# En Railway cada servicio fija APP_ROLE (worker | mock | app); compose sobrescribe con `command`.
ENV APP_ROLE=worker
CMD ["sh", "-c", "exec npm run \"$APP_ROLE\""]
