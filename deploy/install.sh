#!/usr/bin/env bash
# deploy/install.sh — first-time VPS bootstrap for hacs-stats.
#
# Run as root on a fresh Ubuntu 24.04 / Debian 12 host.
# Idempotent: safe to re-run.
#
# Assumes: this repo is checked out at /opt/hacs-stats.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/opt/hacs-stats}"
DATA_DIR="${DATA_DIR:-/var/lib/hacs-stats}"
ETC_DIR="${ETC_DIR:-/etc/hacs-stats}"
SERVICE_USER="${SERVICE_USER:-hacs-stats}"

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "must run as root (try: sudo $0)" >&2
    exit 1
  fi
}

step() { printf '\n=== %s ===\n' "$1"; }

install_packages() {
  step "Installing system packages"
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl debian-keyring debian-archive-keyring apt-transport-https \
    build-essential python3 sqlite3
}

install_node() {
  step "Installing Node 22"
  if ! command -v node >/dev/null || [[ "$(node --version)" != v22.* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  corepack enable pnpm
}

install_caddy() {
  step "Installing Caddy"
  if ! command -v caddy >/dev/null; then
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
  fi
}

create_user_and_dirs() {
  step "Creating service user and dirs"
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR"
  install -d -o root -g root -m 0755 "$ETC_DIR"
  if [[ ! -f "$ETC_DIR/env" ]]; then
    cat > "$ETC_DIR/env" <<'EOF'
# /etc/hacs-stats/env — loaded by systemd via EnvironmentFile.
# Fill in your GitHub PAT (public_repo scope) and tweak as needed.
GITHUB_TOKEN=
DATABASE_PATH=/var/lib/hacs-stats/hacs-stats.db
PORT=3000
NODE_ENV=production
EOF
    chmod 0640 "$ETC_DIR/env"
    chgrp "$SERVICE_USER" "$ETC_DIR/env"
    echo "wrote $ETC_DIR/env — edit it to set GITHUB_TOKEN before starting services"
  fi
}

install_app_files() {
  step "Installing systemd units and Caddyfile"
  install -m 0644 "$REPO_ROOT/deploy/systemd/hacs-stats-web.service"    /etc/systemd/system/
  install -m 0644 "$REPO_ROOT/deploy/systemd/hacs-stats-scrape.service" /etc/systemd/system/
  install -m 0644 "$REPO_ROOT/deploy/systemd/hacs-stats-scrape.timer"   /etc/systemd/system/

  if [[ ! -f /etc/caddy/Caddyfile.hacs-stats ]]; then
    install -m 0644 "$REPO_ROOT/deploy/Caddyfile" /etc/caddy/Caddyfile.hacs-stats
    echo "wrote /etc/caddy/Caddyfile.hacs-stats — import it from /etc/caddy/Caddyfile"
  fi
  systemctl daemon-reload
}

build_app() {
  step "Installing dependencies in $REPO_ROOT"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$REPO_ROOT"
  sudo -u "$SERVICE_USER" pnpm install --frozen-lockfile --dir "$REPO_ROOT"
}

apply_migrations() {
  step "Applying database migrations"
  sudo -u "$SERVICE_USER" \
    DATABASE_PATH="$DATA_DIR/hacs-stats.db" \
    pnpm --dir "$REPO_ROOT" migrate
}

print_next_steps() {
  cat <<EOF

✅ Install complete.

Next steps (manual):

  1. Drop the Cloudflare Origin Cert at:
       /etc/caddy/cf-origin.crt  (cert)
       /etc/caddy/cf-origin.key  (key, chmod 0640, chgrp caddy)
     Generate it in the Cloudflare dashboard:
       SSL/TLS → Origin Server → Create Certificate.

  2. Edit $ETC_DIR/env and set GITHUB_TOKEN.

  3. Add this line to /etc/caddy/Caddyfile (or rely on the default Caddyfile
     pattern if you keep just our config there):
       import /etc/caddy/Caddyfile.hacs-stats

  4. Enable services:
       systemctl enable --now hacs-stats-web.service
       systemctl enable --now hacs-stats-scrape.timer
       systemctl reload caddy

  5. Trigger an initial scrape (don't wait until 04:00 UTC):
       systemctl start hacs-stats-scrape.service
       journalctl -u hacs-stats-scrape.service -f

  6. Point hacs-stats.dev DNS at this VPS (orange-cloud proxy ON, "Full
     (strict)" SSL mode).
EOF
}

require_root
install_packages
install_node
install_caddy
create_user_and_dirs
install_app_files
build_app
apply_migrations
print_next_steps
