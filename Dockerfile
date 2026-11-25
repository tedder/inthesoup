# Web app image (self-hosted DuckDB backend). The data loaders have their own
# image, built from data/.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_BACKEND=duckdb \
    DATA_DIR=/data \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    # Next 13.4 proxies to an internal worker on 127.0.0.1; without this Node 24 resolves
    # localhost to ::1 and every request returns 500 (ECONNREFUSED).
    NODE_OPTIONS=--dns-result-order=ipv4first
COPY --from=build --chown=node:node /app/build/standalone ./
COPY --from=build --chown=node:node /app/build/static ./build/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
