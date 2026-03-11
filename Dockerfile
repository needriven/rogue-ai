# ── Stage 1: Build ────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy only package files first for better layer caching
COPY frontend/package*.json ./

# Clean install — fail on any lockfile mismatch
RUN npm ci --ignore-scripts

# Security: fail build on HIGH/CRITICAL vulnerabilities
RUN npm audit --audit-level=high

# Build
COPY frontend/ .
RUN npm run build

# ── Stage 2: Serve ────────────────────────────────────
FROM nginx:1.27-alpine AS production

# Remove default config
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configs
COPY nginx/nginx.conf     /etc/nginx/nginx.conf
COPY nginx/conf.d/        /etc/nginx/conf.d/

# Copy entrypoint (selects HTTP vs HTTPS config at startup)
COPY nginx/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
