FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production
# Cloud Run sets PORT; the server reads it.
USER node
CMD ["node", "server.js"]
