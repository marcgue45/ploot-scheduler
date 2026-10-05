# Una sola imagen para app, worker, mock y migraciones (un build, cuatro comandos).
FROM node:22-alpine
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY app/package.json app/
COPY worker/package.json worker/
COPY mock/package.json mock/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @ploot/app
USER node
