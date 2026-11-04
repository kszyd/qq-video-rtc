FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
COPY . .
EXPOSE 9001
CMD ["node", "index.js"]