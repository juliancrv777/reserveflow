import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/rate-limit.js';
import { openDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { createApiKey, rotateApiKey, createEvent } from '../src/service.js';

test('fixed window provides rounded retry delay and resets at the exact boundary', () => {
  let now = 0;
  const consume = createRateLimiter({ limit: 1, windowMs: 1500, clock: () => now });
  assert.equal(consume('alice'), 0);
  assert.equal(consume('alice'), 2);
  now = 1000;
  assert.equal(consume('alice'), 1);
  now = 1500;
  assert.equal(consume('alice'), 0);
});

test('bounded buckets reject new identities without evicting existing quotas and reclaim expired entries', () => {
  let now = 0;
  const consume = createRateLimiter({ limit: 2, maxKeys: 1, windowMs: 1000, clock: () => now });
  assert.equal(consume('alice'), 0);
  for (let i = 0; i < 100; i++) assert.equal(consume(`other-${i}`), 1);
  assert.equal(consume('alice'), 0);
  assert.equal(consume('alice'), 1);
  now = 1000;
  assert.equal(consume('bob'), 0);
  for (const options of [{ limit: 0 }, { limit: NaN }, { windowMs: -1 }, { maxKeys: 1.5 }]) {
    assert.throws(() => createRateLimiter(options), /Invalid rate-limit/);
  }
});

async function fixture(t, options = {}) {
  let now = 0;
  const db = openDatabase();
  const alice = createApiKey(db, 'admin');
  const bob = createApiKey(db, 'customer');
  const logs = [];
  const app = createApp(db, { logger: (entry) => logs.push(entry), rateLimit: {
    limit: 2, failedAuthLimit: 1, windowMs: 1000, clock: () => now, ...options,
  } });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
    db.close();
  });
  const request = (token = alice.token, path = '/v1/events', options = {}) => fetch(
    `http://127.0.0.1:${app.address().port}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  return { db, alice, bob, logs, request, advance: (time) => { now = time; } };
}

test('concurrent HTTP quota is isolated by principal and survives credential rotation', async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.request()));
  assert.equal(responses.filter((response) => response.status === 200).length, 2);
  assert.equal(responses.filter((response) => response.status === 429).length, 3);
  const blocked = responses.find((response) => response.status === 429);
  assert.equal(blocked.headers.get('Retry-After'), '1');
  const body = await blocked.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.equal(body.error.request_id, blocked.headers.get('X-Request-Id'));
  assert.equal((await f.request(f.bob.token)).status, 200);
  const next = rotateApiKey(f.db, f.alice.credential_id);
  assert.equal((await f.request(next.token)).status, 429);
  f.advance(1000);
  assert.equal((await f.request(next.token)).status, 200);
  assert.equal(JSON.stringify(f.logs).includes(next.token), false);
});

test('failed authentication uses the socket IP, ignores forwarded spoofing and allows valid clients', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('invalid')).status, 401);
  assert.equal((await f.request('another-invalid', '/v1/events', { headers: { 'X-Forwarded-For': '203.0.113.5' } })).status, 429);
  assert.equal((await f.request()).status, 200);
  f.advance(1000);
  assert.equal((await f.request('invalid')).status, 401);
});

test('health and API contract remain public when a principal is limited', async (t) => {
  const f = await fixture(t, { limit: 1 });
  await f.request();
  assert.equal((await f.request()).status, 429);
  for (const path of ['/health', '/openapi.json']) assert.equal((await f.request('invalid', path)).status, 200);
});

test('limited reservations do not change inventory or consume idempotency keys', async (t) => {
  const f = await fixture(t, { limit: 1 });
  const event = createEvent(f.db, f.alice, { name: 'Limited workshop', capacity: 2 });
  await f.request();
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'limited-booking' },
    body: JSON.stringify({ event_id: event.id, quantity: 1 }) };
  assert.equal((await f.request(f.alice.token, '/v1/reservations', options)).status, 429);
  assert.equal(f.db.prepare('SELECT available FROM events').get().available, 2);
  assert.equal(f.db.prepare('SELECT count(*) AS total FROM idempotency').get().total, 0);
  f.advance(1000);
  const created = await f.request(f.alice.token, '/v1/reservations', options);
  assert.equal(created.status, 201);
  const reservation = await created.json();
  f.advance(2000);
  const replay = await f.request(f.alice.token, '/v1/reservations', options);
  assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
  assert.deepEqual(await replay.json(), reservation);
  assert.equal(f.db.prepare('SELECT available FROM events').get().available, 1);
});
