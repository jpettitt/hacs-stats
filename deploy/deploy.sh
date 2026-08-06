#!/usr/bin/env bash
# deploy/deploy.sh — update an already-installed VPS to the latest code.
#
# Run as root on the VPS (first-time setup is install.sh, not this):
#   sudo bash /opt/hacs-stats/deploy/deploy.sh
# Or from your laptop:
#   ssh <vps> 'sudo bash /opt/hacs-stats/deploy/deploy.sh'
#
# Steps: git pull (ff-only) → pnpm install → migrate → refresh changed
# systemd units → restart web → health check. Idempotent; a no-op deploy
# (nothing new on the remote) exits early without restarting anything.
#
# Flags:
#   --test      run the workspace test suite after install, abort on failure
#   --no-pull   deploy the tree as-is (e.g. after a manual checkout)
#
# The whole script body lives inside main() and the entry point is the
# last line, so the interpreter has parsed everything before the git pull
# can rewrite this file under it. If the pull changes deploy.sh itself we
# re-exec the new version (once) so the deploy runs with current logic.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/opt/hacs-stats}"
DATA_DIR="${DATA_DIR:-/var/lib/hacs-stats}"
SERVICE_USER="${SERVICE_USER:-hacs-stats}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"

step() { printf '\n=== %s ===\n' "$1"; }

# EVERY git invocation must go through this, not just the pull: the repo
# is owned by $SERVICE_USER and root-run git refuses with "detected
# dubious ownership" (CVE-2022-24765 protection) unless safe.directory
# is configured — which we'd rather not require on the box.
as_svc() { sudo -u "$SERVICE_USER" "$@"; }

main() {
  local run_tests=0 do_pull=1
  for arg in "$@"; do
    case "$arg" in
      --test) run_tests=1 ;;
      --no-pull) do_pull=0 ;;
      *) echo "unknown flag: $arg (known: --test --no-pull)" >&2; exit 2 ;;
    esac
  done

  if [[ $EUID -ne 0 ]]; then
    echo "must run as root (try: sudo $0)" >&2
    exit 1
  fi
  cd "$REPO_ROOT"

  # DEPLOY_OLD_REV survives the self-update re-exec (by then HEAD has
  # already moved, so re-reading it would break the changelog + rollback rev).
  local old_rev
  old_rev="${DEPLOY_OLD_REV:-$(as_svc git rev-parse HEAD)}"

  if [[ $do_pull -eq 1 ]]; then
    step "Pulling latest ($(as_svc git rev-parse --abbrev-ref HEAD))"
    local self_before
    self_before="$(as_svc git hash-object deploy/deploy.sh)"
    # ff-only: a diverged tree (local hotfix never pushed) should fail
    # loudly for a human decision, not auto-merge on a production box.
    as_svc git pull --ff-only

    if [[ "$(as_svc git hash-object deploy/deploy.sh)" != "$self_before" && -z "${DEPLOY_REEXEC:-}" ]]; then
      echo "deploy.sh changed upstream — re-executing the new version"
      DEPLOY_REEXEC=1 DEPLOY_OLD_REV="$old_rev" exec bash "$0" --no-pull "$@"
    fi

    if [[ "$(as_svc git rev-parse HEAD)" == "$old_rev" ]]; then
      # Still probe health so a rerun after a failed deploy can't look
      # like success while the service is down.
      if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
        echo "Already up to date at ${old_rev:0:9} — nothing to deploy, service healthy."
        exit 0
      fi
      echo "Already up to date at ${old_rev:0:9}, but $HEALTH_URL is NOT responding." >&2
      echo "Try: systemctl restart hacs-stats-web.service && journalctl -u hacs-stats-web.service -f" >&2
      exit 1
    fi
  fi

  step "Changes since ${old_rev:0:9}"
  as_svc git log --oneline "${old_rev}..HEAD" || true

  step "Installing dependencies"
  as_svc pnpm install --frozen-lockfile --dir "$REPO_ROOT"

  if [[ $run_tests -eq 1 ]]; then
    step "Running tests"
    as_svc pnpm --dir "$REPO_ROOT" test
  fi

  step "Applying database migrations"
  as_svc env DATABASE_PATH="$DATA_DIR/hacs-stats.db" pnpm --dir "$REPO_ROOT" migrate

  step "Refreshing systemd units"
  local unit reload_needed=0
  for unit in "$REPO_ROOT"/deploy/systemd/*.service "$REPO_ROOT"/deploy/systemd/*.timer; do
    [[ -f "$unit" ]] || continue # unmatched glob → literal '*.timer' path
    local name="/etc/systemd/system/$(basename "$unit")"
    if ! cmp -s "$unit" "$name"; then
      install -m 0644 "$unit" "$name"
      echo "updated $(basename "$unit")"
      reload_needed=1
    fi
  done
  if [[ $reload_needed -eq 1 ]]; then systemctl daemon-reload; fi

  # The installed Caddyfile may carry deliberate local edits (install.sh
  # never clobbers it either), so drift is a warning, not an auto-overwrite.
  if [[ -f /etc/caddy/Caddyfile.hacs-stats ]] \
    && ! cmp -s "$REPO_ROOT/deploy/Caddyfile" /etc/caddy/Caddyfile.hacs-stats; then
    echo "NOTE: deploy/Caddyfile differs from /etc/caddy/Caddyfile.hacs-stats."
    echo "      Review and apply manually if intended:"
    echo "      diff /etc/caddy/Caddyfile.hacs-stats $REPO_ROOT/deploy/Caddyfile"
  fi

  step "Restarting web service"
  systemctl restart hacs-stats-web.service
  # Scrape/discover/sweep are one-shot units — they pick up new code on
  # their next timer fire, no restart needed.

  step "Health check"
  local i
  for i in {1..10}; do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      echo "healthy: $HEALTH_URL"
      step "Deployed $(as_svc git rev-parse --short HEAD)"
      exit 0
    fi
    sleep 1
  done

  echo "HEALTH CHECK FAILED after 10s — recent logs:" >&2
  journalctl -u hacs-stats-web.service -n 30 --no-pager >&2 || true
  cat >&2 <<EOF

To roll back:
  cd $REPO_ROOT
  sudo -u $SERVICE_USER git reset --hard $old_rev
  sudo -u $SERVICE_USER pnpm install --frozen-lockfile
  sudo systemctl restart hacs-stats-web.service
(Migrations are additive-only and safe to leave applied.)
EOF
  exit 1
}

main "$@"
