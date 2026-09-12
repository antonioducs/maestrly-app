import { describe, expect, it } from 'vitest'
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client'
import { createAuthClient } from 'better-auth/client'
import { loadConfig } from '../../src/config.js'
import { createAuth } from '../../src/modules/auth/auth.js'
import { integrationAvailable, runtimePool, runtimeUrl } from './helpers.js'
import { createServer } from 'node:net'
import { buildApp } from '../../src/app.js'

let canonicalUrl = 'http://127.0.0.1:4310'
const jsonRequest = (path: string, body: unknown, cookie?: string) => new Request(`${canonicalUrl}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
})

describe.skipIf(!integrationAvailable)('OAuth device authorization', () => {
  it.each(['registered','builtin'])('requires explicit approval and issues audience-bound tokens: %s', async (kind) => {
    const pool = runtimePool()
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const address = probe.address()
    const port = typeof address === 'object' && address ? address.port : 43191
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
    canonicalUrl = `http://127.0.0.1:${port}`
    const config = loadConfig({
      NODE_ENV: 'test', DATABASE_URL: runtimeUrl!, BETTER_AUTH_SECRET: 'device-auth-secret-0123456789abcdef',
      MAESTRLY_CANONICAL_URL: canonicalUrl, MAESTRLY_WEB_ORIGIN: 'http://127.0.0.1:4173', MAESTRLY_BOOTSTRAP_MODE: 'true',
      LOG_LEVEL: 'silent',
    })
    const auth = createAuth(config, pool)
    const app = await buildApp({ config, pool, auth })
    await app.listen({ host: '127.0.0.1', port })
    try {
      const email = `device-${crypto.randomUUID()}@example.test`
      const signup = await auth.handler(jsonRequest('/api/auth/sign-up/email', { email, password: 'correct-horse-battery', name: 'Device owner' }))
      expect(signup.status).toBe(200)
      const cookie = signup.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
      expect(cookie).toContain('maestrly.session_token')

      const client = kind==='builtin'?{client_id:'maestrly-desktop-personal-v1'}:await auth.api.adminCreateOAuthClient({
        headers: new Headers({ cookie }),
        body: {
          token_endpoint_auth_method: 'none', application_type: 'native',
          grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
          scope: 'openid profile email offline_access api:read api:write', client_name: 'Maestrly Desktop test',
        },
      })
      const codeResponse = await auth.handler(jsonRequest('/api/auth/device/code', {
        client_id: client.client_id, scope: 'openid profile email offline_access api:read api:write', resource: `${canonicalUrl}/api/v1`,
      }))
      expect(codeResponse.status,codeResponse.status===200?'':await codeResponse.clone().text()).toBe(200)
      const code = await codeResponse.json() as { device_code: string; user_code: string; interval: number }

      const pending = await auth.handler(new Request(`${canonicalUrl}/api/auth/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code, client_id: client.client_id }),
      }))
      expect(pending.status).toBe(400)
      await expect(pending.json()).resolves.toMatchObject({ error: 'authorization_pending' })
      const verified = await auth.handler(new Request(`${canonicalUrl}/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`, { headers: { cookie } }))
      expect(verified.status, await verified.clone().text()).toBe(200)
      const approved = await auth.handler(jsonRequest('/api/auth/device/approve', { userCode: code.user_code }, cookie))
      expect(approved.status, await approved.clone().text()).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, code.interval * 1_000))

      const tokenResponse = await auth.handler(new Request(`${canonicalUrl}/api/auth/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code, client_id: client.client_id }),
      }))
      const tokenBody = await tokenResponse.json() as { access_token: string; refresh_token?: string; error?: string; error_description?: string }
      expect(tokenResponse.status, JSON.stringify(tokenBody)).toBe(200)
      const tokens = tokenBody
      expect(tokens.refresh_token).toBeTruthy()
      const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
      expect(claims.iss).toBe(`${canonicalUrl}/api/auth`)
      expect(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).toContain(`${canonicalUrl}/api/v1`)
      expect(String(claims.scope).split(' ')).toContain('api:read')
      const profile=await fetch(`${canonicalUrl}/api/v1/me`,{headers:{authorization:`Bearer ${tokens.access_token}`,'x-maestrly-protocol-version':'1.0'}})
      expect(profile.status).toBe(200);expect((await profile.json() as {userId:string}).userId).toBe(claims.sub)
      const resourceClient = createAuthClient({ baseURL: canonicalUrl, plugins: [oauthProviderResourceClient(auth)] })
      await expect(resourceClient.verifyBearerToken(tokens.access_token, {
        verifyOptions: { audience: `${canonicalUrl}/api/v1` }, requiredScopes: ['api:read'],
      })).resolves.toMatchObject({ iss: `${canonicalUrl}/api/auth` })
      await expect(resourceClient.verifyBearerToken(tokens.access_token, {
        verifyOptions: { audience: 'https://another-instance.example/api/v1' }, requiredScopes: ['api:read'],
      })).rejects.toThrow()
    } finally { await app.close(); await pool.end() }
  })
})
