FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app
COPY package.json ./
RUN npm install

COPY server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
