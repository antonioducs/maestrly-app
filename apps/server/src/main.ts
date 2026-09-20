import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createPool } from './db/pool.js'
import { createAuth } from './modules/auth/auth.js'
import { reconcileExpiredLeases } from './modules/jobs/reconcile.js'
import { reconcileChat } from './modules/project-chat/dispatch.js'
import { reconcileDelegations } from './modules/delegations/reconcile.js'
import { runDelegationScheduler } from './modules/delegations/scheduler.js'

const config = loadConfig()
const pool = createPool(config.databaseUrl)
const auth = createAuth(config, pool)
const app = await buildApp({ config, pool, auth })
const reconciler = setInterval(() => {
  void reconcileChat(pool).catch((error) => app.log.error({ err: error }, 'chat reconciliation failed'))
  void reconcileExpiredLeases(pool).catch((error) => app.log.error({ err: error }, 'lease reconciliation failed'))
  void reconcileDelegations(pool).catch((error) => app.log.error({ err: error }, 'delegation reconciliation failed'))
}, 30_000)
reconciler.unref()
// Stage admission is cheap and short; a tighter interval keeps a pipeline responsive between turns.
const scheduler = setInterval(() => {
  void runDelegationScheduler(pool).catch((error) => app.log.error({ err: error }, 'delegation scheduling failed'))
}, 5_000)
scheduler.unref()

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down')
  clearInterval(reconciler)
  clearInterval(scheduler)
  await app.close()
  await pool.end()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void shutdown(signal) })
}

await app.listen({ host: config.host, port: config.port })
