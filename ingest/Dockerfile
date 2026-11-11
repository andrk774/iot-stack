# Контекст сборки — корень проекта (нужна папка shared/)
FROM node:22-alpine
WORKDIR /app/ingest
ENV NODE_ENV=production
COPY ingest/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY shared /app/shared
COPY ingest/src ./src
# журнал неподтверждённых БД сообщений (том ingest-journal)
RUN mkdir -p /journal && chown node:node /journal
USER node
CMD ["node", "src/index.js"]
