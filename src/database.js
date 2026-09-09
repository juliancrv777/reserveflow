import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
  `);
  // Migration and version are committed together, including on concurrent startup.
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('Database schema is newer than this application');
    if (version === 0) {
      db.exec(`
        CREATE TABLE principals (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK(role IN ('admin', 'customer'))
        ) STRICT;
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          capacity INTEGER NOT NULL CHECK(capacity > 0),
          available INTEGER NOT NULL CHECK(available >= 0 AND available <= capacity),
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE reservations (
          id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL REFERENCES principals(id),
          event_id TEXT NOT NULL REFERENCES events(id),
          quantity INTEGER NOT NULL CHECK(quantity > 0),
          status TEXT NOT NULL CHECK(status IN ('confirmed', 'cancelled')),
          created_at TEXT NOT NULL,
          cancelled_at TEXT
        ) STRICT;
        CREATE INDEX reservations_owner ON reservations(principal_id, created_at, id);
        CREATE TABLE idempotency (
          principal_id TEXT NOT NULL REFERENCES principals(id),
          key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          response TEXT NOT NULL,
          PRIMARY KEY(principal_id, key)
        ) STRICT;
        CREATE TABLE audit_log (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          principal_id TEXT NOT NULL REFERENCES principals(id),
          action TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  return db;
}

export function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
