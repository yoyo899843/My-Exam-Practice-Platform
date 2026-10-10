FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/practice.sqlite
EXPOSE 3000
CMD ["node", "src/server.js"]
