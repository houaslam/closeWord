# Set up Supabase for CloseWord

Supabase is now the default database provider on Vercel. The MVP remains name-only, with no Supabase Auth requirement. Redis remains an optional explicit backend; ordinary local development still uses SQLite.

## Connect your real project

1. Create a Supabase project for this app, or select your existing project.
2. Open **SQL Editor**, paste the complete contents of [the migration](supabase/migrations/202611090001_closeword.sql), and run it. It creates the game tables and the server-only database functions. The migration is transactional and can be run again without deleting existing games.
3. Find the **Project URL** and a **server secret key** under the project's API settings. Prefer the current `sb_secret_...` key. The legacy `service_role` JWT also works. An `anon` or publishable key will not work.
4. In **Vercel → Project → Settings → Environment Variables**, add:

   | Variable              | Value                              |
   | --------------------- | ---------------------------------- |
   | `GAME_STORAGE`        | `supabase`                         |
   | `SUPABASE_URL`        | `https://your-project.supabase.co` |
   | `SUPABASE_SECRET_KEY` | Your `sb_secret_...` server key    |

   If using the legacy server key, set `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`. Keep server keys out of `NEXT_PUBLIC_` variables, source control and chat messages. No Redis or email credentials are needed for Supabase mode.

5. Apply these settings to the intended **Production** and **Preview** environments, then **redeploy**. Use separate Supabase projects for Preview and Production when practical; otherwise the app also isolates data namespaces automatically. Do not set the same manual `GAME_NAMESPACE` in both environments.
6. Open `/health/ready`. A configured deployment returns `{"ready":true,"storage":"supabase"}`. Test an invite from six browsers/devices before opening the game to other players.

The project schema and code are prepared, but your actual Supabase project cannot be connected without these account-specific settings. The SQL has been verified against PostgreSQL; live Supabase credentials and the deployed connection still require verification.

References: [Supabase server API keys](https://supabase.com/docs/guides/getting-started/api-keys), [database function privileges](https://supabase.com/docs/guides/database/functions), and [Data API security](https://supabase.com/docs/guides/api/securing-your-api).

## Verify your settings privately

With real credentials in an ignored private `.env.vercel.local` file:

```sh
node --env-file=.env.vercel.local scripts/vercel-check.mjs
```

Or run `npm run vercel:check` when the variables are already exported. It checks the schema version and creates, reads and deletes an isolated probe inside a database transaction. It never prints keys. A successful build alone does not connect a database or apply the migration.

Readiness codes:

- `MISSING_SUPABASE_CONFIG`: add the project URL and server key in the affected Vercel environment, then redeploy.
- `SUPABASE_SCHEMA_MISSING`: run the migration in the same Supabase project as the URL/key.
- `SUPABASE_ACCESS_DENIED`: check the server key and RPC execution grants.
- `INVALID_SUPABASE_KEY`: use a server secret or legacy service role key.
- `SUPABASE_UNAVAILABLE`: check project availability, quotas and network connectivity.

## Storage and live updates

Rooms, solo progress, metadata, leaderboards, rate limits, connection slots and presence live in PostgreSQL. The database commits room versions and winner awards together. Concurrent joins cannot exceed capacity, and simultaneous winning submissions cannot award multiple winners. Daily words and progress are shared across server instances.

The browser continues to receive filtered Server-Sent Events, with automatic reconnects when Vercel streams rotate. Each player receives only their permitted guesses and never the secret target before the round ends. Supabase Realtime publications are not needed, and the raw game tables are never published to anonymous browser subscriptions. This keeps name-only play possible without exposing private room tokens or answers.

Tables live in the private `closeword_private` schema with Row Level Security enabled and no anonymous grants. The public RPC functions have a fixed empty search path, explicit table references, and execution granted only to `service_role`. The Next.js server checks room tokens, origins, turns and host actions before calling them. Neither `anon` nor `authenticated` can call the administrative game RPCs or read the private tables.

Game records expire logically after seven days without mutations. Create operations prune expired records in their namespace; `public.closeword_cleanup()` removes expired records and stale presence across namespaces. Schedule that cleanup through Supabase Cron for an active production service. For example, after enabling the `pg_cron` extension in Supabase:

```sql
select cron.schedule(
  'closeword-cleanup',
  '*/15 * * * *',
  'select public.closeword_cleanup()'
);
```

Configure Supabase backups and usage monitoring appropriate to your plan. SQLite backup scripts apply only to the local backend. Existing SQLite or Redis data is not automatically copied into Supabase. The preserved account branch remains unchanged.

## Development verification

```sh
npm run build
npm test
# With an isolated PostgreSQL test server on port 5432:
PG_TEST_PORT=5432 npm run test:supabase
```

The integration fixture applies the actual SQL migration twice, serves the RPCs over trusted test HTTPS, and runs one production Next.js process and one independent game-server process. Tests cover six-player race privacy, atomic winners, concurrent capacity checks, cold restarts, rematches, matchmaking, stream renewal, hints, daily progress, and anonymous permission denial. CI supplies PostgreSQL and Redis so all supported backends are checked.
