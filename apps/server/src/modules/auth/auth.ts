import { oauthDeviceAuthorization, oauthProvider } from '@better-auth/oauth-provider'
import { betterAuth } from 'better-auth'
import { jwt } from 'better-auth/plugins'
import type { ServerConfig } from '../../config.js'
import type { DatabasePool } from '../../db/pool.js'

export function createAuth(config: ServerConfig, pool: DatabasePool) {
  const apiResource = `${config.canonicalUrl}/api/v1`
  return betterAuth({
    appName: config.instanceName,
    baseURL: config.canonicalUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    database: pool,
    trustedOrigins: [config.webOrigin, config.canonicalUrl],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !(config.publicSignup || config.bootstrapMode),
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      cookiePrefix: 'maestrly',
      useSecureCookies: config.environment === 'production' && config.canonicalUrl.startsWith('https://'),
    },
    plugins: [
      jwt({ jwt: { issuer: `${config.canonicalUrl}/api/auth` } }),
      oauthProvider({
        loginPage: `${config.webOrigin}/login`,
        consentPage: `${config.webOrigin}/consent`,
        scopes: ['openid', 'profile', 'email', 'offline_access', 'api:read', 'api:write'],
        resources: [apiResource],
        clientRegistrationDefaultResources: [apiResource],
        clientRegistrationAllowedResources: [apiResource],
        refreshTokenReuseInterval: 30,
      }),
      oauthDeviceAuthorization({
        verificationUri: `${config.webOrigin}/device`,
      }),
    ],
  })
}

export type MaestrlyAuth = ReturnType<typeof createAuth>
