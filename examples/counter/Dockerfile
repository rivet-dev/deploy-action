FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
