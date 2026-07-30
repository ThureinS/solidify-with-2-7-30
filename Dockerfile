# Two independent final stages (worker, api) selected via `build.target`
# in docker-compose.yml -- one file, no duplication of the base image line.

# ---- worker: background email-queue consumer ----
# Doesn't touch the database directly, so it skips `prisma generate`
# (--ignore-scripts) and devDependencies (--omit=dev) entirely -- it only
# needs bullmq, ioredis, and nodemailer to run.
FROM node:20-alpine AS worker
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts --omit=dev
COPY worker.js ./
CMD ["node", "worker.js"]

# ---- deps: full install (incl. the `prisma` CLI devDependency) so
# `prisma generate` (package.json's postinstall) can run against the real
# schema, producing a client that matches this image's platform/libc
# (Alpine/musl) rather than whatever generated it on the host. ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# ---- api: the Express web API ----
# Reinstalls production-only deps (--omit=dev, --ignore-scripts so this
# install doesn't try to re-run `prisma generate` without the `prisma` CLI
# devDependency present), then copies over just the generated client
# artifacts from the `deps` stage -- keeps the final image free of
# devDependencies while still shipping a real, platform-matched client.
FROM node:20-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY src ./src
COPY openapi.yaml ./
EXPOSE 3000
CMD ["node", "src/server.js"]
