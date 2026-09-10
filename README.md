# ReserveFlow

**A reservation API built around one promise: a seat can only be sold once.**

ReserveFlow models limited-capacity workshop bookings. It handles competing requests, safe retries, ownership checks and cancellation using database transactions. The focus is backend correctness and reproducible engineering decisions.

**Node.js 24 · JavaScript ESM · SQLite · REST · OpenAPI 3.1 · Docker · GitHub Actions**

[Architecture & tradeoffs](docs/ARCHITECTURE.md) · [API contract](docs/openapi.json) · [Backup & recovery](docs/RECOVERY.md) · [Validation](docs/VALIDATION.md)

## Try it in a minute

Install Node.js **24.15 or newer in the 24.x series**. No package installation, external database or account is needed for the demo.

```sh
git clone https://github.com/juliancrv777/reserveflow.git
cd reserveflow
npm run demo
npm test
```

The demo starts a real HTTP server on a temporary port, uses an isolated in-memory database and checks every outcome with assertions:

```text
1. Created a workshop with 5 seats.
2. 20 concurrent requests: 5 confirmed, 15 rejected. No overselling.
3. Retried a successful request: same reservation, no additional seat consumed.
4. Cancelled twice: exactly 1 seat returned.
5. Audit trail: 1 event creation, 5 confirmations, 1 cancellation.

PASS — every result above is asserted against the running API.
```

This is a functional demonstration, not a throughput benchmark or evidence of production traffic.

## What the implementation demonstrates

| Problem | Implementation | Evidence |
| --- | --- | --- |
| Two clients compete for the final seat | Conditional inventory update inside `BEGIN IMMEDIATE` | Six worker threads with independent connections compete for one seat |
| A client retries after a lost response | Per-principal idempotency key and canonical payload fingerprint | Repeated requests return one reservation; changed payload returns 409 |
| The client cancels twice | Transactional status transition and capacity restoration | Ten concurrent cancellations restore capacity once |
| Another client guesses a reservation ID | Ownership enforced in database queries | Read, cancel and list isolation tests |
| Audit insertion fails after inventory changes | Reservation, inventory, idempotency and audit share a transaction | Injected failure proves full rollback |
| The process restarts | File-backed SQLite and versioned schema migration | Close/reopen test verifies data, authentication and retries |
| A database must be recovered | Verified SQLite snapshot and restore to a new file | Live WAL backup restores ownership, credential state and retry responses over HTTP |

## Run the persistent API

From the project directory:

```sh
npm run key -- admin
npm run key -- customer
npm start
```

Each `key` command creates a principal and prints its ID, credential ID and random token. Keep the tokens locally: the database stores only SHA-256 hashes. This is operator-provisioned API-key authentication, not a browser login system.

### Rotate or revoke access

Run these operator commands against the same `DATABASE_PATH` as the server:

```sh
npm run keys -- list
npm run keys -- rotate REPLACE_WITH_CREDENTIAL_ID
npm run keys -- revoke REPLACE_WITH_CREDENTIAL_ID
```

The list contains IDs, roles and timestamps, never tokens or hashes. Rotation atomically revokes the selected active credential and prints a replacement token once. The principal ID, reservations and idempotency records stay the same. Use the **new credential ID** for later operations. Revocation is repeatable and blocks subsequent authentication; it does not cancel reservations. Requests already authenticated may finish. A revoked credential cannot be rotated or reactivated.

These commands require trusted filesystem access to the database; they are not public HTTP endpoints. Rotation has no overlap period: update clients with the new token after rotating. If the new token is lost, an operator can list its credential ID and rotate it again. Expiry and recovery for a principal with only revoked credentials are not implemented.

Existing version-1 databases migrate automatically on startup, preserving tokens and ownership. Stop the old application and take a verified database backup before upgrading; do not run the old version against the migrated database. For imported credentials, `created_at` records migration time because the old schema had no creation timestamp.

The API defaults to `http://127.0.0.1:3000`; data is persisted in `data/reserveflow.db`. The health endpoint is `/health` and the API specification is `/openapi.json`.

### Example with PowerShell

Replace the two token placeholders with the output of the key commands. Run in a second terminal while the server is running.

```powershell
$adminHeaders = @{ Authorization = 'Bearer REPLACE_WITH_ADMIN_TOKEN' }
$customerHeaders = @{
  Authorization = 'Bearer REPLACE_WITH_CUSTOMER_TOKEN'
  'Idempotency-Key' = 'workshop-booking-001'
}
$event = Invoke-RestMethod http://127.0.0.1:3000/v1/events `
  -Method Post -Headers $adminHeaders -ContentType 'application/json' `
  -Body (@{ name = 'Backend Workshop'; capacity = 5 } | ConvertTo-Json)
$booking = Invoke-RestMethod http://127.0.0.1:3000/v1/reservations `
  -Method Post -Headers $customerHeaders -ContentType 'application/json' `
  -Body (@{ event_id = $event.id; quantity = 1 } | ConvertTo-Json)
$booking
Invoke-RestMethod "http://127.0.0.1:3000/v1/reservations/$($booking.id)/cancel" `
  -Method Post -Headers $customerHeaders
