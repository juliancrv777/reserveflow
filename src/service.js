import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError, requireValue } from './errors.js';
import { transaction } from './database.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

export function createApiKey(db, role) {
  requireValue(['admin', 'customer'].includes(role), 'Role must be admin or customer');
  const id = randomUUID();
  return transaction(db, () => {
    db.prepare('INSERT INTO principals(id, role) VALUES (?, ?)').run(id, role);
    return issueCredential(db, { id, role });
  });
}

function issueCredential(db, principal) {
  const token = `rf_${randomBytes(32).toString('base64url')}`;
  const credential_id = randomUUID();
  db.prepare('INSERT INTO credentials(id, principal_id, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(credential_id, principal.id, hash(token), now());
  return { ...principal, credential_id, token };
}

export function listApiKeys(db) {
  return db.prepare(`SELECT c.id AS credential_id, c.principal_id, p.role, c.created_at, c.revoked_at
    FROM credentials c JOIN principals p ON p.id = c.principal_id ORDER BY c.created_at, c.id`).all();
}

function findCredential(db, credentialId) {
  const credential = db.prepare(`SELECT c.id AS credential_id, p.id, p.role, c.revoked_at
    FROM credentials c JOIN principals p ON p.id = c.principal_id WHERE c.id = ?`).get(credentialId);
  if (!credential) throw new ApiError(404, 'NOT_FOUND', 'Credential not found');
  return credential;
}

export function rotateApiKey(db, credentialId) {
  return transaction(db, () => {
    const previous = findCredential(db, credentialId);
    if (previous.revoked_at) throw new ApiError(409, 'KEY_REVOKED', 'Cannot rotate a revoked credential');
    db.prepare('UPDATE credentials SET revoked_at = ? WHERE id = ?').run(now(), credentialId);
    const next = issueCredential(db, { id: previous.id, role: previous.role });
    audit(db, previous, 'credential.rotated', credentialId);
    return next;
  });
}

export function revokeApiKey(db, credentialId) {
  return transaction(db, () => {
    const previous = findCredential(db, credentialId);
    if (!previous.revoked_at) {
      db.prepare('UPDATE credentials SET revoked_at = ? WHERE id = ?').run(now(), credentialId);
      audit(db, previous, 'credential.revoked', credentialId);
    }
    return { credential_id: credentialId, revoked: true };
  });
}

export function authenticate(db, authorization) {
  if (typeof authorization !== 'string' || !/^Bearer rf_[A-Za-z0-9_-]{43}$/.test(authorization)) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A valid Bearer API key is required');
  }
  const principal = db.prepare(`SELECT p.id, p.role FROM principals p
    JOIN credentials c ON c.principal_id = p.id WHERE c.token_hash = ? AND c.revoked_at IS NULL`)
    .get(hash(authorization.slice(7)));
  if (!principal) throw new ApiError(401, 'UNAUTHORIZED', 'A valid Bearer API key is required');
  return principal;
}

export function requireAdmin(principal) {
  if (principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Admin role required');
}

function audit(db, principal, action, resourceId) {
  db.prepare('INSERT INTO audit_log(principal_id, action, resource_id, created_at) VALUES (?, ?, ?, ?)')
    .run(principal.id, action, resourceId, now());
}

export function createEvent(db, principal, input) {
  requireAdmin(principal);
  requireValue(typeof input.name === 'string' && input.name.trim().length >= 3 && input.name.trim().length <= 120,
    'name must contain 3 to 120 characters');
  requireValue(Number.isSafeInteger(input.capacity) && input.capacity > 0 && input.capacity <= 1000000,
    'capacity must be an integer between 1 and 1000000');
  return transaction(db, () => {
    const event = { id: randomUUID(), name: input.name.trim(), capacity: input.capacity, available: input.capacity, created_at: now() };
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)')
      .run(event.id, event.name, event.capacity, event.available, event.created_at);
    audit(db, principal, 'event.created', event.id);
    return event;
  });
}

export function reserve(db, principal, input, key) {
  requireValue(typeof key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(key),
    'Idempotency-Key must contain 8 to 128 letters, digits, underscores or hyphens');
  requireValue(typeof input.event_id === 'string' && input.event_id.length <= 64, 'event_id is required');
  requireValue(Number.isSafeInteger(input.quantity) && input.quantity >= 1 && input.quantity <= 100,
    'quantity must be an integer between 1 and 100');
  const fingerprint = hash(JSON.stringify([input.event_id, input.quantity]));
  return transaction(db, () => {
    const previous = db.prepare('SELECT fingerprint, response FROM idempotency WHERE principal_id = ? AND key = ?')
      .get(principal.id, key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used with a different payload');
      }
      return { reservation: JSON.parse(previous.response), replayed: true };
    }
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(input.event_id);
    if (!event) throw new ApiError(404, 'NOT_FOUND', 'Event not found');
    // The conditional write is the invariant; the preceding read is only for 404 semantics.
    const changed = db.prepare('UPDATE events SET available = available - ? WHERE id = ? AND available >= ?')
      .run(input.quantity, input.event_id, input.quantity);
    if (changed.changes !== 1) throw new ApiError(409, 'SOLD_OUT', 'Not enough capacity available');
    const reservation = {
      id: randomUUID(), principal_id: principal.id, event_id: input.event_id,
      quantity: input.quantity, status: 'confirmed', created_at: now(), cancelled_at: null,
    };
    db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      reservation.id, principal.id, input.event_id, input.quantity, reservation.status, reservation.created_at, null,
    );
    db.prepare('INSERT INTO idempotency VALUES (?, ?, ?, ?)').run(principal.id, key, fingerprint, JSON.stringify(reservation));
    audit(db, principal, 'reservation.confirmed', reservation.id);
    return { reservation, replayed: false };
  });
}

export function getReservation(db, principal, id) {
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ? AND principal_id = ?').get(id, principal.id);
  if (!reservation) throw new ApiError(404, 'NOT_FOUND', 'Reservation not found');
  return reservation;
}

export function cancel(db, principal, id) {
  return transaction(db, () => {
    const reservation = getReservation(db, principal, id);
    if (reservation.status === 'cancelled') return reservation;
    db.prepare("UPDATE reservations SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(now(), id);
    db.prepare('UPDATE events SET available = available + ? WHERE id = ?').run(reservation.quantity, reservation.event_id);
    audit(db, principal, 'reservation.cancelled', id);
    return getReservation(db, principal, id);
  });
}
