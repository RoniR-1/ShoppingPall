FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/.local
ENV NODE_ENV=production HOST=0.0.0.0
EXPOSE 3001
CMD ["node", "scripts/web-demo.js"]
