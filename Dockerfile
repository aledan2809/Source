FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# ai-router local package: copy into build context before docker build
# e.g.: cp -r ../AIRouter ./AIRouter && docker build .
RUN mkdir -p /app/AIRouter
COPY AIRoute[r] /app/AIRouter/
# Rewrite the file: reference to point to local copy inside the build context
RUN if [ -f /app/AIRouter/package.json ]; then \
      cd /app/AIRouter && npm install --omit=dev 2>/dev/null || true; \
      sed -i 's|"ai-router":.*|"ai-router": "file:./AIRouter",|' /app/package.json; \
    else \
      sed -i '/"ai-router"/d' /app/package.json; \
    fi
RUN npm install --omit=dev

# Build the application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/AIRouter ./AIRouter
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3030

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Create directories for data and uploads
RUN mkdir -p /app/src/data/results /app/uploads && chown -R nextjs:nodejs /app/src/data /app/uploads

USER nextjs

EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3030/api/health || exit 1

CMD ["node", "server.js"]
