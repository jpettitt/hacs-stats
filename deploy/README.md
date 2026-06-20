# Deployment

VPS deploy guide for `hacs-stats`. Targets Ubuntu 24.04 / Debian 12 with
Cloudflare in front for CDN + TLS.

## Topology

```text
Browser ──HTTPS (CF edge cert, publicly trusted)──▶ Cloudflare
                                                       │
                                                       │  HTTPS (Caddy self-signed,
                                                       │   accepted by CF "Full")
                                                       ▼
                                                    VPS:443
                                                       │
                                                       ▼
                                                  Caddy → :3000 (Node)
                                                              │
                                                              ▼
                                                        /var/lib/hacs-stats/
                                                          hacs-stats.db
```

- **Cloudflare edge** serves the publicly-trusted certificate to browsers
  (auto-managed). No publicly-trusted cert is ever installed on the VPS.
- **Caddy** terminates TLS at the origin using a Caddy-issued self-signed
  cert (`tls internal` directive) — auto-issued, auto-renewed, zero touch.
- **Cloudflare SSL/TLS mode:** **Full** (NOT "Full (strict)" — strict would
  reject the self-signed cert).
- **Node web** runs as `systemd` user `hacs-stats`, binds `127.0.0.1:3000`
  only — never directly exposed.
- **Scraper** is a one-shot job fired by `hacs-stats-scrape.timer`
  (daily, 04:00 UTC).
- **DB** is a single SQLite file at `/var/lib/hacs-stats/hacs-stats.db`,
  WAL mode, owned by the service user.

## First-time install

```sh
# 1. Clone to /opt
sudo git clone https://github.com/jpettitt/hacs-stats /opt/hacs-stats
cd /opt/hacs-stats

# 2. Run the bootstrap (installs Node + Caddy + systemd units, creates user
#    + dirs, applies migrations). Idempotent — safe to re-run.
sudo bash deploy/install.sh
```

The script ends with a checklist for the manual steps (Cloudflare Origin Cert
file drop, `GITHUB_TOKEN` in `/etc/hacs-stats/env`, enabling the units).

## Cloudflare setup (one-time, in the dashboard)

1. **DNS** — add an A record for `hacs-stats.dev` → VPS public IP. Set the
   proxy status to **on** (orange cloud). Add a CNAME `hacs-stats.com → hacs-stats.dev`
   (also proxied).
2. **SSL/TLS → Overview** — set encryption mode to **Full**.
   Not "Full (strict)" — Caddy serves a self-signed cert and "strict"
   rejects anything not chained to a public CA.
3. **Rules → Page Rules** (or **Configuration Rules**) — add
   `hacs-stats.com/*` → 308 redirect to `https://hacs-stats.dev/$1`. Caddy has
   a fallback redirect too, but doing it at CF saves a round-trip.

That's it for the cert story — no Origin Certificate to generate, no key
material to ship to the VPS, no renewal calendar entry. Caddy's `tls internal`
issues its own cert on first start and rotates it before expiry.

## Updates

```sh
cd /opt/hacs-stats
sudo -u hacs-stats git pull
sudo -u hacs-stats pnpm install --frozen-lockfile
sudo -u hacs-stats DATABASE_PATH=/var/lib/hacs-stats/hacs-stats.db pnpm migrate
sudo systemctl restart hacs-stats-web.service
```

The scrape job picks up the new code on its next timer fire — no restart
needed; it's one-shot.

## Manual scrape

```sh
sudo systemctl start hacs-stats-scrape.service
journalctl -u hacs-stats-scrape.service -f
```

## Backups

SQLite is one file — back it up with `sqlite3 .backup` (consistent snapshot,
no need to stop the web process):

```sh
sudo -u hacs-stats sqlite3 /var/lib/hacs-stats/hacs-stats.db \
  ".backup /var/lib/hacs-stats/backup-$(date -u +%Y%m%d).db"
```

Push the backup file off-host (rsync to another VPS, or `rclone copy` to
object storage). A weekly systemd timer for this is on the Phase 7 TODO.

## Troubleshooting

- **502 from Caddy:** `systemctl status hacs-stats-web.service`. If the Node
  process is up but Caddy can't reach it, check `ss -tlnp | grep 3000`.
- **Cloudflare 525 SSL handshake error:** check that CF SSL mode is **Full**
  not "Full (strict)" — strict rejects Caddy's self-signed cert. Then check
  Caddy is actually serving 443: `ss -tlnp | grep :443`. If Caddy hasn't
  generated its internal cert yet, `systemctl restart caddy` and watch
  `journalctl -u caddy -f` for the issuance line.
- **`SQLITE_BUSY` in web logs:** the scraper is holding a long write
  transaction. Should be rare; if persistent, raise the connection
  `busy_timeout` pragma in `packages/db/src/client.ts`.
- **Disk full:** check rollup job ran (`select count(*) from release_asset_snapshots`).
  If retention isn't kicking in, manually trigger a rollup once the job exists.
