FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --maxsockets=5
COPY --chown=node:node src src
COPY --chown=node:node test test
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
