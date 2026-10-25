FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
COPY sa_key.json ./sa_key.json
EXPOSE 8080
CMD ["node", "server.js"]
