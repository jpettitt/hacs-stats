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

The script ends with a checklist for the manual steps (env file, enabling
the units). Don't enable the units yet if you're migrating existing data
from a laptop — finish the next section first.

## Migrating existing data (preserve scrape history)

If you've been running the scraper locally and want to keep the snapshot
history rather than starting from zero, ship the dev DB across **before**
starting the systemd services. The install script created an empty
`/var/lib/hacs-stats/hacs-stats.db` from migrations alone — we'll replace
it with the populated copy.

```sh
# On your laptop — consistent snapshot (no need to stop anything; WAL is
# safe to copy live):
sqlite3 ~/hacs-stats/data/dev.db ".backup /tmp/hacs-stats.db"

# Ship to the VPS:
scp /tmp/hacs-stats.db user@vps:/tmp/
```

```sh
# On the VPS — replace the empty file and re-own:
sudo mv /tmp/hacs-stats.db /var/lib/hacs-stats/hacs-stats.db
sudo chown hacs-stats:hacs-stats /var/lib/hacs-stats/hacs-stats.db
sudo chmod 0640 /var/lib/hacs-stats/hacs-stats.db

# Re-run migrations against the imported DB. Safe — every migration is
# additive / IF NOT EXISTS, so importing an older schema and re-running
# `pnpm migrate` just fast-forwards it to head without touching data:
sudo -u hacs-stats DATABASE_PATH=/var/lib/hacs-stats/hacs-stats.db \
  pnpm --dir /opt/hacs-stats migrate
```

The web process opens the DB in WAL mode; SQLite handles the `.db-wal`
and `.db-shm` sibling files on first open, so you only need to ship the
`.db` itself.

## Storing secrets

All sensitive config lives in `/etc/hacs-stats/env`, loaded by both
systemd units via `EnvironmentFile=`. The install script creates it
with mode `0640 root:hacs-stats` — readable by the service user, not
world-readable, never in git.

```sh
sudo $EDITOR /etc/hacs-stats/env
```

Required fields:

```ini
# REQUIRED — GitHub PAT (classic). No scopes needed; the unauth limit
# (60/hr) is too low to be useful and any authenticated token gets you
# the 5000/hr REST + 5000-point GraphQL quota we need.
GITHUB_TOKEN=ghp_…

# Database path — keep aligned with the systemd unit's ReadWritePaths
DATABASE_PATH=/var/lib/hacs-stats/hacs-stats.db

PORT=3000
NODE_ENV=production

# REQUIRED for the admin queue at /admin/queue. Generate with:
#   openssl rand -base64 24
ADMIN_USER=admin
ADMIN_PASS=<long random string>
```

Optional auto-approve thresholds (defaults in code; override only if you
want different policy):

```ini
# AUTOAPPROVE_MIN_STARS=50
# AUTOAPPROVE_KNOWN_OWNER_MIN_STARS=5
# AUTOAPPROVE_MAX_AGE_MONTHS=6
# AUTOAPPROVE_OFF=1     # disable auto-approve entirely
```

After editing, double-check perms:

```sh
sudo stat -c '%U:%G %a' /etc/hacs-stats/env
# expect: root:hacs-stats 640
```

The token never reaches the command line, `ps`, journal logs, or git.
Systemd unit hardening (`ProtectSystem=strict`, `ProtectHome=true`,
`PrivateTmp=true`) prevents the Node process from reading anything
outside `/var/lib/hacs-stats` and `/etc/hacs-stats/env` even if the
process is compromised.

**Rotating the GitHub token:**

```sh
# 1. Mint a new PAT on github.com/settings/tokens
# 2. Edit /etc/hacs-stats/env and replace GITHUB_TOKEN
sudo $EDITOR /etc/hacs-stats/env
sudo systemctl restart hacs-stats-web.service
# The scrape unit is one-shot and picks up the new token on its next
# timer fire (04:00 UTC) — no restart needed.
# 3. Revoke the old token on github.com/settings/tokens
```

## Enabling the services

Once the data is in place and the env is filled in:

