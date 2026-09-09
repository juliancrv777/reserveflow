import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { createApiKey } from '../src/service.js';

async function fixture(t) {
  const db = openDatabase();
  const logs = [];
  const server = createApp(db, { logger: (entry) => logs.push(entry) });
  const admin = createApiKey(db, 'admin');
  const alice = createApiKey(db, 'customer');
  const bob = createApiKey(db, 'customer');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    db.close();
  });
  async function request(path, { method = 'GET', token = alice.token, body, key, raw, contentType = 'application/json' } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = contentType;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const event = async (capacity = 3) => (await request('/v1/events', {
    method: 'POST', token: admin.token, body: { name: 'Engineering Workshop', capacity },
  })).body;
  const reserve = (eventId, key = 'booking-0001', quantity = 1, token = alice.token) => request('/v1/reservations', {
    method: 'POST', token, body: { event_id: eventId, quantity }, key,
  });
  return { db, logs, admin, alice, bob, request, event, reserve };
}

test('health and OpenAPI are public; business endpoints require a valid key', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/health', { token: null })).status, 200);
  assert.equal((await f.request('/openapi.json', { token: null })).body.openapi, '3.1.0');
  assert.equal((await f.request('/v1/events', { token: null })).status, 401);
  assert.equal((await f.request('/v1/events', { token: 'rf_' + 'x'.repeat(43) })).status, 401);
});

test('only admins create events and access audit records', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/events', { method: 'POST', body: { name: 'Workshop', capacity: 5 } })).status, 403);
  assert.equal((await f.request('/v1/audit')).status, 403);
  await f.event();
  const audit = await f.request('/v1/audit', { token: f.admin.token });
  assert.equal(audit.body.data[0].action, 'event.created');
});

test('concurrent HTTP requests cannot oversell capacity', async (t) => {
  const f = await fixture(t);
  const event = await f.event(5);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.reserve(event.id, `attempt-${i}`)));
  assert.equal(results.filter((r) => r.status === 201).length, 5);
  assert.equal(results.filter((r) => r.status === 409 && r.body.error.code === 'SOLD_OUT').length, 15);
  assert.equal((await f.request('/v1/events')).body.data[0].available, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 5);
});

test('concurrent retries create one reservation and one audit record', async (t) => {
  const f = await fixture(t);
  const event = await f.event(3);
  const results = await Promise.all(Array.from({ length: 10 }, () => f.reserve(event.id)));
  assert.ok(results.every((r) => r.status === 201));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.equal(results.filter((r) => r.headers.get('idempotency-replayed') === 'false').length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='reservation.confirmed'").get().n, 1);
  assert.equal((await f.request('/v1/events')).body.data[0].available, 2);
});

test('idempotency rejects changed payload and is scoped to each principal', async (t) => {
  const f = await fixture(t);
  const event = await f.event(5);
  await f.reserve(event.id);
  const conflict = await f.reserve(event.id, 'booking-0001', 2);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.reserve(event.id, 'booking-0001', 1, f.bob.token)).status, 201);
});

test('cancellation restores capacity exactly once; original retry response remains stable', async (t) => {
  const f = await fixture(t);
  const event = await f.event(3);
  const created = await f.reserve(event.id, 'booking-0001', 2);
  const path = `/v1/reservations/${created.body.id}`;
  const results = await Promise.all(Array.from({ length: 10 }, () => f.request(`${path}/cancel`, { method: 'POST' })));
  assert.ok(results.every((r) => r.status === 200 && r.body.status === 'cancelled'));
  assert.equal((await f.request('/v1/events')).body.data[0].available, 3);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='reservation.cancelled'").get().n, 1);
  assert.deepEqual((await f.reserve(event.id, 'booking-0001', 2)).body, created.body);
  assert.equal((await f.request(path)).body.status, 'cancelled');
});

test('another principal cannot read, cancel or list a reservation', async (t) => {
  const f = await fixture(t);
  const created = await f.reserve((await f.event()).id);
  const path = `/v1/reservations/${created.body.id}`;
  assert.equal((await f.request(path, { token: f.bob.token })).status, 404);
  assert.equal((await f.request(`${path}/cancel`, { method: 'POST', token: f.bob.token })).status, 404);
  assert.equal((await f.request('/v1/reservations', { token: f.bob.token })).body.data.length, 0);
});

test('validation handles malformed JSON, unsupported content and invalid values', async (t) => {
  const f = await fixture(t);
  const event = await f.event();
  for (const quantity of [0, -1, 1.5, '1', 101, null]) {
    assert.equal((await f.reserve(event.id, 'booking-0001', quantity)).status, 400);
  }
  assert.equal((await f.reserve(event.id, 'short')).status, 400);
  assert.equal((await f.request('/v1/reservations', { method: 'POST', raw: '{' })).body.error.code, 'INVALID_JSON');
  assert.equal((await f.request('/v1/reservations', { method: 'POST', raw: '[]' })).status, 400);
  assert.equal((await f.request('/v1/reservations', { method: 'POST', raw: '{}', contentType: 'text/plain' })).status, 415);
  for (const capacity of [0, 1000001, '5', 1.2]) {
    assert.equal((await f.request('/v1/events', { method: 'POST', token: f.admin.token, body: { name: 'Valid name', capacity } })).status, 400);
  }
  assert.equal((await f.request('/v1/events', { method: 'POST', token: f.admin.token, body: { name: ' ', capacity: 1 } })).status, 400);
});

test('body limit returns 413', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/reservations', { method: 'POST', body: { padding: 'x'.repeat(17000) } })).status, 413);
});

test('pagination is bounded, deterministic and rejects invalid offsets', async (t) => {
  const f = await fixture(t);
  await f.event();
  await f.event();
  const all = (await f.request('/v1/events')).body.data;
  assert.deepEqual((await f.request('/v1/events?limit=1&offset=1')).body.data, [all[1]]);
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=no', 'offset=1000001']) {
    assert.equal((await f.request(`/v1/events?${query}`)).status, 400);
  }
});

test('missing resources and unsuccessful reservations leave no state changes', async (t) => {
  const f = await fixture(t);
  const missing = await f.reserve('missing-event');
  assert.equal(missing.status, 404);
  const event = await f.event(1);
  assert.equal((await f.reserve(event.id, 'booking-0001', 2)).status, 409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get().n, 0);
  assert.equal((await f.reserve(event.id, 'booking-0001', 1)).status, 201);
  assert.equal((await f.request('/unknown')).status, 404);
});

test('a failure after inventory update rolls back reservation, capacity and idempotency', async (t) => {
  const f = await fixture(t);
  const event = await f.event(1);
  f.db.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log
    WHEN NEW.action = 'reservation.confirmed' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
  const result = await f.reserve(event.id);
  assert.equal(result.status, 500);
  assert.equal(result.body.error.message, 'Unexpected server error');
  assert.equal(f.db.prepare('SELECT available FROM events').get().available, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get().n, 0);
});

test('tokens are hashed at rest and absent from request logs', async (t) => {
  const f = await fixture(t);
  const result = await f.request('/v1/events');
  assert.match(result.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.ok(f.db.prepare('SELECT token_hash FROM principals').all().every((r) => /^[a-f0-9]{64}$/.test(r.token_hash)));
  assert.ok(!JSON.stringify(f.logs).includes(f.alice.token));
});
