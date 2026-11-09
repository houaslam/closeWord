# Deploy CloseWord on Vercel

The name-only MVP now has a shared Redis backend for Vercel. Accounts remain on `feature/accounts-auth`. Local development continues to use SQLite unless `GAME_STORAGE=redis` is selected.

## Your setup

1. Push the project to GitHub and import the **`main`** branch into Vercel. Use the **Next.js** framework preset, Node.js **24.x**, the repository root, and the build/install commands from `vercel.json`. Do not upload `.env`, `.secrets`, databases, or backups.
2. In your Vercel project's **Storage / Marketplace**, connect **Upstash Redis**. Select a region close to the application's `iad1` region. Configure separate Preview and Production databases where possible. The integration can add the connection environment variables automatically.
3. Ensure these **server-only** variables are available in the deployment environment:

   | Variable                   | Value                                                        |
   | -------------------------- | ------------------------------------------------------------ |
   | `UPSTASH_REDIS_REST_URL`   | The database's HTTPS REST endpoint, without a trailing slash |
   | `UPSTASH_REDIS_REST_TOKEN` | Its **read/write** REST token, not the read-only token       |

   The Vercel integration's `KV_REST_API_URL` and `KV_REST_API_TOKEN` names are also supported as a complete pair. Use either complete pair. Never prefix these credentials with `NEXT_PUBLIC_`.

4. Keep Vercel's system environment variables enabled. The app automatically selects Redis, derives its deployment origin, and separates the Production namespace from each Preview deployment. For a custom Production domain, set `PUBLIC_ORIGIN=https://your-domain.com` in **Production** only, with no trailing slash. An optional `GAME_NAMESPACE` override must use different values in Preview and Production. No email credentials are needed.
5. Deploy a **Preview**, open `/health/ready`, and confirm `{"ready":true,"storage":"redis"}`. Test an invite with six separate browsers/devices, then deploy to Production. Environment changes require a redeployment.

Use [.env.vercel.example](.env.vercel.example) as the settings template. Do not add `DATABASE_PATH`, `HOST`, `PORT`, `TRUST_PROXY`, or file-based secrets in Vercel. The generated deployment hostname, branch hostname and configured public origin are accepted; arbitrary request hostnames are not trusted.

Official setup references: [Vercel Marketplace storage](https://vercel.com/docs/marketplace-storage), [Upstash's Vercel integration](https://upstash.com/docs/redis/howto/vercelintegration), and [Vercel system variables](https://vercel.com/docs/environment-variables/system-environment-variables).

## Check credentials before launch

After pulling or securely creating a private `.env.vercel.local` file containing the real database URL and token:

```sh
node --env-file=.env.vercel.local scripts/vercel-check.mjs
```

With credentials already exported in your shell, use `npm run vercel:check`. The check verifies HTTPS access, a temporary write/read/delete, Lua support, and bundled word artifacts. It prints no credentials. Placeholder values are not real credentials; a successful build alone does not prove that the database is connected. The code is prepared, but live deployment remains unverified until your actual database is connected and the Preview passes.

## How multiplayer works on Vercel

Each room and solo game lives in shared Redis. Atomic compare-and-set scripts enforce capacity and turn order, commit one winner, and award leaderboard points once even when players submit simultaneously. Matchmaking, rate limits, connection limits and presence are shared across instances. No local SQLite file or permanent in-memory room cache is used in Redis mode.

Clients receive Server-Sent Events. Each active connection checks shared state approximately once per second and receives only that player's permitted view. Streams rotate after approximately 45 seconds, below the configured 60-second function duration, and the browser reconnects with the same private seat token. Presence has a 12-second grace period so stream rotation does not skip a player's turn. Disconnected turn holders are skipped after that grace period. The frontend ignores older room revisions that arrive after a newer update.

Rooms and solo games expire after seven days without mutations. Preview data uses a separate namespace per deployment. Production data survives redeployments as long as the database and namespace remain the same. Local SQLite data is not automatically uploaded or migrated. Week/month Redis leaderboard views aggregate the latest 7/30 UTC calendar days; all-time totals persist.

## Limits and operations

Choose a Redis plan suitable for the request volume. Active streams poll Redis, so six connected players generate continuous Redis requests and consume Vercel function duration. Check both providers' usage and limits; this is not a guarantee of free hosting. Leave database eviction disabled so game state is not silently discarded under memory pressure. Configure a Redis backup/restore policy appropriate to your plan, and monitor errors, latency, request quotas and function usage. SQLite backup scripts apply only to the local SQLite backend.

Optional `METRICS_TOKEN` protects `/metrics` with Bearer authorization. Do not share credentials or private seat tokens in logs. `/.env*`, `/data/*` and server source files are not public assets.

## Verification

```sh
npm run build
npm test
# With a local Redis server listening on port 6379:
REDIS_TEST_PORT=6379 npm run test:redis
```

The distributed tests use real Redis behind an HTTPS fixture, one production Next.js server, and an independent server process. They cover simultaneous joins, six-player race privacy, one winner, cold restarts, matchmaking, stream rotation, shared daily progress, hint limits, protected endpoints and distributed rate limits. CI provides Redis and runs this suite along with the existing SQLite tests. These checks do not substitute for testing the actual Upstash connection and deployed Preview.
