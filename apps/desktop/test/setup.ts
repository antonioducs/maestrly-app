import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

/**
 * Test databases skip the disk flush of every commit (`PRAGMA synchronous = OFF`). The engine, WAL, foreign keys and
 * migrations stay the production ones, and no test checks durability across an operating system crash. Windows
 * runners flush each commit to disk, which made SQLite-heavy suites hundreds of times slower there than on macOS.
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

// Fixtures must not inherit signing, LFS filters, or hooks from the host Git configuration.
process.env.GIT_CONFIG_GLOBAL = fileURLToPath(new URL('./fixtures/empty.gitconfig', import.meta.url))
process.env.GIT_CONFIG_NOSYSTEM = '1'

/**
 * Global test setup (vitest.config → setupFiles), run once per fork before the tests.
 * Suppress the expected `node:sqlite` ExperimentalWarning: tests use real Node to exercise
 * the production database engine, and this warning only adds noise.
 */
const origEmit = process.emitWarning.bind(process)
process.emitWarning = ((warning: unknown, ...args: unknown[]): void => {
  const msg = typeof warning === 'string' ? warning : ((warning as Error)?.message ?? '')
  if (typeof msg === 'string' && msg.includes('SQLite is an experimental feature')) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (origEmit as any)(warning, ...args)
}) as typeof process.emitWarning
