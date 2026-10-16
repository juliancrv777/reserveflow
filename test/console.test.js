import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';

test('public console assets are served securely while business routes remain protected', async (t) => {
  const db = openDatabase();
  const app = createApp(db, { logger: () => {} });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
    db.close();
  });

  const base = `http://127.0.0.1:${app.address().port}`;
  for (const [path, type] of [
    ['/', 'text/html'], ['/console.css', 'text/css'], ['/console.js', 'text/javascript'],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type').startsWith(type), path);
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.ok(body.length > 100);
    assert.ok(!body.includes('rf_' + 'x'.repeat(43)));
  }
  const protectedResponse = await fetch(base + '/v1/events');
  assert.equal(protectedResponse.status, 401);
  const unknown = await fetch(base + '/unknown');
  assert.equal(unknown.status, 401);
});
