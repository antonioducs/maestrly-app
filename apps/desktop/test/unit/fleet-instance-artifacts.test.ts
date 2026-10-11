import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { ADMIN_METHODS, callAdmin, openArtifactHost, type ArtifactHost } from '@maestrly/artifact-host'
import { FLEET_INTERNAL_ROUTES, FLEET_PROTOCOL_HEADER, FLEET_PROTOCOL_VERSION } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { gatewayRequest } from '../../src/main/fleet/instance/gateway-client'
import { botArtifactSource, createBotSources } from '../../src/main/fleet/instance/artifacts'
import { BotRuntime } from '../../src/main/fleet/instance/runtime'
import type { Conversation } from '../../src/shared/conversation'

let root: string
let host: ArtifactHost
let gateway: Server
let runtime: { botId: string; artifactsEnabled: boolean; gatewayConfig: { url: string; token: string } | null }
let reply: { status: number; body: unknown } | null
let requests: Array<{ url: string; token: string; protocol: string; body: { method: string; args: unknown[] } }>
beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bot-artifacts-'))
  host = await openArtifactHost({ dataDir: root, port: 0, quotaBytes: 1e6 })
  reply = null
  requests = []
  gateway = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({
      url: req.url!,
      token: String(req.headers.authorization),
      protocol: String(req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()]),
      body,
    })
    res.writeHead(reply?.status ?? 200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(reply?.body ?? (await callAdmin(host.admin, body.method, body.args, { allowed: ADMIN_METHODS })))
    )
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const address = gateway.address() as { port: number }
  runtime = {
    botId: 'synthetic-bot',
    artifactsEnabled: true,
    gatewayConfig: { url: `http://127.0.0.1:${address.port}`, token: 'synthetic-token' },
  }
})
afterEach(async () => {
  await new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve())))
  await host.close()
  rmSync(root, { recursive: true, force: true })
})
const source = () => botArtifactSource(runtime as BotRuntime)
const unavailable = { code: 'host_unavailable', details: { reason: 'server_unreachable' } }
const botOff = { code: 'host_unavailable', details: { reason: 'bot_off' } }
it('round trips upload bytes and host detail through authenticated JSON routes', async () => {
  const s = source()!
  expect(s.owner).toEqual({ kind: 'bot', id: runtime.botId })
  expect([s.viewerBase(), s.publicBase(), s.linkExpiryDays()]).toEqual([null, null, null])
  const admin = await s.admin()
  const bytes = new TextEncoder().encode('<h1>Olá</h1>')
  const detail = await admin.create({
    title: 'Bot artifact',
    owner: s.owner,
    files: [{ path: 'index.html', bytes }],
    origin: { workspaceId: null, conversationId: 'primary', conversationTitle: 'Bot chat' },
  })
  expect(await admin.get(detail.id)).toEqual(await host.admin.get(detail.id))
  expect((await admin.readFile(detail.id, 1, 'index.html'))?.bytes).toEqual(bytes)
  expect(requests[0]).toMatchObject({
    url: FLEET_INTERNAL_ROUTES.artifactBotUpload.path,
    token: 'Bearer synthetic-token',
    protocol: String(FLEET_PROTOCOL_VERSION),
    body: { method: 'create' },
  })
  expect(requests[0].body.args).toMatchObject([
    { files: [{ bytes: { $bytes: Buffer.from(bytes).toString('base64') } }] },
  ])
  expect(requests[1].url).toBe(FLEET_INTERNAL_ROUTES.artifactBotAdmin.path)
  await expect(
    admin.update({
      id: detail.id,
      baseVersion: 99,
      change: { kind: 'replace', files: [{ path: 'index.html', bytes }] },
    })
  ).rejects.toMatchObject({ code: 'version_conflict' })
})
it('preserves serialized bot-disabled errors', async () => {
  reply = { status: 200, body: { ok: false, error: { ...botOff, message: 'Disabled by owner' } } }
  await expect((await source()!.admin()).list()).rejects.toMatchObject({ ...botOff, message: 'Disabled by owner' })
})
it.each([
  { status: 401, body: { code: 'UNAUTHORIZED', message: 'Unauthorized' } },
  { status: 409, body: { code: 'PROTOCOL_INCOMPATIBLE', message: 'Update gateway' } },
  { status: 200, body: { wrong: true } },
  { status: 200, body: { ok: true, value: { $bytes: 'invalid base64' } } },
  { status: 200, body: { ok: true } },
  { status: 200, body: { ok: false, error: { code: 'nonsense', message: 'Bad error' } } },
])('maps invalid transport responses to unavailable: %j', async (value) => {
  reply = value
  await expect((await source()!.admin()).list()).rejects.toMatchObject(unavailable)
})
it('rechecks flags and token for acquired clients', async () => {
  const s = source()!
  const admin = await s.admin()
  runtime.artifactsEnabled = false
  expect(source()).toBeNull()
  expect(s.ready()).toBe(false)
  await expect(s.admin()).rejects.toMatchObject(botOff)
  await expect(admin.list()).rejects.toMatchObject(botOff)
  runtime.artifactsEnabled = true
  runtime.gatewayConfig = null
  expect(source()).toBeNull()
  await expect(admin.list()).rejects.toMatchObject(botOff)
  runtime.gatewayConfig = { url: 'http://127.0.0.1:1', token: 'rotated' }
  await expect(admin.list()).rejects.toMatchObject(unavailable)
  expect(requests).toHaveLength(0)
})
it('scopes source lookup to the primary conversation and has no managed view', () => {
  const sources = createBotSources((id) => (id === 'primary' ? source() : null))
  const primary = { id: 'primary' } as Conversation
  const other = { id: 'other' } as Conversation
  expect(sources.publishTarget(primary).owner.id).toBe(runtime.botId)
  expect(sources.forConversation(primary)).toHaveLength(1)
  expect(() => sources.publishTarget(other)).toThrow(expect.objectContaining(botOff))
  expect(() => sources.forConversation(other)).toThrow(expect.objectContaining(botOff))
  expect(sources.managed()).toEqual([])
})
it('defaults runtime authorization off and reads the current profile', () => {
  const get = Object.getOwnPropertyDescriptor(BotRuntime.prototype, 'artifactsEnabled')!.get!
  const state = { stored: null as unknown }
  expect(get.call(state)).toBe(false)
  state.stored = { profile: { gateway: { artifactsEnabled: true } } }
  expect(get.call(state)).toBe(true)
  state.stored = { profile: { gateway: {} } }
  expect(get.call(state)).toBe(false)
})

it('uses the latest token even for an acquired client', async () => {
  const admin = await source()!.admin()
  runtime.gatewayConfig!.token = 'synthetic-rotated-token'
  await admin.list()
  expect(requests[0].token).toBe('Bearer synthetic-rotated-token')
})
it.each([403, 429])('describes artifact HTTP failures without peer advice: %s', async (status) => {
  reply = { status, body: {} }
  await expect(
    gatewayRequest(runtime.gatewayConfig!, 'artifactBotAdmin', { method: 'list', args: [] })
  ).rejects.toThrow(`Gateway rejected the artifact request (HTTP ${status})`)
})
