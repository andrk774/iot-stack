FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
# журнал неподтверждённых БД сообщений (том ingest-journal)
RUN mkdir -p /journal && chown node:node /journal
USER node
CMD ["node", "src/index.js"]
