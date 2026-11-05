# CloseWord MVP

Name-only word games for **2–6 remote players**, with turn-by-turn and speed-race modes. Enter a nickname, choose the room size, and invite friends using a link or room code. The host starts with at least two players. The first player to find the secret word wins; everyone sees the result and can play a rematch.

## Run locally

Use Node.js **24.22.2 or newer in the 24.x LTS line** (`nvm use`).

```sh
npm ci
npm start
```

Open [the multiplayer lobby](http://localhost:3000/multiplayer). No accounts, email provider, or `.env` file are needed for local play. The server binds to this machine by default. A localhost invite cannot reach another device; use a public HTTPS deployment for remote friends, as described in [PRODUCTION.md](PRODUCTION.md).

Each browser keeps its nickname and private room-seat token locally. Returning to the same invite in that browser reconnects to the seat. Names are display names and are not verified identities. Lost browser storage cannot be recovered through an account.

## Branches and saved data

- `main`: this name-only MVP.
- `feature/accounts-auth`: the preserved email verification, login, account settings, password recovery, and personal game-history implementation (baseline commit `a1f60f9`).

The MVP defaults to `data/mvp.sqlite`; the account version used `data/closeword.sqlite`. Existing account databases and private credentials have been left intact. `.env` and databases are intentionally excluded from Git. When switching back to the account branch, configure `DATABASE_PATH=data/closeword.sqlite` and its email settings separately. Do not run both versions against the same database.

## Gameplay and persistence

The host chooses a capacity from two to six, enforced by the server. Matchmaking groups waiting rooms by mode and capacity. Turn-by-turn shares guesses and rotates turns, skipping disconnected players. Speed race keeps each player's guesses private until completion, while showing best ranks and guess counts. Both support reconnects, host transfer, server-authoritative winners, round scores, and rematches. Daily puzzles, practice, and custom challenges are also available.

Rooms, guesses, solo progress and nickname leaderboard entries persist in SQLite with WAL, full synchronous commits and transactional updates. Run **one active server** per database. Writer leases fence stale processes after takeover; an abrupt crash can require up to 30 seconds before restart. Inactive games expire after seven days. This MVP has no personal account history.

## Verification

```sh
npm test
npm run loadtest
npm run format:check
```

Tests cover six independent connections, both game modes, capacity limits, race privacy, winner announcement, rematches, reconnects, HTTP validation, origin protection, database fencing, crash recovery, and encrypted backups. The load test uses 20 rooms and 120 connected clients and verifies that every client receives the final result. CI also validates deployment configuration and the container.

## Words

Includes **50,000 normalized 50-dimensional GloVe vectors** and **1,038 possible secret words**. Rank 1 is the answer; other guesses are ordered by cosine similarity. Rankings run locally and differ from the original site's private model. Daily answers use a private keyed hash and are persisted for the day; practice and multiplayer targets use cryptographic random selection.

The bundled alphabetic subset of `glove-wiki-gigaword-50` comes from [Gensim-data](https://github.com/piskvorky/gensim-data#models), based on [Stanford GloVe](https://nlp.stanford.edu/projects/glove/). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Artifact checksums are checked at startup. This is an independent recreation with its own puzzle schedule and leaderboard.
