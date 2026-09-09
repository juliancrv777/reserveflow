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
