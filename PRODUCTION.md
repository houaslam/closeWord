# Production deployment

The supplied architecture is a single Node.js 24 game server, private SQLite storage, Caddy for public HTTPS, and an encrypted daily backup worker. It is suitable for a small deployment within the tested workload. It is not a multi-region or multi-replica service.

## Required external configuration

1. A Linux host with Docker Engine and Docker Compose v2, persistent storage, and ports 80/443 available.
2. A real domain whose DNS points to that host.
3. A Resend sending-only key and a verified sender domain. Confirm actual OTP delivery to an inbox before opening registration publicly.
4. A separate destination for encrypted off-host backups, and a securely retained copy of the backup key.
5. Monitoring that alerts an operator on health failures, HTTP errors, backup failures and resource pressure.

These cannot be verified from local code or replaced with dummy credentials. Production startup intentionally fails without HTTPS origin and email configuration.

## Deploy

```sh
npm ci
npm run secrets:init
```

Put the real API key in `.secrets/resend_api_key` without committing or printing it. Set `DOMAIN=game.yourdomain.com` and `EMAIL_FROM=CloseWord <accounts@yourdomain.com>` in a private `.env`. Docker Compose mounts the key and metrics token as secret files. The app runs as UID 1000, so those mounted files must be readable by UID 1000 while remaining private on the host. On a root-managed Linux host, set their owner to 1000 and mode to 0600; keep `.secrets` itself private. Back up the key separately before changing ownership.

```sh
docker compose config --quiet
docker compose build --pull
SMOKE_IMAGE=closeword:local npm run test:container
docker compose up -d
docker compose exec app node scripts/readiness.mjs --application-only
```

Only Caddy publishes ports. Do not publish the app's port directly while `TRUST_PROXY=true`: forwarded client addresses are trusted only because Caddy is the sole ingress. If using another proxy, either keep that same network isolation or set `TRUST_PROXY=false`. Set `PUBLIC_ORIGIN` to the exact HTTPS origin; cross-origin mutations are rejected.

Containers use non-root execution, dropped capabilities, a read-only app filesystem, memory/CPU limits and a persistent `/data` volume. Caddy obtains certificates for the configured domain. `flush_interval -1` keeps room updates live. No proxy access log is enabled, so room tokens in SSE query strings are not written to proxy access logs. The app logs method/path/status/timing/request ID without query strings, request bodies, cookies or passwords.

Run the built container and validate readiness after deploying. Run an actual email signup, play a game from two separate networks, verify history after re-login, restart the app and verify reconnects. Local test results do not replace those checks.

## Health and monitoring

- `GET /health/live`: process liveness.
- `GET /health/ready`: database availability and readiness.
- `GET /metrics`: Prometheus text metrics, protected by `Authorization: Bearer ...` using the private metrics token. Do not put this token in a URL.

Track request/error counts, RSS memory, event-loop p99, open room streams, app readiness and backup-container health. Configure alerts in the host's monitoring service; no external alert destination is configured in this repository.

The supplied limits include 2,000 rooms/challenges, 20,000 active solo puzzles, 1,000 live streams, 2,000 guesses per puzzle/room, 8 KB request bodies, two streams per seat and endpoint-specific rate limits. These are safety ceilings, not a proven capacity claim. The repeatable load test measures 120 game clients and two concurrent password hashes. Re-run it on the actual host before raising limits.

## Backups and restore

The backup service makes encrypted snapshots on startup and every 24 hours. It retains 30 days locally. Its health check fails if a successful snapshot is older than 26 hours. Copy encrypted archives off the host using your infrastructure backup system. A backup volume on the same disk is not sufficient protection against host loss. Preserve `.secrets/backup.key` separately; losing it makes archives unrecoverable.

For a manual snapshot:

```sh
docker compose run --rm backups node scripts/backup.mjs /backups/manual.sqlite.enc
```

To recover, stop the app, restore into a new file, inspect it, then point `DATABASE_PATH` or the data-volume layout to the recovered file. Never restore over a live database. The restore command intentionally refuses an existing destination. A clean restore revokes all saved sessions and OTP challenges, so users must log in again. Data and passwords represent the point in time of the chosen backup.

```sh
BACKUP_KEY_FILE=/private/backup.key node scripts/restore.mjs /private/backup.sqlite.enc /private/recovery/closeword.sqlite
```

Test a restore on a separate path regularly, not just backup creation. Keep the previous database until recovery is verified.

## Updates and rollback

Before an update, take a verified encrypted snapshot. Pull a tested image, recreate only the app, check readiness, real email delivery, and one multiplayer round. Schema versions are recorded; the app refuses a newer schema it cannot understand. If rollback needs an older data format, restore the matching backup into a new path and switch deliberately. Do not run two versions against the same data volume.

A graceful SIGTERM drains requests and pending emails and releases the writer lease. An abrupt crash may require up to 30 seconds before a replacement can claim ownership. Fencing prevents the old instance from committing writes after takeover.

## Current validation boundary

Unit/integration tests, load tests, migration and backup/restore exercises run locally on Node 24. Container and proxy configuration validation is also included in CI. Actual public DNS, certificate issuance, live email delivery, off-host backup transport, and operator alerts require the real deployment environment. No external security audit has been performed.
