FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY public ./public
COPY server ./server
COPY scripts ./scripts
RUN mkdir -p /app/private_uploads && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
