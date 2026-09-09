# Roadmap

The completed increment is listed first; the remaining sections describe future work.

## Credential lifecycle — rotation and revocation completed

- Stable principals and separate credentials preserve reservation ownership and retry records.
- Operator CLI supports metadata listing, atomic rotation and idempotent revocation.
- Verified: old tokens fail subsequent authentication; rotated tokens read existing reservations; audit failure rolls back the change; version-1 data migrates successfully.
- Remaining: credential expiry, recovery after complete revocation and optional overlap windows.

## Operational baseline

- Add rate limiting, HTTPS deployment instructions and metrics for lock waits and latency.
- Completed: SQLite backup API, read-only verification and restore into a new file; automated live WAL recovery checks reservations, credentials and retry results over HTTP.
- Remaining: scheduled encrypted off-host backups, retention policy and measured recovery targets.
- Define idempotency retention and document the effect of expired keys.
- Local restore acceptance is covered by tests; production recovery targets remain undefined.

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