```sh
sudo systemctl enable --now hacs-stats-web.service
sudo systemctl enable --now hacs-stats-scrape.timer
sudo systemctl reload caddy
```

Trigger an initial scrape rather than waiting for the timer:

```sh
sudo systemctl start hacs-stats-scrape.service
sudo journalctl -u hacs-stats-scrape.service -f
```

`journalctl` shows step counts (HACS-default fetch → manifest backfill →
GraphQL metadata → release REST → stats_cache rollup) and a `[scrape]
done` line when finished. ~3900 repos take 5–10 min depending on
GitHub's GraphQL responsiveness.

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

## Background jobs

Three systemd timers run on different cadences:

| Timer | When | What |
| --- | --- | --- |
| `hacs-stats-scrape.timer` | Daily 04:00 UTC | Refresh stars / downloads / release metadata for every catalogue entry. ~5–10 min. |
| `hacs-stats-discover.timer` | Sundays 02:00 UTC | One-pass GitHub code-search for new `hacs.json` repos. Auto-approves clear cases, queues the rest for `/admin/queue`. ~2 min. |
| `hacs-stats-sweep.timer` | Wednesdays 03:00 UTC | Walks every `status='pending'` queue row, re-fetches stars / pushed_at, applies the same promote / auto-reject rules as live discovery. ~12 min. |

Enable them all at install time:

```sh
sudo systemctl enable --now hacs-stats-scrape.timer
sudo systemctl enable --now hacs-stats-discover.timer
sudo systemctl enable --now hacs-stats-sweep.timer
```

Inspect:

```sh
systemctl list-timers 'hacs-stats-*'
journalctl -u hacs-stats-discover.service --since '1 day ago'
```

### Manual fire (don't wait for the timer)

```sh
sudo systemctl start hacs-stats-scrape.service
sudo systemctl start hacs-stats-discover.service
sudo systemctl start hacs-stats-sweep.service
journalctl -u hacs-stats-<which>.service -f
```

### `pnpm discover:bands` (still manual)

The full 15-band size sweep that breaks past GitHub's 1000-result
code-search cap isn't on a timer — it's a heavier one-off when you want
deeper coverage. Run manually:

```sh
sudo -u hacs-stats bash -c '
  set -a; source /etc/hacs-stats/env; set +a
  cd /opt/hacs-stats
  pnpm discover:bands
'
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

## Wiring our Caddyfile into Caddy

`install.sh` writes our config to `/etc/caddy/Caddyfile.hacs-stats` but
deliberately doesn't modify the main `/etc/caddy/Caddyfile` so a fresh
install never clobbers an existing one. You have to wire it in once:

```sh
# Option A — replace the default file entirely (recommended for a
# single-purpose VPS where Caddy only serves hacs-stats):
sudo cp /etc/caddy/Caddyfile.hacs-stats /etc/caddy/Caddyfile
sudo systemctl reload caddy

# Option B — keep the default file and import ours (useful if Caddy
# serves other sites on the same host):
echo 'import /etc/caddy/Caddyfile.hacs-stats' | sudo tee -a /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Verify Caddy is actually loading what you expect:

```sh
# Show the fully-parsed config Caddy is running on (JSON):
sudo caddy adapt --config /etc/caddy/Caddyfile | head -40

# Or via the admin API on the local socket:
sudo curl -s localhost:2019/config/ | jq .
```

If you see Caddy's default welcome page when hitting the site, one of
these is wrong:

- The main `/etc/caddy/Caddyfile` doesn't include our config (neither
  replaced nor `import`-ed) — Caddy is still serving its install-time
  defaults.
- Our Caddyfile has a parse error and Caddy fell back to defaults.
  `sudo caddy validate --config /etc/caddy/Caddyfile` reports the line.
- DNS / Host header doesn't match the site block (`hacs-stats.dev`). If
  you're testing direct on the VPS by IP or before DNS propagates, add
  `--header "Host: hacs-stats.dev"` to your `curl`, or temporarily add
  a `:80 { reverse_proxy 127.0.0.1:3000 }` block.

## Troubleshooting

- **Caddy welcome page instead of the app:** see "Wiring our Caddyfile
  into Caddy" above.
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
