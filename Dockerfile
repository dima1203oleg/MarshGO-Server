FROM node:24.21.0-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24.21.0-slim AS runtime
ARG MARSHGO_BUILD_ID=unknown
ARG MARSHGO_BUILD_SHA=unknown
ARG MARSHGO_BUILD_TIME=unknown
ARG MARSHGO_SOURCE_STATE=unknown
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3002 \
    MARSHGO_BUILD_ID=${MARSHGO_BUILD_ID} \
    MARSHGO_BUILD_SHA=${MARSHGO_BUILD_SHA} \
    MARSHGO_BUILD_TIME=${MARSHGO_BUILD_TIME} \
    MARSHGO_SOURCE_STATE=${MARSHGO_SOURCE_STATE}
LABEL org.opencontainers.image.title="marshgo/api" \
      org.opencontainers.image.source="https://github.com/dima1203oleg/MarshGO-Server" \
      org.opencontainers.image.revision="${MARSHGO_BUILD_SHA}" \
      org.opencontainers.image.created="${MARSHGO_BUILD_TIME}" \
      org.opencontainers.image.version="${MARSHGO_BUILD_ID}"
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
# The API runs unprivileged; LOCAL_STORAGE_DIR must be writable and an empty named volume inherits this ownership.
RUN mkdir -p /app/.uploads && chown node:node /app/.uploads
USER node
EXPOSE 3002
HEALTHCHECK --interval=20s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3002/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import=tsx", "server/index.ts"]
