# ReserveFlow — project case study

## Problem

When several clients request the last available seat, a simple availability check can oversell an event. Lost responses and repeated cancellation requests can also duplicate reservations or return capacity more than once.

## Project implementation

The project implements a reservation API with a small Node.js HTTP boundary, domain services, SQLite persistence, API-key authentication, owner-scoped access, audit records, operator credential tools, backup/restore commands and automated tests.

## Decisions and evidence

| Decision | Reason | Where to review |
| --- | --- | --- |
| Conditional inventory update inside `BEGIN IMMEDIATE` | Only reserve when sufficient capacity remains | [Service](../src/service.js), [storage tests](../test/storage.test.js) |
| Store an operation result per principal and idempotency key | Safe retries return the original reservation; changed inputs produce a conflict | [Service](../src/service.js), [HTTP tests](../test/api.test.js) |
| Commit inventory, reservation and audit together | A failed audit write must roll back the reservation | [Storage tests](../test/storage.test.js) |
| Separate principals from credentials | Credential rotation preserves reservation ownership and retry scope | [Database](../src/database.js), [credential tests](../test/credentials.test.js) |
| Use SQLite and Node's standard library | Keep the example locally reproducible with no third-party runtime dependencies | [Architecture decisions](ARCHITECTURE.md) |

## Demonstration and validation

Run `npm run demo`: the script starts a real HTTP server and asserts the results of 20 requests for five seats, a retry and repeated cancellation. This is a correctness demonstration, not a throughput benchmark.

The test suite also exercises independent database connections, ownership isolation, persistence across restarts, injected failures and backup restoration. Review [tests](../test), [validation notes](VALIDATION.md) and [recovery procedures](RECOVERY.md).

## Scope and tradeoffs

The API uses operator-provisioned keys with admin/customer roles, not browser login. SQLite's synchronous driver and single-writer model suit a bounded single-host project; they do not establish horizontal scalability. PostgreSQL is a future option if measured contention or multiple hosts justify it. Payments, expiring holds and assigned seat maps are outside the current domain.

[API contract](openapi.json) · [Roadmap](ROADMAP.md) · [Back to README](../README.md)
