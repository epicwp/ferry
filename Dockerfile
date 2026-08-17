# syntax=docker/dockerfile:1
# Build the dashboard with the full workspace toolchain.
FROM node:24-slim AS dashboard
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY ferry-server/package.json ferry-server/
COPY ferry-cli/package.json ferry-cli/
COPY ferry-dashboard/package.json ferry-dashboard/
RUN npm ci
COPY ferry-dashboard ferry-dashboard
COPY ferry-server/src ferry-server/src
COPY ferry-cli/src ferry-cli/src
RUN npm --workspace ferry-dashboard run build

# Runtime node_modules: server+cli only. Dev deps stay in (tsx runs the server from
# source); toolchain present in case a native module (better-sqlite3) lacks a prebuild.
FROM node:24-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY ferry-server/package.json ferry-server/
COPY ferry-cli/package.json ferry-cli/
COPY ferry-dashboard/package.json ferry-dashboard/
RUN npm ci --workspace ferry-server --workspace ferry-cli --include=dev

FROM node:24-slim
# git: engine/agent-context shell out to it. sqlite3: DB inspection over fly ssh console.
RUN apt-get update && apt-get install -y --no-install-recommends git sqlite3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app /app
COPY ferry-server ferry-server
COPY ferry-cli ferry-cli
COPY ferry-plugin ferry-plugin
COPY --from=dashboard /app/ferry-dashboard/dist ferry-dashboard/dist
ENV NODE_ENV=production
EXPOSE 4000
# Single process (no npm wrapper): Fly's stop signal must reach main.ts's handlers directly.
CMD ["node", "--import", "tsx", "ferry-server/src/main.ts"]
