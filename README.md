# ReserveFlow

**A reservation API built around one promise: a seat can only be sold once.**

ReserveFlow models limited-capacity workshop bookings. It handles competing requests, safe retries, ownership checks and cancellation using database transactions. The focus is backend correctness and reproducible engineering decisions.

**Node.js 24 · JavaScript ESM · SQLite · REST · OpenAPI 3.1 · Docker · GitHub Actions**

[Architecture & tradeoffs](docs/ARCHITECTURE.md) · [API contract](docs/openapi.json) · [Validation](docs/VALIDATION.md)

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

## Run the persistent API

From the project directory:

```sh
npm run key -- admin
npm run key -- customer
npm start
```

Each key command prints a new principal ID and random token. Keep the tokens locally: the database stores only SHA-256 hashes. This is operator-provisioned API-key authentication, not a browser login system. Each key represents a separate principal.

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

Before public production exposure, add HTTPS termination, request rate limits, key revocation and rotation, operational monitoring, tested backups and an idempotency retention policy. Audit records are transactional but are not tamper-proof against database operators. No throughput or availability target has been established.

Planned increments are tracked in [ROADMAP.md](docs/ROADMAP.md), including PostgreSQL under measured contention and a transactional outbox for notifications.
