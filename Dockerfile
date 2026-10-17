FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /srv

COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev

COPY server server
COPY app app
COPY images images

USER node
WORKDIR /srv/server
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-8000}/healthz || exit 1
CMD ["node", "server.js"]
