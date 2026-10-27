# Контекст сборки — корень проекта (нужна папка shared/)
FROM node:22-alpine
WORKDIR /app/backend
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY shared /app/shared
COPY backend/src ./src
COPY backend/migrations ./migrations
COPY backend/scripts ./scripts
USER node
EXPOSE 8000 8001
CMD ["node", "src/index.js"]
