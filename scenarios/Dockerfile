# Контекст сборки — корень проекта (нужна папка shared/)
FROM node:22-alpine
WORKDIR /app/scenarios
ENV NODE_ENV=production
COPY scenarios/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY shared /app/shared
COPY scenarios/src ./src
USER node
CMD ["node", "src/index.js"]
