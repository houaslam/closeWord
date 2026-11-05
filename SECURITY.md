# Security model

This app is intended for a single first-party HTTPS origin and one active game-server instance. Visitors may play as guests; only email-verified accounts have private cross-device history. It does not provide administrator roles, social login, payment handling, or multi-factor login.

## Implemented controls

- Email OTP proof before account creation; hashed expiring codes, attempt/resend limits, generation invalidation, and generic signup responses before proof.
- Per-password salts and scrypt with N=131072, r=8, p=1, plus a two-job hashing limit to bound native-memory use.
- Random session tokens stored as hashes. Production cookies use Secure, HttpOnly, SameSite=Lax, Path=/ and the `__Host-` prefix. Sessions expire after 30 days or seven idle days. Password changes/reset revoke other/all sessions.
- Same-origin JSON mutations, no cross-origin credential sharing, CSP, frame restrictions, HSTS in production, output escaping and bounded input/body sizes.
- Account ownership checks for history, solo progress and room seats. Server-authoritative winners, turn order, capacity and results. Race guesses remain private until completion.
- SQLite uniqueness constraints, WAL, full synchronous commits, atomic result/history updates, migrations and writer fencing. Backups use AES-256-GCM and restore verifies integrity and revokes old sessions.
- Bounded room creation, authentication attempts, email requests, live streams, guesses, request timeouts, ranking cache and hashing concurrency.
- Secrets stay outside browser assets and source control. Operational request logs exclude query strings, credentials and email bodies. Test email capture is refused outside `NODE_ENV=test`.

## Operational boundaries

The database contains private emails, password hashes and authentication state. Filesystem permissions and encrypted backups do not replace host security or encrypted host storage. Restrict host access and retain keys separately. Do not serve the data or secrets directories with any web server.

`TRUST_PROXY=true` is safe only when direct app access is blocked and the trusted ingress appends the real client address. The supplied Compose deployment exposes only Caddy. Deploying the backend port publicly with trusted forwarding enables rate-limit spoofing.

The game process caches active rooms and authentication state. One active instance is supported. A database lease fences writes after takeover, but it does not turn this architecture into a distributed multiplayer service. Resource limits and measured workload are documented in PRODUCTION.md.

Abuse prevention, email domain reputation, monitoring alerts, off-host backups and infrastructure patching still require operator configuration. This implementation has automated security regression tests and an internal review; it has not undergone an independent penetration test. No implementation can guarantee the absence of vulnerabilities.

## Reporting

For a private deployment, report issues directly to its operator. Do not post real credentials, account data, database files or exploit tokens in public issues. Include a minimal reproduction using disposable accounts when possible.
