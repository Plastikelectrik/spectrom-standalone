# SPECTROM standalone — docker build -t spectrom . && docker run -p 127.0.0.1:8484:8484 -v spectrom-data:/app/data spectrom
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
# Inside the container the page must listen on all interfaces; publish it on 127.0.0.1 only (see docker-compose.yml).
ENV HOST=0.0.0.0 PORT=8484 SPECTROM_DATA=/app/data NODE_ENV=production
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
EXPOSE 8484
USER node
CMD ["node", "server.js"]
