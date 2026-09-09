import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, existsSync, linkSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function verifyDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    if (db.prepare('PRAGMA user_version').get().user_version !== 2) {
      throw new Error('Expected ReserveFlow schema version 2; verification does not migrate databases');
    }
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Database integrity check failed');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database reference check failed');
    // Prepare explicit columns so unrelated SQLite files cannot pass on version alone.
    const columns = {
      principals: 'id, role', credentials: 'id, principal_id, token_hash, created_at, revoked_at',
      events: 'id, name, capacity, available, created_at',
      reservations: 'id, principal_id, event_id, quantity, status, created_at, cancelled_at',
      idempotency: 'principal_id, key, fingerprint, response',
      audit_log: 'sequence, principal_id, action, resource_id, created_at',
    };
    const counts = {};
    for (const [table, fields] of Object.entries(columns)) {
      db.prepare(`SELECT ${fields} FROM ${table} LIMIT 0`).all();
      counts[table] = db.prepare(`SELECT count(*) AS total FROM ${table}`).get().total;
    }
    const inconsistent = db.prepare(`SELECT e.id FROM events e WHERE e.available != e.capacity -
      COALESCE((SELECT sum(r.quantity) FROM reservations r WHERE r.event_id = e.id AND r.status = 'confirmed'), 0)
      LIMIT 1`).get();
    if (inconsistent) throw new Error('Reservation capacity check failed');
    db.exec('COMMIT');
    return { schema_version: 2, integrity: 'ok', counts };
  } finally { db.close(); }
}

export async function copyDatabaseSnapshot(source, destination) {
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  if (sourcePath === destinationPath) throw new Error('Source and destination must differ');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (existsSync(destinationPath + suffix)) throw new Error('Destination or SQLite sidecar already exists; choose a new path');
  }
  // readOnly prevents a mistyped source path from silently creating an empty database.
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  let staging;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    staging = mkdtempSync(join(dirname(destinationPath), '.reserveflow-snapshot-'));
    const stagedPath = join(staging, 'snapshot.db');
    await backup(db, stagedPath);
    // Produce a self-contained file even if the source uses WAL mode.
    const snapshot = new DatabaseSync(stagedPath);
    try { snapshot.exec('PRAGMA journal_mode = DELETE'); } finally { snapshot.close(); }
    const report = verifyDatabase(stagedPath);
    chmodSync(stagedPath, 0o600);
    // Same-filesystem hard link publishes the complete, verified file without overwriting.
    linkSync(stagedPath, destinationPath);
    return { path: destinationPath, ...report };
  } finally {
    db.close();
    if (staging) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(join(staging, `snapshot.db${suffix}`), { force: true });
      rmdirSync(staging);
    }
  }
}
