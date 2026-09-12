import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEVICE_CODE_GRANT_TYPE } from '@better-auth/oauth-provider'
import { loadConfig } from '../../config.js'
import { createPool } from '../../db/pool.js'
import { createAuth } from './auth.js'

export async function registerDesktopClient(environment: NodeJS.ProcessEnv = process.env): Promise<{ clientId: string }> {
  const email = environment.MAESTRLY_ADMIN_EMAIL
  const password = environment.MAESTRLY_ADMIN_PASSWORD
  if (!email || !password) throw new Error('MAESTRLY_ADMIN_EMAIL and MAESTRLY_ADMIN_PASSWORD are required.')
  const config = loadConfig(environment)
  const pool = createPool(config.databaseUrl)
  const auth = createAuth(config, pool)
  try {
    const signedIn = await auth.handler(new Request(`${config.canonicalUrl}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    }))
    if (!signedIn.ok) throw new Error('Administrator authentication failed.')
    const signedInBody = await signedIn.clone().json() as { user?: { id?: string } }
    const userId = signedInBody.user?.id
    if (!userId) throw new Error('Administrator authentication did not return an identity.')
    const database = await pool.connect()
    try {
      await database.query('begin')
      await database.query("select set_config('app.user_id', $1, true)", [userId])
      const access = await database.query<{ allowed: boolean }>(`
        select exists(select 1 from organization_members where user_id = $1 and role in ('owner', 'admin')) as allowed
      `, [userId])
      await database.query('commit')
      if (!access.rows[0]?.allowed) throw new Error('An organization owner or administrator is required.')
    } catch (error) {
      await database.query('rollback').catch(() => undefined)
      throw error
    } finally { database.release() }
    const cookie = signedIn.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
    const client = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie }),
      body: {
        token_endpoint_auth_method: 'none', application_type: 'native',
        grant_types: [DEVICE_CODE_GRANT_TYPE, 'refresh_token'],
        scope: 'openid profile email offline_access api:read api:write',
        client_name: 'Maestrly Desktop',
      },
    })
    return { clientId: client.client_id }
  } finally { await pool.end() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await registerDesktopClient()
  process.stdout.write(`Desktop OAuth client ID: ${result.clientId}\n`)
}
