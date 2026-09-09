import { copyDatabaseSnapshot, verifyDatabase } from '../src/backup.js';

const [command, ...args] = process.argv.slice(2);
const expected = { backup: 1, restore: 2, verify: 1 };
if (!Object.hasOwn(expected, command) || args.length !== expected[command]) {
  console.error('Usage: npm run backup -- <new-file> | npm run restore -- <backup-file> <new-file> | npm run verify -- <file>');
  process.exitCode = 1;
} else {
  try {
    const report = command === 'verify' ? verifyDatabase(args[0])
      : await copyDatabaseSnapshot(command === 'backup' ? process.env.DATABASE_PATH ?? './data/reserveflow.db' : args[0],
        command === 'backup' ? args[0] : args[1]);
    console.log(JSON.stringify({ operation: command, ...report }, null, 2));
    if (command === 'restore') console.error('Restored to a new file. Stop the server before switching DATABASE_PATH. Review credentials: revocations after this backup are not present.');
  } catch (error) {
    console.error(`Database operation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
