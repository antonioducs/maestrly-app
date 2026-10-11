import type { DatabaseSync } from 'node:sqlite'

/** The transfer queue of this computer: each transfer, and the ranges it is split into. */
export function initializeHostTransferSchema(db: DatabaseSync): void {
  // `start` rather than `offset`, a reserved word.
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_transfers (
      id TEXT PRIMARY KEY, host_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('download','upload')),
      purpose TEXT NOT NULL CHECK(purpose IN ('save','open')),
      name TEXT NOT NULL, remote_path TEXT NOT NULL, remote_directory TEXT,
      local_path TEXT, local_directory TEXT, partial_path TEXT,
      size INTEGER NOT NULL, identity TEXT NOT NULL, upload_id TEXT, overwrite INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL, error TEXT, error_message TEXT, remote_sha256 TEXT, local_sha256 TEXT,
      created_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS host_transfer_ranges (
      transfer_id TEXT NOT NULL REFERENCES host_transfers(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL, start INTEGER NOT NULL, length INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(transfer_id, idx)
    );
    CREATE INDEX IF NOT EXISTS host_transfers_created ON host_transfers(created_at);
  `)
}
