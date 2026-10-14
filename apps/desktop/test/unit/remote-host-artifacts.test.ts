import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { ADMIN_METHODS, callAdmin, openArtifactHost, type ArtifactHost } from '@maestrly/artifact-host'
import { FLEET_INTERNAL_ROUTES } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { takeHostGatewayAccess } from '../../src/main/remote-host/server/config'
import { createHostSources } from '../../src/main/remote-host/server/host-artifacts'
import type { Conversation } from '../../src/shared/conversation'

const TOKEN = 'A'.repeat(43)
const environment = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  MAESTRLY_SERVER_MODE: '1',
  MAESTRLY_ENVIRONMENT_ID: 'workspaces',
  MAESTRLY_BOT_GATEWAY_URL: 'http://gateway:7444',
  MAESTRLY_HOST_GATEWAY_TOKEN: TOKEN,
  ...extra,
})

describe('takeHostGatewayAccess', () => {
  it('reads the gateway access of a workspaces host and removes the token from the environment', () => {
    const env = environment()
    expect(takeHostGatewayAccess(env)).toEqual({
      gateway: { url: 'http://gateway:7444', token: TOKEN },
      environmentId: 'workspaces',
    })
    expect('MAESTRLY_HOST_GATEWAY_TOKEN' in env).toBe(false)
    expect(env.MAESTRLY_BOT_GATEWAY_URL).toBe('http://gateway:7444')
  })

  it.each([
    ['a bot', { MAESTRLY_BOT_MODE: '1' }],
    ['the desktop', { MAESTRLY_SERVER_MODE: undefined }],
    ['a gateway that gave no token', { MAESTRLY_HOST_GATEWAY_TOKEN: undefined }],
    ['a malformed token', { MAESTRLY_HOST_GATEWAY_TOKEN: 'short' }],
    ['no gateway address', { MAESTRLY_BOT_GATEWAY_URL: undefined }],
    ['no environment', { MAESTRLY_ENVIRONMENT_ID: undefined }],
  ])('has none in %s, and still removes any token', (_case, extra) => {
    const env = environment(extra)
    expect(takeHostGatewayAccess(env)).toBeNull()
    expect('MAESTRLY_HOST_GATEWAY_TOKEN' in env).toBe(false)
  })
})

describe('createHostSources', () => {
  let root: string
  let host: ArtifactHost
  let gateway: Server
  let url: string
  let requests: Array<{ url: string; token: string; method: string }>
  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'host-artifacts-'))
    host = await openArtifactHost({ dataDir: root, port: 0, quotaBytes: 1e6 })
    requests = []
    gateway = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push({ url: req.url!, token: String(req.headers.authorization), method: body.method })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(await callAdmin(host.admin, body.method, body.args, { allowed: ADMIN_METHODS })))
    })
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve())))
    await host.close()
    rmSync(root, { recursive: true, force: true })
  })
  const conversation = { id: 'conversation' } as Conversation

  it('publishes on the gateway as the device its environment is, with no viewer of its own', async () => {
    const sources = createHostSources({ gateway: { url, token: TOKEN }, environmentId: 'workspaces' })
    const source = sources.publishTarget(conversation)
    expect(source.owner).toEqual({ kind: 'device', id: 'workspaces' })
    expect(source.ready()).toBe(true)
    expect([source.viewerBase(), source.publicBase(), source.linkExpiryDays()]).toEqual([null, null, null])
    expect(sources.forConversation(conversation)).toEqual([source])
    expect(sources.managed()).toEqual([source])
    const admin = await source.admin()
    const detail = await admin.create({
      title: 'Remote page',
      owner: source.owner,
      files: [{ path: 'index.html', bytes: new TextEncoder().encode('<h1>Remote</h1>') }],
      origin: { workspaceId: 'ws-1', conversationId: conversation.id, conversationTitle: 'Chat' },
    })
    expect(await admin.get(detail.id)).toMatchObject({ ownerKind: 'device', ownerId: 'workspaces' })
    expect(requests).toEqual([
      { url: FLEET_INTERNAL_ROUTES.artifactBotUpload.path, token: `Bearer ${TOKEN}`, method: 'create' },
      { url: FLEET_INTERNAL_ROUTES.artifactBotAdmin.path, token: `Bearer ${TOKEN}`, method: 'get' },
    ])
  })

  it('tells the agent to update the server when the gateway gave no token', () => {
    const sources = createHostSources(null)
    const unsupported = { code: 'host_unavailable', details: { reason: 'server_unsupported' } }
    expect(() => sources.publishTarget(conversation)).toThrow(expect.objectContaining(unsupported))
    expect(() => sources.forConversation(conversation)).toThrow(expect.objectContaining(unsupported))
    expect(sources.managed()).toEqual([])
    expect(requests).toEqual([])
  })
})
