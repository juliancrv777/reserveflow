import { openDatabase } from '../src/database.js';
import { createApiKey } from '../src/service.js';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/reserveflow.db');
try {
  const key = createApiKey(db, process.argv[2] ?? 'customer');
  console.log(JSON.stringify(key, null, 2));
  console.error('Store this key securely. Only its hash is stored in the database.');
} finally { db.close(); }
