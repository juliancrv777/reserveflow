# Browser reservation console

The web console is a **zero-dependency** frontend served by the same Node HTTP process and origin as the existing API. It demonstrates a working full-stack slice without weakening the reservation transaction model.

## Start

Use Node.js 24.15+:

```sh
npm run key -- admin
npm run key -- customer
npm start
```

Open http://127.0.0.1:3000. Paste the printed token into the console. The backend remains authoritative: a customer can reserve, list and cancel only their own bookings; an admin can create events and read the audit trail. Both can see events. Test with two separate keys.

The console deliberately does **not** create credentials. Provision, rotate and revoke them with the existing trusted operator CLI. There are no hardcoded demo secrets.

## End-to-end flows

1. Connect an admin API key, create a workshop, and inspect its availability and audit events.
2. Disconnect. Connect a customer key, choose the event and reserve seats.
3. Refresh the list and cancel the reservation; the capacity is restored.
4. Make the same booking request after a network interruption: the console retains the idempotency key for the same event and quantity until successful confirmation.

## Security boundaries

- Keys exist in browser JavaScript memory only, not localStorage, sessionStorage, cookies, URL parameters or server-rendered HTML.
- Disconnecting or refreshing the page forgets the key; request logs do not include bearer tokens.
- HTML, CSS and JS are served by a small exact-path allowlist; no arbitrary file paths are accepted.
- Content Security Policy forbids remote scripts, frames, inline scripts and cross-origin connections.
- Remote event names and reservation attributes are rendered with `textContent`, not interpreted as HTML.
- Authorization and idempotency remain fully server-side, enforced by the existing API and database.
- This console is intended for a trusted local environment and a portfolio demo. Public internet deployment of shared operator API keys requires a stronger browser authentication architecture (short-lived sessions, CSRF protections and TLS).

## Validation

```sh
npm run check
npm test
npm run demo
```

`test/console.test.js` checks asset delivery, security headers, no-store caching and protection of business endpoints. All existing concurrency, tenant ownership, retry and transactional tests remain in the CI matrix on Linux and Windows.
