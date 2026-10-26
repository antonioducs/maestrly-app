import {
  ADMIN_METHODS,
  UPLOAD_METHODS,
  ArtifactHostError,
  callAdmin,
  type AdminMethod,
  type AdminResult,
  type ArtifactAdmin,
} from '@maestrly/artifact-host'
import type { FleetArtifactCall, FleetArtifactSettingsPatch } from '@maestrly/bot-fleet-protocol'
import type { GatewayContext } from './context.js'
import { GatewayError } from './errors.js'

export const DEVICE_ADMIN_METHODS = ADMIN_METHODS.filter(
  (method) => method !== 'snapshot' && !(UPLOAD_METHODS as readonly string[]).includes(method)
)
export const AGENT_ADMIN_METHODS = [
  'get',
  'list',
  'listFiles',
  'readFile',
  'listComments',
  'addComment',
  'setCommentResolved',
  'listResponses',
] as const satisfies readonly AdminMethod[]
export const AGENT_UPLOAD_METHODS = ['create', 'update'] as const satisfies readonly AdminMethod[]
const invalid = () => new ArtifactHostError('invalid_input', 'Invalid artifact arguments')
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) throw invalid()
  return value as Record<string, unknown>
}
const unavailable = (reason: string): AdminResult => ({
  ok: false,
  error: new ArtifactHostError('host_unavailable', 'Artifact host unavailable', { reason }).toJSON(),
})

/**
 * Whose artifacts an agent caller works with: a bot's own, or those of the workspaces environment that hosts the
 * owner's chats, which publishes as a device named after the environment. Only the latter's have projects.
 */
type AgentOwner = { kind: 'bot' | 'device'; id: string }
const agentOwner = (caller: { botId: string } | { environmentId: string }): AgentOwner =>
  'botId' in caller ? { kind: 'bot', id: caller.botId } : { kind: 'device', id: caller.environmentId }

async function agentArgs(
  admin: ArtifactAdmin,
  owner: AgentOwner,
  method: AdminMethod,
  args: unknown[]
): Promise<unknown[]> {
  const projects = owner.kind === 'device'
  if (method === 'create') {
    const input = object(args[0])
    const origin = object(input.origin)
    return [{ ...input, owner, origin: projects ? origin : { ...origin, workspaceId: null }, createdBy: 'agent' }]
  }
  if (method === 'list') {
    const filter = args[0] === undefined ? {} : object(args[0])
    return [
      {
        ownerKind: owner.kind,
        ownerId: owner.id,
        ...(filter.conversationId !== undefined ? { conversationId: filter.conversationId } : {}),
        ...(projects && filter.workspaceId !== undefined ? { workspaceId: filter.workspaceId } : {}),
      },
    ]
  }
  const id = method === 'update' ? object(args[0]).id : args[0]
  if (typeof id !== 'string') throw invalid()
  const artifact = await admin.get(id)
  if (!artifact || artifact.ownerKind !== owner.kind || artifact.ownerId !== owner.id)
    throw new ArtifactHostError('not_found', 'Artifact not found')
  if (method === 'update') return [{ ...object(args[0]), createdBy: 'agent' }]
  if (method === 'addComment') {
    const input = object(args[1])
    if (typeof input.parentId !== 'string' || !input.parentId) throw invalid()
    return [id, { ...input, author: 'agent' }]
  }
  if (method === 'setCommentResolved' && args[2] !== true) throw invalid()
  return args
}

/**
 * Authentication is performed by the HTTP boundary before any artifact work. A device is the owner; a bot and the
 * workspaces environment that hosts the owner's chats are agents, limited to the methods of the agent tools and to
 * their own artifacts.
 */
export async function artifactRoute(
  ctx: GatewayContext,
  key: string,
  body: unknown,
  caller: { deviceId: string } | { botId: string } | { environmentId: string }
): Promise<unknown> {
  const hosting = ctx.artifacts
  if (key === 'artifactHost' || key === 'artifactHostPatch') {
    if (!hosting) throw new GatewayError('INTERNAL', 'Artifact host is unavailable')
    return key === 'artifactHost' ? hosting.state() : hosting.update(body as FleetArtifactSettingsPatch)
  }
  if (!hosting) return unavailable('internal')
  return hosting.withAdmin(async (admin) => {
    if ('botId' in caller) {
      const bot = ctx.store.getBot(caller.botId)
      if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
      if (!bot.publishArtifacts) return unavailable('bot_off')
    }
    const state = await hosting.state()
    if (!state.settings.enabled) return unavailable('server_off')
    if (state.status.state !== 'running') return unavailable(state.status.problem ?? 'internal')
    if (!admin) return unavailable('internal')
    const { method, args } = body as FleetArtifactCall
    const upload = key === 'artifactUpload' || key === 'artifactBotUpload'
    return callAdmin(admin, method, args, {
      allowed:
        'deviceId' in caller
          ? upload
            ? UPLOAD_METHODS
            : DEVICE_ADMIN_METHODS
          : upload
            ? AGENT_UPLOAD_METHODS
            : AGENT_ADMIN_METHODS,
      guard: (method, args) => {
        if (!('deviceId' in caller)) return agentArgs(admin, agentOwner(caller), method, args)
        // A device creates and moves in artifacts only under its own name.
        if (method === 'create' || method === 'importArtifact')
          return [{ ...object(args[0]), owner: { kind: 'device', id: caller.deviceId } }]
        return args
      },
    })
  })
}
