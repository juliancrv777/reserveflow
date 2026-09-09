import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
  `);
  // Migration and version are committed together, including on concurrent startup.
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw new Error('Database schema is newer than this application');
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
    if (version < 2) {
      // Rebuild the parent table without its former UNIQUE token column.
      // Foreign keys are checked before commit and enabled before returning.
      db.exec(`
        CREATE TABLE credentials (
          id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL REFERENCES principals(id),
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        ) STRICT;
        INSERT INTO credentials
          SELECT id, id, token_hash, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL FROM principals;
        CREATE TABLE principals_new (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL CHECK(role IN ('admin', 'customer'))
        ) STRICT;
        INSERT INTO principals_new SELECT id, role FROM principals;
        DROP TABLE principals;
        ALTER TABLE principals_new RENAME TO principals;
        CREATE UNIQUE INDEX credentials_one_active ON credentials(principal_id) WHERE revoked_at IS NULL;
        PRAGMA user_version = 2;
      `);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database contains invalid references');
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');
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
