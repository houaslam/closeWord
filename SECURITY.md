# MVP security model

Players enter display names without creating accounts. Names can be reused and do not prove identity. Each seat uses a cryptographically random private token stored in that browser. Treat invite links as permission to join an open seat and seat tokens as secrets. Clearing browser storage loses the seat; there is no account recovery or personal history in this branch.

The server enforces capacity, host actions, turn order, winners, and room tokens. Race guesses and secret answers remain hidden until completion. JSON mutations require same-origin requests, with strict origin checks in production. React output escaping, per-request script nonces in Next.js pages, CSP, bounded inputs, body limits, rate limits and request timeouts reduce common abuse paths.

SQLite transactions, full synchronous commits, private file permissions and writer fencing protect persistence. Run exactly one active server per database. Backups are encrypted using AES-256-GCM and verified before restore. Protect host access, keep keys separate, and never serve data or private configuration as static assets.

Production requires HTTPS. Framework scripts receive a fresh CSP nonce for every HTML request. Development permits `unsafe-eval` for framework debugging; production does not. `TRUST_PROXY=true` requires a trusted ingress and a private backend port; otherwise attackers can spoof forwarding headers. The supplied Compose deployment exposes only Caddy. Logs exclude request bodies and query strings; metrics require an operator token.

Operators remain responsible for public TLS, infrastructure updates, monitoring, abuse response, disk capacity, off-host backups and restore drills. Automated checks do not replace independent security review. Report vulnerabilities privately to the deployment operator using disposable names and tokens.

Authentication and account history remain preserved on `feature/accounts-auth`, with a separate database from this MVP.
