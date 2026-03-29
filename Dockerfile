FROM node:20-alpine

# Install yt-dlp and its Python dependency
RUN apk add --no-cache python3 curl \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src/ ./src/

CMD ["node", "src/index.js"]
