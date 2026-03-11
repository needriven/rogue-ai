#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OCI VM initial setup script
# Run once on a fresh Ubuntu 22.04 OCI instance
# Usage: bash scripts/setup-vm.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "==> Updating system..."
sudo apt-get update -qq && sudo apt-get upgrade -y -qq

echo "==> Installing Docker..."
sudo apt-get install -y -qq ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -qq
sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow current user to run docker without sudo
sudo usermod -aG docker "$USER"

echo "==> Creating project directory..."
mkdir -p ~/rogue-ai/ssl

echo "==> Copying docker-compose and .env..."
# After setup, copy docker-compose.yml and .env to ~/rogue-ai/
# Then run: docker compose up -d

echo ""
echo "✓ Setup complete."
echo ""
echo "Next steps:"
echo "  1. Copy docker-compose.yml to ~/rogue-ai/"
echo "  2. Copy .env.example to ~/rogue-ai/.env and fill in values"
echo "  3. Open firewall: sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT"
echo "                    sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT"
echo "  4. Run: cd ~/rogue-ai && docker compose up -d"
echo "  5. (Optional) Set up SSL: bash scripts/init-ssl.sh"
