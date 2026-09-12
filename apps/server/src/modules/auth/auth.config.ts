import { loadConfig } from '../../config.js'
import { createPool } from '../../db/pool.js'
import { createAuth } from './auth.js'

const config = loadConfig()

/** Dedicated CLI entrypoint. Runtime code imports only createAuth(), so it never leaks this pool. */
export const auth = createAuth(config, createPool(config.databaseUrl))
