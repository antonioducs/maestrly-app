import { fileURLToPath } from 'node:url'

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
