import { oauthDeviceAuthorization, oauthProvider } from '@better-auth/oauth-provider'
import { betterAuth } from 'better-auth'
import { jwt } from 'better-auth/plugins'
import type { ServerConfig } from '../../config.js'
import type { DatabasePool } from '../../db/pool.js'

export function createAuth(config: ServerConfig, pool: DatabasePool) {
  const apiResource = `${config.canonicalUrl}/api/v1`
  /**
   * The MCP endpoint is its own protected resource, so a connector token never satisfies the REST
   * audience and a desktop/web token never satisfies the MCP audience.
   */
  const mcpResource = `${config.canonicalUrl}/mcp`
  /**
   * Personal bot connections are a third audience: a bot token is accepted only by `/mcp/bots`, and a
   * connector or desktop token is never accepted there.
   */
  const botResource = `${config.canonicalUrl}/mcp/bots`
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
        resources: [apiResource, mcpResource, botResource],
        clientRegistrationDefaultResources: [apiResource],
        // Connector clients are narrowed to the MCP resource when the owner creates the connection, so a
        // bot token never reaches the REST API with the signed-in user's full authority.
        clientRegistrationAllowedResources: [apiResource, mcpResource, botResource],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: config.connectorOpenRegistration,
        refreshTokenReuseInterval: 30,
      }),
      oauthDeviceAuthorization({
        verificationUri: `${config.webOrigin}/device`,
      }),
    ],
  })
}

export type MaestrlyAuth = ReturnType<typeof createAuth>
