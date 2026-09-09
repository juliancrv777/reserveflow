# Roadmap

These are future increments, not implemented capabilities.

## Credential lifecycle

- Separate principals from credentials so rotation preserves reservation ownership.
- Add operator-managed revocation and expiry.
- Acceptance: revoked tokens fail immediately; old reservations remain readable with a rotated token.

## Operational baseline

- Add rate limiting, HTTPS deployment instructions and metrics for lock waits and latency.
- Define backups using SQLite's backup API, then demonstrate a restore.
- Define idempotency retention and document the effect of expired keys.
- Acceptance: an automated restore exercise recovers reservations and retry results.

## PostgreSQL persistence

- Measure the SQLite baseline before selecting a new database.
- Add versioned migrations and integration tests against PostgreSQL.
- Preserve conditional inventory updates and uniqueness on principal/key.
- Acceptance: independent processes competing for one seat confirm exactly one reservation.

## Reliable notifications

- Add an outbox record in the reservation transaction and a separate worker.
- Make notification delivery idempotent and introduce bounded retries.
- Acceptance: worker interruption and restart do not lose committed notifications.

## Product interface

- Add an accessible reservation interface after establishing end-user authentication.
- Show loading, sold-out, retry and cancellation states.
- Acceptance: browser tests verify the complete booking and cancellation journey.
