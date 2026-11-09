# Deploying the name-only MVP

The application uses Next.js 16 and React 19, with native Next.js API routes. It supports one active Node.js server with persistent SQLite storage. Remote players need a reachable HTTPS hostname. Accounts and email delivery are not part of this branch.

## Vercel status

The Next.js migration is complete, but the server still stores active rooms and live-stream connections in one process and persists data to local SQLite. Vercel deployment requires shared online game storage, distributed event coordination, presence and rate limiting, and recovery across function instances. The current version is intended for a persistent single-server host; uploading it unchanged to Vercel is not supported.

## Container deployment

1. Point a domain's DNS to your server and allow inbound ports 80 and 443.
2. Run `npm run secrets:init` to create private metrics and backup keys. Keep a separate protected copy of `.secrets/backup.key`.
3. Set `DOMAIN=game.yourdomain.com` in your deployment environment or private `.env`.
4. Run `docker compose up --build -d`.

Compose exposes Caddy, which manages HTTPS, and keeps the game server private. It persists `mvp.sqlite` in the `game_data` volume and encrypted daily snapshots in `encrypted_backups`. No Resend key, sender address, or account configuration is required. Never delete volumes during an upgrade.

The app container runs as UID 1000 with a read-only root, dropped capabilities, no privilege escalation, resource limits, and a writable data volume. The backend trusts forwarded addresses only because Caddy is the sole public ingress. Do not expose its port directly when `TRUST_PROXY=true`.

For a non-Compose host, run `npm ci` and `npm run build`. Start the compiled app with `npm start`. Use Node.js 24.22.2+ in the 24.x line and set `NODE_ENV=production`, an exact HTTPS `PUBLIC_ORIGIN`, a writable persistent `DATABASE_PATH` (default `data/mvp.sqlite`), and a private `HOST`/`PORT` behind your HTTPS proxy. Set `TRUST_PROXY=true` only with a trusted proxy that appends the real client address. Secrets and data must never be web-served. Local development needs no environment file.

## Verification and operations

Run `npm test`, `npm run loadtest`, `npm run format:check`, and, after building `closeword:local`, `npm run test:container`. `npm run readiness` checks production configuration, word checksums, database integrity, and the backup key. Verify public TLS and invite links from a separate device before opening access.

`/health/live` and `/health/ready` support monitoring. `/metrics` requires a Bearer token set through `METRICS_TOKEN` or `METRICS_TOKEN_FILE`. Logs exclude query strings, request bodies and room tokens. Monitor errors, memory, latency, restart frequency, disk space, and failed/stale backups.

The load test is a bounded workload of 120 clients in 20 rooms, not a capacity guarantee. The application enforces request, connection, room, guess and body limits. Multiple active replicas require a shared event architecture and are not supported.

## Backup and recovery

```sh
npm run secrets:init
BACKUP_KEY_FILE=.secrets/backup.key npm run backup -- /private/backups/mvp.sqlite.enc
BACKUP_KEY_FILE=.secrets/backup.key npm run restore -- /private/backups/mvp.sqlite.enc /private/recovery/mvp.sqlite
```

Snapshots use SQLite's online backup API and AES-256-GCM. Restore validates authentication and integrity and refuses to overwrite an existing database. Stop the app, restore to a new path, configure `DATABASE_PATH`, and restart. Confirm games and health before retaining the recovered deployment. Keep backup archives off-host and the encryption key separately. Test restores regularly; local snapshots alone do not protect against losing the host.

Graceful shutdown drains requests and flushes state. After a crash, wait up to 30 seconds for the writer lease to expire. Do not bypass the lease while another process is active.

## Preserved account version

`feature/accounts-auth` preserves the account implementation and its deployment documentation. Its original local database, `data/closeword.sqlite`, was not removed. The MVP uses `data/mvp.sqlite` instead. Git does not switch private `.env` files or databases: explicitly select the corresponding database and configuration when returning to that branch.
