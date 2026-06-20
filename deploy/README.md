# Deployment

VPS deploy guide for `hacs-stats`. Targets Ubuntu 24.04 / Debian 12 with
Cloudflare in front for CDN + TLS.

## Topology

```text
Browser ──HTTPS (CF edge cert)──▶ Cloudflare ──HTTPS (CF Origin Cert)──▶ VPS:443
                                                                            │
                                                                            ▼
                                                                       Caddy → :3000 (Node)
                                                                                  │
                                                                                  ▼
                                                                            /var/lib/hacs-stats/
                                                                              hacs-stats.db
```

- **Caddy** terminates TLS on the VPS using a Cloudflare-issued **Origin
  Certificate** (free, 15-year validity, not publicly trusted but trusted by
  Cloudflare). No Let's Encrypt needed.
- **Cloudflare SSL/TLS mode:** Full (strict).
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
2. **SSL/TLS → Overview** — set encryption mode to **Full (strict)**.
3. **SSL/TLS → Origin Server → Create Certificate** — defaults are fine
   (RSA 2048, 15 years, both hostnames). Save the certificate (`.pem`) as
   `/etc/caddy/cf-origin.crt` and the private key as `/etc/caddy/cf-origin.key`
   on the VPS. Then:

   ```sh
   sudo chown root:caddy /etc/caddy/cf-origin.*
   sudo chmod 0644 /etc/caddy/cf-origin.crt
   sudo chmod 0640 /etc/caddy/cf-origin.key
   ```

4. **Rules → Page Rules** (or **Configuration Rules**) — add
   `hacs-stats.com/*` → 308 redirect to `https://hacs-stats.dev/$1`. Caddy has
   a fallback redirect too, but doing it at CF saves a round-trip.

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
- **Cloudflare 525 SSL handshake error:** the origin cert isn't installed or
  is the wrong file. Verify with `openssl x509 -in /etc/caddy/cf-origin.crt -text -noout`.
- **`SQLITE_BUSY` in web logs:** the scraper is holding a long write
  transaction. Should be rare; if persistent, raise the connection
  `busy_timeout` pragma in `packages/db/src/client.ts`.
- **Disk full:** check rollup job ran (`select count(*) from release_asset_snapshots`).
  If retention isn't kicking in, manually trigger a rollup once the job exists.
