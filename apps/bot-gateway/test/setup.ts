import { vi } from 'vitest'

/**
 * Test databases skip the disk flush of every commit (`PRAGMA synchronous = OFF`). The engine, WAL mode and
 * migrations stay the production ones, and no test checks durability across an operating system crash. Windows
 * runners flush each commit to disk, which makes SQLite-heavy tests many times slower there.
 */
vi.mock('node:sqlite', async (importOriginal) => {
  const sqlite = await importOriginal<typeof import('node:sqlite')>()
  class DatabaseSync extends sqlite.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof sqlite.DatabaseSync>) {
      super(...args)
      // A connection created with `open: false` opens later with the default; it is only slower.
      if (!this.isOpen) return
      try {
        this.exec('PRAGMA synchronous = OFF')
      } catch {
        // A file that is not a database opens anyway and fails on first use, where the code under test expects it:
        // failing here instead would leave the connection open, and the file locked on Windows.
      }
    }
  }
  return { ...sqlite, DatabaseSync }
})
