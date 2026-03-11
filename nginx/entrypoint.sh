#!/bin/sh
# Cloudflare handles TLS — always use HTTP origin config.
set -e
exec nginx -g 'daemon off;'
