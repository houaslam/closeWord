# CloseWord — Next.js MVP

Name-only word games for **2–6 remote players**, with turn-by-turn and speed-race modes. Enter a nickname, choose the room size, and invite friends using a link or room code. The host starts with at least two players. The first player to find the secret word wins; everyone sees the result and can play a rematch.

## Run locally

Built with **Next.js 16.4.5, React 19.3.1, and JavaScript**. The interface uses React components and Next.js routing; game requests and Server-Sent Events run through native Next.js API routes. Supabase is the default shared database on Vercel.

Use Node.js **24.22.2 or newer in the 24.x LTS line** (`nvm use`).

```sh
npm ci
npm run dev
```

Open [the multiplayer lobby](http://localhost:3000/multiplayer). No accounts, email provider, or `.env` file are needed for local play. The server binds to this machine by default. A localhost invite cannot reach another device; use a public HTTPS deployment for remote friends, as described in [PRODUCTION.md](PRODUCTION.md).

Each browser keeps its nickname and private room-seat token locally. Returning to the same invite in that browser reconnects to the seat. Names are display names and are not verified identities. Lost browser storage cannot be recovered through an account.

## Branches and saved data

- `main`: this name-only MVP.
- `feature/accounts-auth`: the preserved email verification, login, account settings, password recovery, and personal game-history implementation (baseline commit `a1f60f9`).

The MVP defaults to `data/mvp.sqlite`; the account version used `data/closeword.sqlite`. Existing account databases and private credentials have been left intact. `.env` and databases are intentionally excluded from Git. When switching back to the account branch, configure `DATABASE_PATH=data/closeword.sqlite` and its email settings separately. Do not run both versions against the same database.

## Gameplay and persistence

The host chooses a capacity from two to six, enforced by the server. Matchmaking groups waiting rooms by mode and capacity. Turn-by-turn shares guesses and rotates turns, skipping disconnected players. Speed race keeps each player's guesses private until completion, while showing best ranks and guess counts. Both support reconnects, host transfer, server-authoritative winners, round scores, and rematches. Daily puzzles, practice, and custom challenges are also available.

Local rooms, guesses, solo progress and nickname leaderboard entries persist in SQLite with WAL, full synchronous commits and transactional updates. Run **one active server** per SQLite database. Writer leases fence stale processes after takeover; an abrupt crash can require up to 30 seconds before restart. Inactive games expire after seven days. This MVP has no personal account history.

## Project structure

- `pages/`: Next.js pages, document, global application wrapper, and API routes.
- `components/`: React game screens, dialogs, and shared controls.
- `lib/game-service.mjs`: local SQLite multiplayer and solo game service.
- `lib/shared-game-service.mjs`: common multiplayer logic and filtered live streams.
- `lib/supabase-store.mjs` and `supabase/migrations/`: Supabase storage and database schema.
- `lib/redis-store.mjs`: optional Redis storage compatibility.
- `lib/client.js`: browser API and local-storage helpers.
- `styles/globals.css`: the existing game design, now imported by Next.js.
- `engine.mjs` and `storage.mjs`: semantic word rankings and SQLite persistence.

## Production and Vercel

Build with `npm run build`, then run `PUBLIC_ORIGIN=https://game.yourdomain.com npm start` behind an HTTPS proxy. `npm run dev` provides the local development server. The Docker image builds and runs the production Next.js application.

For **Vercel**, follow [SUPABASE.md](SUPABASE.md) and use [.env.vercel.example](.env.vercel.example). Run the database migration, add your Supabase project URL and server secret in Vercel, and redeploy. Supabase mode shares rooms, presence, matchmaking and rate limits across function instances. Production and Preview data are isolated by default. The MVP needs no Supabase Auth or email service. Redis is still available with an explicit `GAME_STORAGE=redis` setting.

The backend and migration are implemented and locally tested. Your actual Supabase credentials, applied schema, and successful deployed Preview are still required. The account branch remains unchanged.

## Verification

```sh
npm run build
npm test
npm run loadtest
npm run format:check
```

Tests cover six independent connections, both game modes, capacity limits, race privacy, winner announcement, rematches, reconnects, HTTP validation, origin protection, database fencing, crash recovery, and encrypted backups. The load test uses 20 rooms and 120 connected clients and verifies that every client receives the final result. The production Next.js integration test checks native API routes with six live clients, race privacy, winners, reconnects and rematches, as well as React page delivery and per-request script nonces. Build before running the full suite; that integration test is skipped if no production build exists. CI builds first, supplies real PostgreSQL and Redis for cross-instance multiplayer tests, and also validates deployment configuration and the container. See [VERCEL.md](VERCEL.md) for deployment-specific verification.

## Words

Includes **50,000 normalized 50-dimensional GloVe vectors** and **1,038 possible secret words**. Rank 1 is the answer; other guesses are ordered by cosine similarity. Rankings run locally and differ from the original site's private model. Daily answers use a private keyed hash and are persisted for the day; practice and multiplayer targets use cryptographic random selection.

The bundled alphabetic subset of `glove-wiki-gigaword-50` comes from [Gensim-data](https://github.com/piskvorky/gensim-data#models), based on [Stanford GloVe](https://nlp.stanford.edu/projects/glove/). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Artifact checksums are checked at startup. This is an independent recreation with its own puzzle schedule and leaderboard.
