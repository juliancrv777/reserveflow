import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../src/database.js';
import { reserve } from '../src/service.js';
const db = openDatabase(workerData.path);
parentPort.postMessage({ ready: true });
parentPort.once('message', () => {
  try {
    const result = reserve(db, workerData.principal, { event_id: workerData.eventId, quantity: 1 }, workerData.key);
    parentPort.postMessage({ status: 201, id: result.reservation.id });
  } catch (error) {
    parentPort.postMessage({ status: error.status ?? 500, code: error.code });
  } finally { db.close(); parentPort.close(); }
});
