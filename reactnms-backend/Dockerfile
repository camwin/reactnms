FROM node:20-alpine

RUN apk add --no-cache iputils python3 py3-pip \
 && pip3 install --break-system-packages 'netmiko==4.6.0'

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib

# Persist discovery config
VOLUME /app/data
ENV DATA_FILE=/app/data/discovery.json

EXPOSE 3001

CMD ["node", "server.js"]
