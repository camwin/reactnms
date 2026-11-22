FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Persist discovery config
VOLUME /app/data
ENV DATA_FILE=/app/data/discovery.json

EXPOSE 3001

CMD ["node", "server.js"]
