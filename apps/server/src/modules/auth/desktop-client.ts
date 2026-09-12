import { randomUUID } from 'node:crypto'
import type { DatabasePool } from '../../db/pool.js'

export const DESKTOP_CLIENT_ID = 'maestrly-desktop-personal-v1'
/** Bind the migration-owned public client to this installation's configured API audience. */
export async function configureDesktopClientResource(pool: DatabasePool, canonicalUrl: string) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtext('maestrly-desktop-client-resource'))")
    const registered = await client.query('select id from "oauthClient" where "clientId"=$1', [DESKTOP_CLIENT_ID])
    if (registered.rowCount) {
      const resource = canonicalUrl + '/api/v1'
      await client.query(
        'insert into "oauthResource"(id,identifier,name,"createdAt",disabled) values($1,$2,$3,now(),false) on conflict(identifier) do nothing',
        [randomUUID(), resource, 'Maestrly API']
      )
      await client.query(
        'insert into "oauthClientResource"(id,"clientId","resourceId","createdAt") select $1,$2,$3,now() where not exists(select 1 from "oauthClientResource" where "clientId"=$2 and "resourceId"=$3)',
        [randomUUID(), DESKTOP_CLIENT_ID, resource]
      )
    }
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}
