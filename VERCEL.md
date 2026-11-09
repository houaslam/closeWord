# Deploy CloseWord on Vercel

The name-only MVP uses Supabase shared storage on Vercel, with Redis available as an explicit compatibility option. Accounts remain on `feature/accounts-auth`. Local development continues to use SQLite unless `GAME_STORAGE=redis` is selected.

## Your setup

**Use [SUPABASE.md](SUPABASE.md) for the current default deployment.** Run the supplied SQL migration in your Supabase project, add `GAME_STORAGE=supabase`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in Vercel, then redeploy. [.env.vercel.example](.env.vercel.example) is the settings template. A server secret stays in Vercel and is never sent to browsers.

Import the GitHub **main** branch with the Next.js preset and Node.js 24.x. Keep Vercel system environment variables enabled so generated deployment origins and Preview namespaces are derived safely. For a custom Production domain, set `PUBLIC_ORIGIN` in Production only. Do not upload private environment files, local databases or backups.

### Optional Redis deployment

The previous Upstash backend remains supported when you explicitly set `GAME_STORAGE=redis`. Connect Upstash through Vercel Marketplace and supply `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or the complete `KV_REST_API_URL/TOKEN` pair). Do not use Redis settings when selecting Supabase. The live project still needs real provider credentials and a successful deployed readiness check.

### Readiness

Check `/health/ready` after redeploying. It reports the selected storage provider and safe error codes when settings or the database schema are missing. A build alone does not provision or connect a database. See the provider setup guide for the exact corrective steps.

## How multiplayer works on Vercel

Each room and solo game lives in the selected shared database. Atomic compare-and-set operations enforce capacity and turn order, commit one winner, and award leaderboard points once even when players submit simultaneously. Matchmaking, rate limits, connection limits and presence are shared across instances. No local SQLite file or permanent in-memory room cache is used in either shared storage mode.

Clients receive Server-Sent Events. Each active connection checks shared state approximately once per second and receives only that player's permitted view. Streams rotate after approximately 45 seconds, below the configured 60-second function duration, and the browser reconnects with the same private seat token. Presence has a 12-second grace period so stream rotation does not skip a player's turn. Disconnected turn holders are skipped after that grace period. The frontend ignores older room revisions that arrive after a newer update.

Rooms and solo games expire after seven days without mutations. Preview data uses a separate namespace per deployment. Production data survives redeployments as long as the database and namespace remain the same. Local SQLite data is not automatically uploaded or migrated. Week/month shared leaderboard views aggregate the latest 7/30 UTC calendar days; all-time totals persist.

## Limits and operations

Choose a database plan suitable for the request volume. Active streams poll shared storage, so six connected players generate continuous database requests and consume Vercel function duration. Check both providers' usage and limits; this is not a guarantee of free hosting. For Redis, leave database eviction disabled so game state is not silently discarded under memory pressure. Configure a provider backup/restore policy appropriate to your plan, and monitor errors, latency, request quotas and function usage. SQLite backup scripts apply only to the local SQLite backend.

Optional `METRICS_TOKEN` protects `/metrics` with Bearer authorization. Do not share credentials or private seat tokens in logs. `/.env*`, `/data/*` and server source files are not public assets.

## Verification

```sh
npm run build
npm test
# With a local Redis server listening on port 6379:
REDIS_TEST_PORT=6379 npm run test:redis
```

The distributed tests use real Redis behind an HTTPS fixture, one production Next.js server, and an independent server process. They cover simultaneous joins, six-player race privacy, one winner, cold restarts, matchmaking, stream rotation, shared daily progress, hint limits, protected endpoints and distributed rate limits. CI provides Redis and runs this suite along with the existing SQLite tests. These checks do not substitute for testing the actual Upstash connection and deployed Preview.
