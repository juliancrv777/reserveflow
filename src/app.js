import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { ApiError, requireValue } from './errors.js';
import { authenticate, requireAdmin, createEvent, reserve, cancel, getReservation } from './service.js';

const openapi = readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8');

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 16 KiB');
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON'); }
  requireValue(input !== null && typeof input === 'object' && !Array.isArray(input), 'Request body must be an object');
  return input;
}

function pagination(url) {
  const limit = Number(url.searchParams.get('limit') ?? 20);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'limit must be between 1 and 100');
  requireValue(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000, 'offset must be between 0 and 1000000');
  return { limit, offset };
}

export function createApp(db, { logger = (entry) => console.log(JSON.stringify(entry)) } = {}) {
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = performance.now();
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.on('finish', () => logger({ request_id: requestId, method: request.method,
      status: response.statusCode, duration_ms: Math.round((performance.now() - started) * 100) / 100 }));
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      if (request.method === 'GET' && path === '/health') {
        db.prepare('SELECT 1').get();
        return send(200, { status: 'ok' });
      }
      if (request.method === 'GET' && path === '/openapi.json') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return response.end(openapi);
      }
      const principal = authenticate(db, request.headers.authorization);
      if (path === '/v1/events' && request.method === 'GET') {
        const { limit, offset } = pagination(url);
        return send(200, { data: db.prepare('SELECT * FROM events ORDER BY created_at, id LIMIT ? OFFSET ?').all(limit, offset), limit, offset });
      }
      if (path === '/v1/events' && request.method === 'POST') {
        requireAdmin(principal);
        return send(201, createEvent(db, principal, await readJson(request)));
      }
      if (path === '/v1/reservations' && request.method === 'POST') {
        const result = reserve(db, principal, await readJson(request), request.headers['idempotency-key']);
        response.setHeader('Idempotency-Replayed', String(result.replayed));
        response.setHeader('Location', `/v1/reservations/${result.reservation.id}`);
        return send(201, result.reservation);
      }
      if (path === '/v1/reservations' && request.method === 'GET') {
        const { limit, offset } = pagination(url);
        return send(200, { data: db.prepare('SELECT * FROM reservations WHERE principal_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?')
          .all(principal.id, limit, offset), limit, offset });
      }
      const match = /^\/v1\/reservations\/([a-f0-9-]{36})(\/cancel)?$/.exec(path);
      if (match && !match[2] && request.method === 'GET') return send(200, getReservation(db, principal, match[1]));
      if (match && match[2] && request.method === 'POST') return send(200, cancel(db, principal, match[1]));
      if (path === '/v1/audit' && request.method === 'GET') {
        requireAdmin(principal);
        const { limit, offset } = pagination(url);
        return send(200, { data: db.prepare('SELECT * FROM audit_log ORDER BY sequence LIMIT ? OFFSET ?').all(limit, offset), limit, offset });
      }
      throw new ApiError(404, 'NOT_FOUND', 'Route not found');
    } catch (error) {
      if (error instanceof ApiError) return send(error.status, { error: { code: error.code, message: error.message, request_id: requestId } });
      if (error.errcode === 5 || error.errcode === 6) {
        response.setHeader('Retry-After', '1');
        return send(503, { error: { code: 'DATABASE_BUSY', message: 'Please retry with the same idempotency key', request_id: requestId } });
      }
      logger({ request_id: requestId, level: 'error', code: 'INTERNAL_ERROR' });
      return send(500, { error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error', request_id: requestId } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
