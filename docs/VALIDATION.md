# Validation record

Local validation on 2026-09-09, Windows, Node.js v24.20.0:

| Check | Result |
| --- | --- |
| `npm run check` | Passed syntax checks |
| `npm test` | 15 tests passed, 0 failed |
| `npm run demo` | Passed all assertions against a live local HTTP server |
| `npm run test:coverage` | 15 tests passed |

The coverage run reported 97.60% line coverage across the loaded application modules (`app.js`, `database.js`, `errors.js`, `service.js`). It does **not** include `server.js` or the operator scripts and is not whole-project coverage. Uncovered behavior includes the database lock-timeout HTTP response and migration failure cleanup.

Concurrency evidence has two levels: 20 HTTP requests competing for 5 seats, and 6 worker threads with independent file-backed SQLite connections competing for 1 seat. These are bounded correctness tests, not a sustained load benchmark.

Docker is configured but was not built locally because Docker was unavailable in the validation environment. GitHub Actions is configured for Windows and Linux; a configuration file alone is not proof of a successful hosted run. Consult the repository Actions tab for hosted results.

No live production deployment, security audit, restore drill or availability assessment has been performed.
