import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { openDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { createApiKey, rotateApiKey, revokeApiKey, listApiKeys, authenticate, createEvent, reserve, getReservation } from '../src/service.js';

test('rotation rejects the old token over HTTP and preserves ownership and retry identity', async () => {
  const db = openDatabase();
  const owner = createApiKey(db, 'admin');
  const event = createEvent(db, owner, { name: 'Rotation workshop', capacity: 2 });
  const input = { event_id: event.id, quantity: 1 };
  const first = reserve(db, owner, input, 'rotation-retry');
  const app = createApp(db, { logger: () => {} });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    const rotated = rotateApiKey(db, owner.credential_id);
    assert.equal(rotated.id, owner.id);
    assert.notEqual(rotated.token, owner.token);
    const url = `http://127.0.0.1:${app.address().port}/v1/reservations/${first.reservation.id}`;
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${owner.token}` } })).status, 401);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${rotated.token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, first.reservation.id);
    assert.equal(reserve(db, authenticate(db, `Bearer ${rotated.token}`), input, 'rotation-retry').replayed, true);
    assert.equal(db.prepare('SELECT available FROM events').get().available, 1);
    assert.throws(() => rotateApiKey(db, owner.credential_id), { code: 'KEY_REVOKED' });
  } finally { await new Promise((resolve) => app.close(resolve)); db.close(); }
});

test('revocation is idempotent, isolated and does not disclose token hashes', () => {
  const db = openDatabase();
  try {
    const alice = createApiKey(db, 'customer');
    const bob = createApiKey(db, 'customer');
    revokeApiKey(db, alice.credential_id);
    revokeApiKey(db, alice.credential_id);
    assert.throws(() => authenticate(db, `Bearer ${alice.token}`), { status: 401 });
    assert.equal(authenticate(db, `Bearer ${bob.token}`).id, bob.id);
    assert.equal(db.prepare('SELECT count(*) AS count FROM audit_log').get().count, 1);
    assert.throws(() => revokeApiKey(db, 'unknown'), { status: 404 });
    assert.ok(listApiKeys(db).every((row) => !('token' in row) && !('token_hash' in row)));
  } finally { db.close(); }
});

test('audit failure rolls back both rotation and revocation', () => {
  const db = openDatabase();
  try {
    const owner = createApiKey(db, 'customer');
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'injected'); END");
    for (const operation of [rotateApiKey, revokeApiKey]) {
      assert.throws(() => operation(db, owner.credential_id), /injected/);
      assert.equal(authenticate(db, `Bearer ${owner.token}`).id, owner.id);
      assert.equal(listApiKeys(db).length, 1);
      assert.equal(listApiKeys(db)[0].revoked_at, null);
    }
  } finally { db.close(); }
});

test('v1 migration retains existing tokens, reservations, retry records and foreign keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reserveflow-migrate-'));
  const path = join(directory, 'legacy.db');
  let db = new DatabaseSync(path);
  const token = `rf_${'a'.repeat(43)}`;
  try {
    db.exec(readFileSync(new URL('./fixtures/v1.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO principals VALUES (?, ?, ?)').run('legacy-owner', createHash('sha256').update(token).digest('hex'), 'admin');
    const owner = { id: 'legacy-owner', role: 'admin' };
    const event = createEvent(db, owner, { name: 'Legacy workshop', capacity: 2 });
    const input = { event_id: event.id, quantity: 1 };
    const first = reserve(db, owner, input, 'legacy-retry');
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(authenticate(db, `Bearer ${token}`).id, owner.id);
    const next = rotateApiKey(db, listApiKeys(db)[0].credential_id);
    assert.equal(getReservation(db, next, first.reservation.id).id, first.reservation.id);
    assert.equal(reserve(db, next, input, 'legacy-retry').replayed, true);
    assert.throws(() => db.prepare('DELETE FROM principals WHERE id = ?').run(owner.id), /FOREIGN KEY/);
    db.close();
    db = openDatabase(path);
    assert.equal(authenticate(db, `Bearer ${next.token}`).id, owner.id);
    assert.throws(() => authenticate(db, `Bearer ${token}`), { status: 401 });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('invalid legacy references abort migration without changing the original schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reserveflow-invalid-'));
  const path = join(directory, 'invalid.db');
  let db = new DatabaseSync(path);
  try {
    db.exec(readFileSync(new URL('./fixtures/v1.sql', import.meta.url), 'utf8'));
    db.exec("PRAGMA foreign_keys = OFF; INSERT INTO audit_log(principal_id, action, resource_id, created_at) VALUES ('missing', 'test', 'test', '2026-01-01')");
    db.close();
    assert.throws(() => openDatabase(path), /invalid references/);
    db = new DatabaseSync(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.ok(db.prepare('PRAGMA table_info(principals)').all().some((column) => column.name === 'token_hash'));
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'credentials'").get().count, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('operator CLI creates, lists, rotates and revokes against the same persistent database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reserveflow-cli-'));
  const env = { ...process.env, DATABASE_PATH: join(directory, 'cli.db') };
  const run = (script, ...args) => JSON.parse(execFileSync(process.execPath, [script, ...args], {
    cwd: new URL('..', import.meta.url), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  try {
    const first = run('scripts/create-key.js', 'customer');
    const next = run('scripts/manage-key.js', 'rotate', first.credential_id);
    assert.equal(next.id, first.id);
    assert.equal(run('scripts/manage-key.js', 'list').length, 2);
    assert.equal(run('scripts/manage-key.js', 'revoke', next.credential_id).revoked, true);
    assert.throws(() => run('scripts/manage-key.js', 'rotate', next.credential_id));
    const db = openDatabase(env.DATABASE_PATH);
    try { assert.throws(() => authenticate(db, `Bearer ${next.token}`), { status: 401 }); }
    finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
