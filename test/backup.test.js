import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database.js';
import { copyDatabaseSnapshot, verifyDatabase } from '../src/backup.js';
import { createApp } from '../src/app.js';
import { authenticate, createApiKey, rotateApiKey, revokeApiKey, createEvent, reserve, cancel } from '../src/service.js';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'reserveflow-backup-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('live WAL backup restores reservations, credential state, audit and retry results through HTTP', async (t) => {
  const root = directory(t);
  const source = join(root, 'source.db');
  const snapshot = join(root, 'backup.db');
  const restored = join(root, 'restored.db');
  const db = openDatabase(source);
  let owner, next, first, event, before;
  try {
    owner = createApiKey(db, 'admin');
    event = createEvent(db, owner, { name: 'Recovery workshop', capacity: 3 });
    first = reserve(db, owner, { event_id: event.id, quantity: 1 }, 'recovery-retry');
    const second = reserve(db, owner, { event_id: event.id, quantity: 1 }, 'cancelled-retry');
    cancel(db, owner, second.reservation.id);
    next = rotateApiKey(db, owner.credential_id);
    before = verifyDatabase(source);
    assert.ok(existsSync(source + '-wal'));
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE events SET name = ?').run('Uncommitted change');
    try { await copyDatabaseSnapshot(source, snapshot); } finally { db.exec('ROLLBACK'); }
    assert.deepEqual(verifyDatabase(snapshot), before);
    assert.equal(existsSync(snapshot + '-wal'), false);
    // Later revocation must not retroactively change the point-in-time backup.
    revokeApiKey(db, next.credential_id);
    assert.throws(() => authenticate(db, `Bearer ${next.token}`), { status: 401 });
  } finally { db.close(); }
  await copyDatabaseSnapshot(snapshot, restored);
  assert.deepEqual(verifyDatabase(restored), before);
  const recovered = openDatabase(restored);
  const app = createApp(recovered, { logger: () => {} });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    const headers = { Authorization: `Bearer ${next.token}` };
    const response = await fetch(`${base}/v1/reservations/${first.reservation.id}`, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).principal_id, owner.id);
    assert.equal((await fetch(`${base}/v1/events`, { headers: { Authorization: `Bearer ${owner.token}` } })).status, 401);
    const replay = await fetch(`${base}/v1/reservations`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': 'recovery-retry' },
      body: JSON.stringify({ event_id: event.id, quantity: 1 }),
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(await replay.json(), first.reservation);
    assert.equal(recovered.prepare('SELECT available FROM events').get().available, 2);
    assert.equal(recovered.prepare('SELECT name FROM events').get().name, 'Recovery workshop');
  } finally { await new Promise((resolve) => app.close(resolve)); recovered.close(); }
});

test('backup refuses existing destinations, sidecars and identical paths without changing files', async (t) => {
  const root = directory(t);
  const source = join(root, 'source.db');
  openDatabase(source).close();
  const original = readFileSync(source);
  await assert.rejects(copyDatabaseSnapshot(source, source), /must differ/);
  const target = join(root, 'target.db');
  writeFileSync(target, 'keep this file');
  await assert.rejects(copyDatabaseSnapshot(source, target), /already exists/);
  assert.equal(readFileSync(target, 'utf8'), 'keep this file');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const other = join(root, `other${suffix}.db`);
    writeFileSync(other + suffix, 'keep sidecar');
    await assert.rejects(copyDatabaseSnapshot(source, other), /already exists/);
    assert.equal(existsSync(other), false);
  }
  assert.deepEqual(readFileSync(source), original);
});

test('missing, corrupt, incompatible and inconsistent sources never publish a backup', async (t) => {
  const root = directory(t);
  const missing = join(root, 'missing.db');
  await assert.rejects(copyDatabaseSnapshot(missing, join(root, 'missing-copy.db')));
  assert.equal(existsSync(missing), false);
  const corrupt = join(root, 'corrupt.db');
  writeFileSync(corrupt, 'not sqlite');
  const legacy = join(root, 'legacy.db');
  const old = new DatabaseSync(legacy);
  old.exec('PRAGMA user_version = 1');
  old.close();
  const inconsistent = join(root, 'inconsistent.db');
  const db = openDatabase(inconsistent);
  createEvent(db, createApiKey(db, 'admin'), { name: 'Invalid inventory', capacity: 2 });
  db.exec('UPDATE events SET available = 1');
  db.close();
  for (const source of [corrupt, legacy, inconsistent]) {
    const target = source + '.copy';
    await assert.rejects(copyDatabaseSnapshot(source, target));
    assert.equal(existsSync(target), false);
  }
  assert.equal(readdirSync(root).some((name) => name.startsWith('.reserveflow-snapshot-')), false);
});

test('competing backups to one destination publish exactly one verified file', async (t) => {
  const root = directory(t);
  const source = join(root, 'source.db');
  const target = join(root, 'target.db');
  openDatabase(source).close();
  const results = await Promise.allSettled([copyDatabaseSnapshot(source, target), copyDatabaseSnapshot(source, target)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(verifyDatabase(target).integrity, 'ok');
  assert.equal(readdirSync(root).some((name) => name.startsWith('.reserveflow-snapshot-')), false);
});

test('operator CLI backs up, verifies and restores with explicit paths and failure exit codes', (t) => {
  const root = directory(t);
  const source = join(root, 'source.db');
  openDatabase(source).close();
  const snapshot = join(root, 'snapshot.db');
  const restored = join(root, 'restored.db');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, ['scripts/database-tool.js', ...args], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, DATABASE_PATH: source },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.equal(run('backup', snapshot).integrity, 'ok');
  assert.equal(run('verify', snapshot).schema_version, 2);
  assert.equal(run('restore', snapshot, restored).operation, 'restore');
  assert.throws(() => run('restore', snapshot, restored));
  assert.throws(() => run('backup'));
});
