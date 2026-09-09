import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { createApiKey } from '../src/service.js';
import { createApp } from '../src/app.js';

const db = openDatabase();
const admin = createApiKey(db, 'admin');
const customer = createApiKey(db, 'customer');
const server = createApp(db, { logger: () => {} });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(path, token, method = 'GET', body, key) {
  const response = await fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), replayed: response.headers.get('idempotency-replayed') };
}
try {
  const event = await request('/v1/events', admin.token, 'POST', { name: 'Software Engineering Workshop', capacity: 5 });
  assert.equal(event.status, 201);
  console.log('ReserveFlow | live HTTP demonstration\n');
  console.log('1. Created a workshop with 5 seats.');
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => request('/v1/reservations', customer.token, 'POST', {
    event_id: event.body.id, quantity: 1,
  }, `demo-attempt-${i}`)));
  const confirmed = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 409);
  assert.equal(confirmed.length, 5);
  assert.equal(rejected.length, 15);
  console.log(`2. 20 concurrent requests: ${confirmed.length} confirmed, ${rejected.length} rejected. No overselling.`);
  const index = results.findIndex((r) => r.status === 201);
  const repeated = await request('/v1/reservations', customer.token, 'POST', { event_id: event.body.id, quantity: 1 }, `demo-attempt-${index}`);
  assert.equal(repeated.body.id, results[index].body.id);
  assert.equal(repeated.replayed, 'true');
  console.log('3. Retried a successful request: same reservation, no additional seat consumed.');
  for (let i = 0; i < 2; i++) {
    assert.equal((await request(`/v1/reservations/${repeated.body.id}/cancel`, customer.token, 'POST')).status, 200);
  }
  const events = await request('/v1/events', customer.token);
  assert.equal(events.body.data[0].available, 1);
  console.log('4. Cancelled twice: exactly 1 seat returned.');
  const audit = await request('/v1/audit', admin.token);
  assert.equal(audit.body.data.length, 7);
  console.log('5. Audit trail: 1 event creation, 5 confirmations, 1 cancellation.');
  console.log('\nPASS — every result above is asserted against the running API.');
} finally {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  db.close();
}
