FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
