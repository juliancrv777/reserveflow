import { openDatabase } from '../src/database.js';
import { listApiKeys, rotateApiKey, revokeApiKey } from '../src/service.js';

const [command, credentialId, ...extra] = process.argv.slice(2);
if (!['list', 'rotate', 'revoke'].includes(command) || extra.length ||
    (command === 'list' ? credentialId !== undefined : !credentialId)) {
  console.error('Usage: npm run keys -- list | rotate <credential_id> | revoke <credential_id>');
  process.exitCode = 1;
} else {
  const db = openDatabase(process.env.DATABASE_PATH ?? './data/reserveflow.db');
  try {
    const result = command === 'list' ? listApiKeys(db)
      : command === 'rotate' ? rotateApiKey(db, credentialId) : revokeApiKey(db, credentialId);
    console.log(JSON.stringify(result, null, 2));
    if (command === 'rotate') console.error('Old token revoked. Store the new token securely; it cannot be retrieved again.');
  } catch (error) {
    console.error(error.code ?? 'KEY_OPERATION_FAILED');
    process.exitCode = 1;
  } finally { db.close(); }
}
