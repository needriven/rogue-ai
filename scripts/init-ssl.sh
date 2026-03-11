#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Let's Encrypt SSL certificate provisioning
# Run after deploying in HTTP mode
# Usage: bash scripts/init-ssl.sh yourdomain.com your@email.com
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "Usage: $0 <domain> <email>"
  echo "  e.g. $0 example.com admin@example.com"
  exit 1
fi

echo "==> Issuing cert for $DOMAIN..."

# Issue cert using webroot (nginx must be running in HTTP mode)
docker compose run --rm certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN"

echo "==> Copying certs to ./ssl/..."
# Certbot writes to /etc/letsencrypt inside the container,
# which maps to ./ssl/ on the host
# Symlink expected paths
ln -sf "./live/$DOMAIN/fullchain.pem" ./ssl/fullchain.pem 2>/dev/null || true
ln -sf "./live/$DOMAIN/privkey.pem"   ./ssl/privkey.pem   2>/dev/null || true

echo "==> Restarting web server (HTTPS mode)..."
docker compose restart web

echo ""
echo "✓ SSL enabled for $DOMAIN"
echo ""
echo "Auto-renewal: add to crontab:"
echo "  0 3 * * * cd ~/rogue-ai && docker compose run --rm certbot renew --quiet && docker compose restart web"
