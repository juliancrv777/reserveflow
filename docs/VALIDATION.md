# Validation record

Local validation on 2026-09-09, Windows, Node.js v24.20.0:

| Check | Result |
| --- | --- |
| `npm run check` | Passed syntax checks |
| `npm test` | 26 tests passed, 0 failed |
| `npm run demo` | Passed all assertions against a live local HTTP server |
| `npm run test:coverage` | Historical baseline only, before credential lifecycle changes |

The earlier 15-test baseline reported 97.60% line coverage across the loaded application modules, excluding `server.js` and operator scripts. That percentage is not a measurement of the current revision. Credential lifecycle validation adds six scenarios: HTTP rotation with preserved ownership and retries; isolated idempotent revocation; audit-failure rollback; migration from a version-1 fixture and restart; migration rollback on invalid references; and persistent operator CLI commands. Database lock-timeout HTTP behavior remains untested.

Concurrency evidence has two levels: 20 HTTP requests competing for 5 seats, and 6 worker threads with independent file-backed SQLite connections competing for 1 seat. These are bounded correctness tests, not a sustained load benchmark.

Docker is configured but was not built locally because Docker was unavailable in the validation environment. GitHub Actions is configured for Windows and Linux; a configuration file alone is not proof of a successful hosted run. Consult the repository Actions tab for hosted results.

Five backup/recovery scenarios cover a live WAL snapshot restored through HTTP, existing-file and sidecar protection, rejected missing/corrupt/incompatible/inconsistent sources, competing snapshot publication and operator CLI exit codes. The restore exercise verifies the stored credential state, reservation ownership, cancellation capacity, audit counts and idempotent responses. It also demonstrates that restoring an older backup can reactivate subsequently revoked credentials.

No live production deployment, security audit, production restore drill or availability assessment has been performed. The local automated recovery exercise is not a production recovery-time or data-loss guarantee.