```

For Bash, use `curl` with the same headers and JSON bodies, or import `docs/openapi.json` into an API client. Requests creating events or reservations require `Content-Type: application/json`.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `DATABASE_PATH` | `./data/reserveflow.db` | Persistent database path |
| `RATE_LIMIT_REQUESTS` | `120` | Requests per principal per window (1-1,000,000) |
| `RATE_LIMIT_FAILED_AUTH` | `20` | Failed authentications per socket IP per window (1-1,000,000) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window duration (1-3,600,000 milliseconds) |
| `RATE_LIMIT_MAX_KEYS` | `10000` | Maximum identities in each limiter (1-100,000) |

Environment variables are read from the process. `.env` is **not loaded automatically**. To use a local file, copy `.env.example` to `.env` and run `node --env-file=.env src/server.js`. Use the same database path for key provisioning and the server. Run commands from the repository root.

## API overview

All `/v1` endpoints require `Authorization: Bearer <token>`.

| Method | Path | Access |
| --- | --- | --- |
| GET | `/health` | Public database probe |
| GET | `/openapi.json` | Public API contract |
| POST | `/v1/events` | Admin |
| GET | `/v1/events` | Authenticated |
| POST | `/v1/reservations` | Authenticated; `Idempotency-Key` required |
| GET | `/v1/reservations` | Own reservations |
| GET | `/v1/reservations/{id}` | Owner |
| POST | `/v1/reservations/{id}/cancel` | Owner |
| GET | `/v1/audit` | Admin |

List endpoints support `limit` (1–100, default 20) and `offset` (0–1,000,000, default 0). They return `{ data, limit, offset }` in a deterministic order. Offset pagination is not a snapshot under concurrent inserts.

A successful reservation returns `201`, a `Location` header and `Idempotency-Replayed: false`. Retrying the same key and payload returns the **original** `201` body and `Idempotency-Replayed: true`, including after cancellation. Use the reservation GET endpoint for its current state. Failed attempts are not cached. Keys are scoped to a principal and currently retained indefinitely. Event creation itself is not idempotent.

Errors use `{ error: { code, message, request_id } }`. Examples include `SOLD_OUT` and `IDEMPOTENCY_CONFLICT` (409), `UNAUTHORIZED` (401) and `VALIDATION_ERROR` (400). Lock contention that exceeds the database wait returns 503 with `Retry-After: 1`.

### Request limits

Authenticated requests share a fixed-window quota per principal across routes and credential rotations. Failed authentication has a separate quota per socket IP; valid credentials can still authenticate from that IP. Defaults are 120 authenticated requests and 20 failed authentications per 60-second window. Each identity's window starts on its first counted request. The next request beyond its quota returns **429 RATE_LIMITED**, with an integer **Retry-After** delay in seconds. Rejected requests do not extend the window.

Wait for that delay before retrying. For a reservation retry, retain the original Idempotency-Key and payload. Admitted errors and idempotent replays consume quota; rate-limited requests do not mutate reservation data. Health and OpenAPI endpoints are exempt.

Counters use bounded process memory and reset on restart. At the identity cap, new identities receive 429 until an entry expires; existing identities keep their quotas. Fixed windows permit bursts around a boundary. Multiple instances do not share counters. Forwarded IP headers are ignored: behind a proxy, failed authentications share the proxy socket-IP bucket. Authentication runs before the failed-attempt limiter, so authentication database lookups still occur. Public deployments need gateway/network limits for denial-of-service protection.

## Architecture

```mermaid
flowchart LR
    Client[API client] --> HTTP[HTTP boundary\nvalidation and authentication]
    HTTP --> Domain[Reservation service\nownership and state transitions]
    Domain --> TX[Atomic transaction]
    TX --> Inventory[(Events and availability)]
    TX --> Bookings[(Reservations)]
    TX --> Retry[(Idempotency records)]
    TX --> Audit[(Audit log)]
```

`src/app.js` handles HTTP, `src/service.js` owns business rules and `src/database.js` manages schema and transactions. See the [decision record](docs/ARCHITECTURE.md) for why this version uses SQLite and a small standard-library HTTP boundary.

## Quality checks

```sh
npm run check
npm test
npm run test:coverage
```

The test suite covers HTTP behavior, independent database connections, persistence and injected failures. GitHub Actions is configured to run syntax checks, tests and the demo on Windows and Linux. Local results and any unverified environments are recorded in [validation notes](docs/VALIDATION.md).

## Backup and recovery

After creating the persistent database, create a destination directory and use unique filenames:

```sh
mkdir backups
npm run backup -- backups/reserveflow-001.db
npm run verify -- backups/reserveflow-001.db
npm run restore -- backups/reserveflow-001.db data/restored-001.db
```

Backup reads `DATABASE_PATH` (the same default as the server) and can run while the API is active. Restore creates a **new** database; it never replaces an existing file or switches the running server. Checks cover SQLite integrity, references, expected columns and reservation capacity. See the [recovery procedure](docs/RECOVERY.md) before switching databases, especially the effect on revoked credentials.

## Docker

```sh
docker compose up --build -d
docker compose exec api npm run key -- admin
docker compose exec api npm run key -- customer
docker compose logs -f api
```

The container runs as a non-root user, has a health check and stores data in a named volume. Compose binds the published port to localhost. `docker compose down` keeps the volume; adding `-v` removes its data.

## Scope and next steps

This is a portfolio backend with a deliberately bounded domain: capacity-based events, not assigned seat maps, payments or expiring holds. The synchronous SQLite connection serializes writes and can block the event loop under contention. It is intended for a single host and local durable storage, not a shared network filesystem or horizontally distributed deployment.

Before public production exposure, add HTTPS termination, gateway rate limits, credential expiry and recovery, operational monitoring, off-host encrypted backup storage with a retention policy, and an idempotency retention policy. Local automated restore tests are implemented; no production disaster-recovery target has been established. Audit records are transactional but are not tamper-proof against database operators. No throughput or availability target has been established.

Planned increments are tracked in [ROADMAP.md](docs/ROADMAP.md), including PostgreSQL under measured contention and a transactional outbox for notifications.
