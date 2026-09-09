# Backup and recovery

## Create and verify a snapshot

Run from the repository root after provisioning the database. Use the same `DATABASE_PATH` as the server. Create the destination directory first; every destination must be a new filename.

```sh
mkdir backups
npm run backup -- backups/reserveflow-001.db
npm run verify -- backups/reserveflow-001.db
```

The command uses Node's [SQLite backup API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) through a separate read-only source connection. It captures a consistent snapshot of committed data, including data in WAL, while the API may remain running. Uncommitted transactions are excluded. Writes from other connections may restart copying, so sustained write traffic can delay completion. Copying only the live `.db` file is not this procedure.

The result contains only a file path, schema version and table counts. It never prints rows, tokens or token hashes. The snapshot itself contains application data and credential hashes: restrict its directory permissions and use encrypted off-host storage for a real deployment. On POSIX the output file has mode `0600`; Windows access control follows the directory ACL.

## Restore without replacing the live database

```sh
npm run restore -- backups/reserveflow-001.db data/restored-001.db
npm run verify -- data/restored-001.db
```

1. Restore into a new file. The existing database and running process remain unchanged.
2. Inspect the verification report and the backup's age. Changes after the snapshot are absent, including reservations, cancellations, audit events and idempotency records.
3. Stop the API before switching files. Set `DATABASE_PATH` to the restored file for both the API and all operator commands.
4. Review credentials with `npm run keys -- list` against that path. **A token revoked after the snapshot may be active again after restoration.** Rotate or revoke affected credentials before reopening access. A key created after the snapshot will be absent.
5. Start the API, check `/health`, then authenticate and read a known reservation. Check expected capacity and review audit history. Do not create a real booking just to probe health.
6. Keep the previous database until recovery is accepted. Once writes resume, switching back would discard new changes and needs a reconciliation plan.

PowerShell example for selecting the restored file, after stopping the existing server:

```powershell
$env:DATABASE_PATH = './data/restored-001.db'
npm run keys -- list
# Perform any required credential rotation/revocation before starting.
npm start
```

## Guarantees and limits

- Both backup and restore stage the SQLite snapshot in the destination directory, normalize it to a standalone database, verify it, and publish it with a hard link that fails if the destination exists. Existing destinations and SQLite sidecars are refused. Local filesystems with hard-link support, such as NTFS and typical Linux filesystems, are required; no unsafe overwrite fallback is used.
- Verification opens the file read-only and checks schema version 2, SQLite integrity, foreign keys, expected table columns and `available = capacity - confirmed quantities`. It does not prove all business history is authentic, replace a security audit or repair corruption. Older schemas must be upgraded using the application before this backup command; verification never migrates them.
- Handled failures remove their staging files. A terminated process or power loss may leave a `.reserveflow-snapshot-*` directory; inspect it after confirming no backup process is running. Publication is atomic with respect to competing filenames, but no power-loss durability guarantee or directory fsync protocol is claimed.
- No backup schedule, retention cleanup, remote storage, encryption, restore-time target or maximum data-loss target is configured. These operator commands do not silently run in the background.

## Reproducible recovery exercise

`npm test` includes a file-backed WAL exercise with the source connection open and an uncommitted change in progress. It restores into a separate file, starts a real HTTP server and checks reservation ownership, active/revoked tokens, original idempotent responses, cancelled capacity and audit counts. Additional cases reject corrupt/incompatible/inconsistent inputs, protect existing files and test competing backups and CLI failure exit codes. All exercise data is temporary.
