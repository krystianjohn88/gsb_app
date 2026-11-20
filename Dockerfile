FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY server.js ./
COPY public ./public
COPY data ./data

USER node
EXPOSE 3000
CMD ["node", "server.js"]
