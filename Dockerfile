FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY views ./views
COPY public ./public
COPY config ./config
COPY admin-ui ./admin-ui
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000
# /healthz: база отвечает и фоновые задачи не зависли. Статус — в docker compose ps (healthy / unhealthy)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO /dev/null "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1
CMD ["node", "src/server.js"]
