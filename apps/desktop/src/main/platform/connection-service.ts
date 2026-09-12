import { randomUUID } from 'node:crypto'
import { MaestrlyClient } from '@maestrly/client-sdk'
import { getAppSetting, setAppSetting } from '../store'
import type { DeviceAuthorizationView, PlatformConnectionView, RemotePlatformProject } from '../../shared/platform'
import { HttpTransport } from '@maestrly/client-sdk'
import { PlatformCredentialStore } from './credential-store'

interface StoredConnection {
  id: string
  url: string
  name: string
  instanceId: string | null
  desktopClientId?: string
}
interface PendingAuthorization extends DeviceAuthorizationView {
  clientId: string
  resource: string
  expiresAt: number
  lastPolledAt?: number
}
const CONNECTIONS_KEY = 'platform.connections.v1'

export class PlatformConnectionService {
  private readonly states = new Map<string, PlatformConnectionView>()
  private readonly refreshing = new Map<string, Promise<string>>()
  private readonly pending = new Map<string, PendingAuthorization>()
  private loaded = false
  constructor(private readonly credentials = new PlatformCredentialStore()) {}
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    for (const connection of this.storedConnections()) {
      const credential = this.credentials.get(connection.id)
      this.states.set(connection.id, {
        ...connection,
        state: credential ? 'connected' : 'disconnected',
        identity: credential?.userId
          ? { userId: credential.userId, ...(credential.email ? { email: credential.email } : {}) }
          : null,
        credentialPersistence: credential ? (this.credentials.mode() === 'secure' ? 'secure' : 'memory') : 'none',
      })
    }
  }

  list(): PlatformConnectionView[] {
    this.ensureLoaded()
    return [...this.states.values()]
  }

  async add(url: string): Promise<PlatformConnectionView> {
    this.ensureLoaded()
    const parsedUrl = new URL(url)
    const loopback =
      parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '::1'
    if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && loopback)) {
      throw new Error('Platform instances must use HTTPS outside loopback.')
    }
    const normalized = parsedUrl.toString().replace(/\/$/, '')
    const id = randomUUID()
    const state: PlatformConnectionView = {
      id,
      url: normalized,
      name: normalized,
      instanceId: null,
      state: 'connecting',
      identity: null,
      credentialPersistence: 'none',
    }
    this.states.set(id, state)
    try {
      const metadata = await new MaestrlyClient({ baseUrl: normalized }).metadata()
      Object.assign(state, {
        name: metadata.name,
        instanceId: metadata.instanceId,
        desktopClientId: metadata.authentication.desktopClientId,
        state: 'disconnected' as const,
      })
      this.persist()
    } catch (error) {
      Object.assign(state, {
        state: 'unavailable' as const,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return { ...state }
  }

  async beginDeviceAuthorization(connectionId: string, clientId: string): Promise<DeviceAuthorizationView> {
    const connection = this.required(connectionId)
    clientId = clientId.trim() || connection.desktopClientId || ''
    if (!clientId) throw new Error('This instance has no desktop OAuth client. Ask its administrator to register one.')
    const resource = `${connection.url}/api/v1`
    const response = await fetch(`${connection.url}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        scope: 'openid profile email offline_access api:read api:write',
        resource,
      }),
    })
    if (!response.ok) throw new Error(`Device authorization failed (${response.status}).`)
    const body = (await response.json()) as {
      device_code: string
      user_code: string
      verification_uri: string
      verification_uri_complete?: string
      expires_in: number
      interval: number
    }
    const pending: PendingAuthorization = {
      connectionId,
      clientId,
      resource,
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      verificationUriComplete: body.verification_uri_complete,
      expiresIn: body.expires_in,
      interval: body.interval,
      expiresAt: Date.now() + body.expires_in * 1_000,
    }
    this.pending.set(connectionId, pending)
    connection.state = 'authorizing'
    return pending
  }

  async pollDeviceAuthorization(connectionId: string): Promise<PlatformConnectionView> {
    const connection = this.required(connectionId)
    const pending = this.pending.get(connectionId)
    if (!pending || pending.expiresAt <= Date.now()) throw new Error('Device authorization expired.')
    if (pending.lastPolledAt && Date.now() - pending.lastPolledAt < pending.interval * 1_000) return { ...connection }
    pending.lastPolledAt = Date.now()
    const response = await fetch(`${connection.url}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: pending.deviceCode,
        client_id: pending.clientId,
      }),
    })
    const body = (await response.json()) as Record<string, unknown>
    if (!response.ok) {
      if (body.error === 'slow_down') pending.interval += 5
      if (body.error === 'authorization_pending' || body.error === 'slow_down') return { ...connection }
      throw new Error(
        typeof body.error_description === 'string' ? body.error_description : 'Device authorization was denied.'
      )
    }
    if (typeof body.access_token !== 'string')
      throw new Error('Authorization response did not include an access token.')
    const identity = await new HttpTransport({
      baseUrl: connection.url,
      authentication: { headers: () => ({ authorization: `Bearer ${body.access_token}` }) },
    }).request<{ userId: string; email?: string }>('GET', '/api/v1/me')
    const persistence = this.credentials.set(connectionId, {
      clientId: pending.clientId,
      accessToken: body.access_token,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
      expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1_000,
      userId: identity.userId,
      email: identity.email,
    })
    connection.identity = identity
    connection.state = 'connected'
    connection.credentialPersistence = persistence
    connection.error = undefined
    this.pending.delete(connectionId)
    return { ...connection }
  }

  disconnect(connectionId: string): PlatformConnectionView {
    const connection = this.required(connectionId)
    this.credentials.remove(connectionId)
    this.pending.delete(connectionId)
    Object.assign(connection, {
      state: 'disconnected' as const,
      identity: null,
      credentialPersistence: 'none' as const,
    })
    return { ...connection }
  }

  token(connectionId: string): string | null {
    return this.credentials.get(connectionId)?.accessToken ?? null
  }

  async authenticatedToken(connectionId: string): Promise<string | null> {
    const credential = this.credentials.get(connectionId),
      connection = this.required(connectionId)
    if (!credential) return null
    if (credential.expiresAt > Date.now() + 60000) {
      connection.state = 'connected'
      return credential.accessToken
    }
    const refreshToken = credential.refreshToken
    if (!refreshToken) throw new Error('Sign in to the platform again.')
    const pending = this.refreshing.get(connectionId)
    if (pending) return pending
    const refresh = (async () => {
      const response = await fetch(connection.url + '/api/auth/oauth2/token', {
        signal: AbortSignal.timeout(15000),
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: credential.clientId ?? connection.desktopClientId ?? '',
        }),
      })
      if (!response.ok) throw new Error('Platform authorization expired. Sign in again.')
      const result = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number }
      if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in))
        throw new Error('Invalid platform authorization response.')
      if (this.credentials.get(connectionId)?.accessToken !== credential.accessToken)
        throw new Error('Platform account changed while authorization was refreshing.')
      this.credentials.set(connectionId, {
        ...credential,
        accessToken: result.access_token,
        refreshToken: result.refresh_token ?? credential.refreshToken,
        expiresAt: Date.now() + result.expires_in * 1000,
      })
      connection.state = 'connected'
      return result.access_token
    })()
    this.refreshing.set(connectionId, refresh)
    try {
      return await refresh
    } finally {
      if (this.refreshing.get(connectionId) === refresh) this.refreshing.delete(connectionId)
    }
  }
  async listProjects(connectionId: string): Promise<RemotePlatformProject[]> {
    const connection = this.required(connectionId)
    const token = await this.authenticatedToken(connectionId)
    if (!token) throw new Error('Connect to the platform first.')
    const transport = new HttpTransport({
      baseUrl: connection.url,
      authentication: { headers: () => ({ authorization: `Bearer ${token}` }) },
    })
    const organizations = await transport.request<Array<{ id: string; name: string }>>('GET', '/api/v1/organizations')
    const groups = await Promise.all(
      organizations.map(async (organization) => {
        const projects = await transport.request<Array<{ id: string; name: string }>>(
          'GET',
          `/api/v1/organizations/${organization.id}/projects`
        )
        return Promise.all(
          projects.map(async (project) => ({
            organizationId: organization.id,
            organizationName: organization.name,
            projectId: project.id,
            projectName: project.name,
            repositories: await transport.request<
              Array<{ id: string; name: string; baseBranch?: string; cloneUrl?: string }>
            >('GET', `/api/v1/organizations/${organization.id}/projects/${project.id}/repositories`),
            boards: await transport.request<Array<{ id: string; name: string }>>(
              'GET',
              `/api/v1/organizations/${organization.id}/projects/${project.id}/boards`
            ),
          }))
        )
      })
    )
    return groups.flat()
  }

  private required(id: string) {
    this.ensureLoaded()
    const connection = this.states.get(id)
    if (!connection) throw new Error('Platform connection not found.')
    return connection
  }
  private storedConnections(): StoredConnection[] {
    try {
      return JSON.parse(getAppSetting(CONNECTIONS_KEY) ?? '[]') as StoredConnection[]
    } catch {
      return []
    }
  }
  private persist(): void {
    setAppSetting(
      CONNECTIONS_KEY,
      JSON.stringify(
        this.list().map(({ id, url, name, instanceId, desktopClientId }) => ({
          id,
          url,
          name,
          instanceId,
          desktopClientId,
        }))
      )
    )
  }
}

export const platformConnections = new PlatformConnectionService()
