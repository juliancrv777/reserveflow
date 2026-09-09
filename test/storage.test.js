import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { openDatabase } from '../src/database.js';
import { createApiKey, createEvent, reserve, authenticate } from '../src/service.js';

test('independent database connections race for the final seat without overselling', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reserveflow-race-'));
  const path = join(directory, 'test.db');
  const db = openDatabase(path);
  const workers = [];
  try {
    const principal = createApiKey(db, 'admin');
    const event = createEvent(db, principal, { name: 'Final seat', capacity: 1 });
    for (let i = 0; i < 6; i++) workers.push(new Worker(new URL('./concurrency-worker.js', import.meta.url), {
      workerData: { path, principal: { id: principal.id, role: principal.role }, eventId: event.id, key: `worker-${i}-key` },
    }));
    await Promise.all(workers.map((worker) => once(worker, 'message')));
    const pending = workers.map((worker) => once(worker, 'message'));
    workers.forEach((worker) => worker.postMessage('go'));
    const results = (await Promise.all(pending)).map(([message]) => message);
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.code === 'SOLD_OUT').length, 5);
    assert.equal(db.prepare('SELECT available FROM events').get().available, 0);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('data, authentication and replay survive closing and reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reserveflow-persist-'));
  const path = join(directory, 'test.db');
  let db = openDatabase(path);
  try {
    const principal = createApiKey(db, 'admin');
    const event = createEvent(db, principal, { name: 'Persistent workshop', capacity: 2 });
    const first = reserve(db, principal, { event_id: event.id, quantity: 1 }, 'persistent-key');
    db.close();
    db = openDatabase(path);
    const authenticated = authenticate(db, `Bearer ${principal.token}`);
    const replay = reserve(db, authenticated, { event_id: event.id, quantity: 1 }, 'persistent-key');
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.reservation, first.reservation);
    assert.equal(db.prepare('SELECT available FROM events').get().available, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
