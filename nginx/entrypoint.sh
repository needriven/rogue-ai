#!/bin/sh
set -e

CERT_PATH="/etc/ssl/app/fullchain.pem"
KEY_PATH="/etc/ssl/app/privkey.pem"
CONF_DEST="/etc/nginx/conf.d/default.conf"

if [ -f "$CERT_PATH" ] && [ -f "$KEY_PATH" ]; then
    echo "[entrypoint] SSL certs found — starting in HTTPS mode"
    cp /etc/nginx/conf.d/ssl.conf.template "$CONF_DEST"
else
    echo "[entrypoint] No SSL certs — starting in HTTP mode"
    cp /etc/nginx/conf.d/http.conf.template "$CONF_DEST"
fi

exec nginx -g 'daemon off;'
