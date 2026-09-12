import pg from 'pg'

const { Pool } = pg

export function createPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'maestrly-server',
  })
}

export type DatabasePool = pg.Pool
export type DatabaseClient = pg.PoolClient
