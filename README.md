# CloseWord — six-player edition

Daily semantic word puzzles, practice, custom challenges, private rooms, turn-by-turn and speed-race modes, email-verified accounts, and account game history. Hosts choose a room limit of 2–6 remote players.

## Local development

Use **Node.js 24.22.2 or newer in the 24.x LTS line** (`nvm use` reads `.nvmrc`). Production has no third-party npm runtime dependencies; the only development dependency is the pinned formatter.

```sh
npm ci
npm run secrets:init
cp .env.example .env # only if you do not already have .env
npm start
```

Open http://localhost:3000. Development binds to loopback by default. Guest games work immediately. Account creation needs a real sending-only Resend key in `.secrets/resend_api_key` and a verified `EMAIL_FROM` in `.env`. The normal app never exposes an OTP or creates an unverified account when email is unconfigured. Automated tests use a separate, test-only inbox.

## Multiplayer

Choose a nickname or log in, choose a mode and a player limit, then **Invite friends**. Each person opens the generated URL on their own device. The host starts when at least two people have joined. The chosen capacity is enforced by the server. Matchmaking groups waiting rooms by mode and capacity.

Turn-by-turn shares guesses and rotates turns; disconnected players are skipped. Speed race keeps each participant's guesses private until the round finishes while exposing best ranks and guess counts. Both modes have reconnects, server-authoritative results, host transfer on leaving, and rematches. Up to two simultaneous game tabs are allowed per seat.

A localhost URL works only on this machine. Internet participants need the public HTTPS deployment described in [PRODUCTION.md](PRODUCTION.md).

## Accounts

Signup collects email, nickname, password, and password confirmation. A six-digit code must be verified before the account exists. Codes expire after ten minutes, allow five attempts, and may be resent after 60 seconds. Passwords are salted and hashed with scrypt. Sessions use HttpOnly cookies; production also uses Secure and the `__Host-` prefix. Password resets revoke all sessions. Password changes revoke other devices. Signup responses do not reveal account or nickname availability before email proof.

**My account** shows latest games, opponents, results, wins/losses, win rate, guess counts, and result filters. Game details show the board, hints, best rank, duration, winner, and each participant's result. Active secrets stay hidden. History starts with games played while signed in; guest history is not silently claimed. Signed-in daily progress follows the account across devices.

## Storage and recovery

Accounts, sessions, OTP challenges, rooms, solo progress, leaderboard entries and game history live in one SQLite database: `data/closeword.sqlite` (`DATABASE_PATH` overrides it). WAL, full synchronous commits, uniqueness constraints, transactional game updates, and indexed history queries are enabled. Only changed state rows are written. History is queried in pages rather than loaded wholesale.

This deployment runs **one game-server instance**. Active rooms remain cached in that process; SQLite writer leases fence a stale instance after takeover. Graceful shutdown drains requests and email work, ends live streams, flushes state and releases the lease. After an abrupt crash, takeover may wait up to 30 seconds. Scaling to multiple active replicas requires a shared room/event architecture and is not supported by this package.

Existing `data/accounts.json` and `data/state.json` are imported transactionally once. The source files remain untouched for rollback and should be archived privately after validating migration. Invalid legacy data causes startup to fail rather than silently dropping accounts. Do not run the old server while migrating.

```sh
npm run backup -- /private/backups/closeword.sqlite.enc
npm run restore -- /private/backups/closeword.sqlite.enc /private/recovery/closeword.sqlite
```

Backups use the SQLite online backup API and AES-256-GCM encryption. `BACKUP_KEY_FILE` must point to the raw 32-byte key created by `secrets:init`. Keep this key separately from the backup archives. Restore checks authentication and SQLite integrity, refuses to overwrite an existing file, and revokes sessions and pending OTPs. See [PRODUCTION.md](PRODUCTION.md) for switching to the recovered database and off-host backup requirements.

## Verification

```sh
npm test
npm run loadtest
npm run format:check
# After building closeword:local:
npm run test:container
npm run readiness
```

Tests cover authentication, OTP expiry/replay/attempt limits, history isolation, account-bound seats, all player limits, six independent SSE clients in both modes, race privacy, transaction rollback, migration, database fencing, encrypted recovery, HTTP validation and production configuration gates. The load test uses 20 rooms and 120 connected clients plus two password hashes, records latency/memory in `artifacts/loadtest.json`, and verifies every client receives the final result. These measurements describe that workload, not unlimited production capacity.

`readiness` fails until the production origin, email credentials, production mode and backup key are actually configured. Passing tests does not verify a live domain, TLS certificate, real email delivery, off-host backups, or external alerting.

GitHub CI runs the tests, load test, formatting, Compose validation, container build, and Caddy configuration validation. Actions are pinned to immutable commits. Dependabot configuration covers the runtime image, development package and Actions.

## Word engine and attribution

Includes **50,000 normalized 50-dimensional GloVe vectors** and **1,038 possible secret words** assembled for this game. Guesses are ranked by cosine similarity, with rank 1 as the answer. Unknown words receive a clear error. Rankings run locally on the server and differ from the original CloseWord's private model. Daily answers are selected with a private keyed hash and persisted for the day; practice/room words use cryptographic random selection.

The bundled model is the alphabetic subset of `glove-wiki-gigaword-50`, distributed by [Gensim-data](https://github.com/piskvorky/gensim-data#models), based on [Stanford GloVe](https://nlp.stanford.edu/projects/glove/). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). `data/manifest.json` records source and checksums; startup verifies the bundled artifacts. `scripts/prepare-vectors.py` rebuilds them from the source gzip archive.

## Scope

This is an independent CloseWord recreation with six-player support. It has its own puzzle schedule, scores, accounts, and rankings. It does not use the original site's account system or global leaderboard. Resource limits bound rooms, open streams, request bodies, guesses and creation rates. Read [SECURITY.md](SECURITY.md) for the threat model and operational boundaries.
