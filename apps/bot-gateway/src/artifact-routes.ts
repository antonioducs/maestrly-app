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
export const BOT_ADMIN_METHODS = [
  'get',
  'list',
  'listFiles',
  'readFile',
  'listComments',
  'addComment',
  'setCommentResolved',
] as const satisfies readonly AdminMethod[]
export const BOT_UPLOAD_METHODS = ['create', 'update'] as const satisfies readonly AdminMethod[]
const invalid = () => new ArtifactHostError('invalid_input', 'Invalid artifact arguments')
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) throw invalid()
  return value as Record<string, unknown>
}
const unavailable = (reason: string): AdminResult => ({
  ok: false,
  error: new ArtifactHostError('host_unavailable', 'Artifact host unavailable', { reason }).toJSON(),
})

async function botArgs(admin: ArtifactAdmin, botId: string, method: AdminMethod, args: unknown[]): Promise<unknown[]> {
  if (method === 'create') {
    const input = object(args[0])
    const origin = object(input.origin)
    return [
      { ...input, owner: { kind: 'bot', id: botId }, origin: { ...origin, workspaceId: null }, createdBy: 'agent' },
    ]
  }
  if (method === 'list') {
    const filter = args[0] === undefined ? {} : object(args[0])
    return [
      {
        ownerKind: 'bot',
        ownerId: botId,
        ...(filter.conversationId !== undefined ? { conversationId: filter.conversationId } : {}),
      },
    ]
  }
  const id = method === 'update' ? object(args[0]).id : args[0]
  if (typeof id !== 'string') throw invalid()
  const artifact = await admin.get(id)
  if (!artifact || artifact.ownerKind !== 'bot' || artifact.ownerId !== botId)
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

/** Authentication is performed by the HTTP boundary before any artifact work. */
export async function artifactRoute(
  ctx: GatewayContext,
  key: string,
  body: unknown,
  caller: { deviceId: string } | { botId: string }
): Promise<unknown> {
  const hosting = ctx.artifacts
  if (key === 'artifactHost' || key === 'artifactHostPatch') {
    if (!hosting) throw new GatewayError('INTERNAL', 'Artifact host is unavailable')
    return key === 'artifactHost' ? hosting.state() : hosting.update(body as FleetArtifactSettingsPatch)
  }
  if ('botId' in caller) {
    const bot = ctx.store.getBot(caller.botId)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    if (!bot.publishArtifacts) return unavailable('bot_off')
  }
  if (!hosting) return unavailable('internal')
  const state = await hosting.state()
  if (!state.settings.enabled) return unavailable('server_off')
  if (state.status.state !== 'running') return unavailable(state.status.problem ?? 'internal')
  const admin = hosting.admin()
  if (!admin) return unavailable('internal')
  const { method, args } = body as FleetArtifactCall
  const upload = key === 'artifactUpload' || key === 'artifactBotUpload'
  return callAdmin(admin, method, args, {
    allowed:
      'botId' in caller
        ? upload
          ? BOT_UPLOAD_METHODS
          : BOT_ADMIN_METHODS
        : upload
          ? UPLOAD_METHODS
          : DEVICE_ADMIN_METHODS,
    guard: (method, args) => {
      if ('botId' in caller) return botArgs(admin, caller.botId, method, args)
      if (method === 'create') return [{ ...object(args[0]), owner: { kind: 'device', id: caller.deviceId } }]
      return args
    },
  })
}
