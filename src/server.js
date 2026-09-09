import { openDatabase } from './database.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const db = openDatabase(process.env.DATABASE_PATH ?? './data/reserveflow.db');
const app = createApp(db);
app.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'server.started', port }));
});
app.on('error', (error) => {
  console.error(JSON.stringify({ event: 'server.failed', code: error.code }));
  db.close();
  process.exitCode = 1;
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => app.closeAllConnections(), 10000);
  timeout.unref();
  app.close(() => { clearTimeout(timeout); db.close(); });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
