import { ownerMemoryRequestHash } from '../owner-memory.js'
import { createHash } from 'node:crypto'
import {
  FLEET_PROTOCOL_VERSION,
  FLEET_PROVISIONING_FEATURE,
  FLEET_IMAGE_LIMITS,
  normalizePairingCode,
  type FleetCreateBotRequest,
  type FleetPatchBotRequest,
  type FleetSendMessageRequest,
  type FleetAddApiKeyAccountRequest,
  type FleetConversationCallRequest,
} from '@maestrly/bot-fleet-protocol'
import type { ServerResponse } from 'node:http'
import type { GatewayContext } from '../context.js'
import { GatewayError } from '../errors.js'

type Result = { body?: unknown; status?: number; stream?: boolean }
const pendingMessages = new Map<string, { hash: string; promise: Promise<unknown> }>()
function requireBot(ctx: GatewayContext, id: string) {
  const bot = ctx.lifecycle.get(id)
  if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
  return bot
}
function requireProvisioning(ctx: GatewayContext, id: string) {
  const status = ctx.lifecycle.statuses.get(id)
  if (status && !status.capabilities.includes(FLEET_PROVISIONING_FEATURE))
    throw new GatewayError('CONFLICT', 'Restart this bot to update it before configuring it from the Mac.')
}
function recordConfiguration(
  ctx: GatewayContext,
  id: string,
  res: ServerResponse,
  counts: Partial<Record<'accounts' | 'skills' | 'mcpServers' | 'removed', number>>
) {
  if (!Object.values(counts).some((count) => count > 0)) return
  const device = ctx.auth.device(res.req?.headers.authorization)
  ctx.lifecycle.recordActivity(id, 'bot_configured', device.name, {
    accounts: 0,
    skills: 0,
    mcpServers: 0,
    removed: 0,
    ...counts,
  })
}
function number(value: string | null, max: number, defaultValue: number) {
  if (value === null) return defaultValue
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new GatewayError('INVALID_REQUEST', 'Invalid query parameter')
  return Math.min(max, parsed)
}
export async function publicRoute(
  key: string,
  params: Record<string, string>,
  body: any,
  url: URL,
  res: ServerResponse,
  ctx: GatewayContext
): Promise<Result> {
  const id = params.id
  switch (key) {
    // public.ts
    case 'botMemoriesList': {
      requireBot(ctx, id)
      const status = url.searchParams.get('status')
      return {
        body: await ctx.lifecycle
          .instanceFor(id)
          .memoriesList(status === 'archived' || status === 'superseded' || status === 'all' ? status : 'active'),
      }
    }
    case 'botMemoryPatch':
      requireBot(ctx, id)
      return { body: await ctx.lifecycle.instanceFor(id).memoryPatch(params.mid, body) }
    case 'botMemoryDelete':
      requireBot(ctx, id)
      await ctx.lifecycle.instanceFor(id).memoryDelete(params.mid)
      return { status: 204 }

    case 'botRoutineRuns':
      requireBot(ctx, id)
      return { body: { runs: ctx.routines!.runs(id, params.rid) } }
    case 'ownerMemoryList':
      return { body: ctx.ownerMemory!.list(url.searchParams.get('status') === 'active' ? 'active' : 'all') }
    case 'ownerMemoryCreate': {
      const { response, status } = ctx.store.idempotent(
        'ownerMemoryCreate',
        body.idempotencyKey,
        ownerMemoryRequestHash(body),
        () => ({ response: ctx.ownerMemory!.save({ kind: 'owner' }, body), status: 201 })
      )
      return { body: response, status }
    }
    case 'ownerMemoryPatch':
      return { body: ctx.ownerMemory!.patch(params.mid, body) }
    case 'ownerMemoryDelete':
      ctx.ownerMemory!.delete(params.mid)
      return { status: 204 }

    case 'meta':
      return {
        body: {
          protocol: FLEET_PROTOCOL_VERSION,
          gatewayVersion: '0.1.0',
          features: [FLEET_PROVISIONING_FEATURE],
          botImage: ctx.config.botImage,
          botImageVersion: null,
        },
      }
    case 'pair': {
      const normalized = normalizePairingCode(body.code)
      if (!normalized) throw new GatewayError('INVALID_REQUEST', 'Invalid pairing code')
      return { body: ctx.auth.pair(normalized, body.deviceName, res.req?.socket.remoteAddress ?? 'unknown') }
    }
    case 'devicesSelfDelete': {
      const device = ctx.auth.device(res.req?.headers.authorization)
      ctx.store.revokeDevice(device.id)
      await ctx.revokeDevice?.(device.id)
      return { status: 204 }
    }
    case 'host':
      return {
        body: await ctx.host.read(
          [...ctx.lifecycle.resources.values()].reduce((sum, stats) => sum + stats.memoryBytes, 0)
        ),
      }
    case 'botsList':
      return { body: { bots: ctx.lifecycle.list() } }
    case 'botsCreate': {
      const input = body as FleetCreateBotRequest
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      const result = ctx.store.idempotent('botsCreate', input.idempotencyKey, hash, () => ({
        response: ctx.lifecycle.create(input),
        status: 201,
      }))
      return { body: result.response, status: result.status }
    }
    case 'botGet':
      return { body: requireBot(ctx, id) }
    case 'botPatch':
      return { body: await ctx.lifecycle.patch(id, body as FleetPatchBotRequest) }
    case 'botStart':
      return { body: await ctx.lifecycle.start(id) }
    case 'botStop':
      return { body: await ctx.lifecycle.stop(id) }
    case 'botRestart':
      return { body: await ctx.lifecycle.restart(id) }
    case 'botArchive':
      return { body: await ctx.lifecycle.archive(id) }
    case 'archivedBotsList':
      return { body: { bots: await ctx.lifecycle.archivedList() } }
    case 'archivedBotRestore': {
      const bot = ctx.lifecycle.restore(id)
      ctx.routines?.reschedule(id)
      return { body: bot }
    }
    case 'archivedBotDelete':
      await ctx.lifecycle.purge(id)
      return { status: 204 }
    case 'botPause':
      return { body: await ctx.lifecycle.pause(id) }
    case 'botResume':
      return { body: await ctx.lifecycle.resume(id) }
    case 'botCancel':
      await ctx.lifecycle.instanceFor(id).cancelTurn()
      return { status: 204 }
    case 'botSelections':
      return { body: await ctx.lifecycle.instanceFor(id).selections() }
    case 'botApiKeyAccountAdd':
      return {
        body: await ctx.lifecycle.instanceFor(id).addApiKeyAccount(body as FleetAddApiKeyAccountRequest),
        status: 201,
      }
    case 'botAccountsList':
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      return { body: await ctx.lifecycle.instanceFor(id).accountsList() }
    case 'botLoginStart':
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      return { body: await ctx.lifecycle.instanceFor(id).loginStart(body) }
    case 'botLoginGet':
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      return { body: await ctx.lifecycle.instanceFor(id).loginGet(params.lid) }
    case 'botLoginCallback':
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      return { body: await ctx.lifecycle.instanceFor(id).loginCallback(params.lid, body) }
    case 'botLoginCode':
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      return { body: await ctx.lifecycle.instanceFor(id).loginCode(params.lid, body) }
    case 'botSkillsList':
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      return { body: await ctx.lifecycle.instanceFor(id).skillsList() }
    case 'botMcpServersList':
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      return { body: await ctx.lifecycle.instanceFor(id).mcpServersList() }
    case 'botSubscriptionRemove':
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      await ctx.lifecycle.instanceFor(id).subscriptionRemove(params.kind, params.slot)
      recordConfiguration(ctx, id, res, { removed: 1 })
      return { status: 204 }
    case 'botLoginCancel':
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      await ctx.lifecycle.instanceFor(id).loginCancel(params.lid)
      return { status: 204 }
    case 'botSkillRemove':
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      await ctx.lifecycle.instanceFor(id).skillRemove(params.name)
      recordConfiguration(ctx, id, res, { removed: 1 })
      return { status: 204 }
    case 'botMcpServerRemove':
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      await ctx.lifecycle.instanceFor(id).mcpServerRemove(params.sid)
      recordConfiguration(ctx, id, res, { removed: 1 })
      return { status: 204 }
    case 'botAccountsImport': {
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      const result = await ctx.lifecycle.instanceFor(id).accountsImport(body)
      recordConfiguration(ctx, id, res, {
        accounts: result.results.filter((item) => item.outcome === 'added' || item.outcome === 'updated').length,
      })
      return { body: result }
    }
    case 'botMcpServersImport': {
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      const result = await ctx.lifecycle.instanceFor(id).mcpServersImport(body)
      recordConfiguration(ctx, id, res, {
        mcpServers: result.results.filter((item) => item.outcome === 'added' || item.outcome === 'updated').length,
      })
      return { body: result }
    }
    case 'botSkillInstall': {
      requireBot(ctx, id)
      requireProvisioning(ctx, id)
      const result = await ctx.lifecycle.instanceFor(id).skillInstall(body)
      recordConfiguration(ctx, id, res, { skills: result.outcome === 'added' || result.outcome === 'updated' ? 1 : 0 })
      return { body: result }
    }
    case 'botAccountRemove':
      await ctx.lifecycle.instanceFor(id).removeAccount(params.providerId)
      return { status: 204 }
    case 'botTranscript':
      return {
        body: await ctx.lifecycle
          .instanceFor(id)
          .transcript(url.searchParams.get('before') ?? undefined, number(url.searchParams.get('limit'), 500, 200)),
      }
    case 'botImage': {
      const response = await ctx.lifecycle.instanceFor(id).image(params.imageId)
      const mediaType = response.headers.get('content-type')!
      const expected = Number(response.headers.get('content-length'))
      res.writeHead(200, {
        'Content-Type': mediaType,
        'Content-Length': expected,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=86400',
      })
      let size = 0
      try {
        for await (const part of response.body!) {
          size += part.length
          if (size > FLEET_IMAGE_LIMITS.imageReadMaxBytes || size > expected)
            throw new Error('Oversized instance image')
          if (!res.write(part)) await new Promise<void>((resolve) => res.once('drain', resolve))
        }
        if (size !== expected) throw new Error('Truncated instance image')
        res.end()
      } catch {
        res.destroy()
      }
      return { stream: true }
    }
    case 'botMessageSend': {
      const input = body as FleetSendMessageRequest,
        scope = 'botMessageSend:' + id
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      const prior = ctx.store.priorIdempotency(scope, input.idempotencyKey, hash)
      if (prior) return { body: prior.response, status: prior.status }
      const pendingKey = scope + ':' + input.idempotencyKey
      const pending = pendingMessages.get(pendingKey)
      if (pending && pending.hash !== hash)
        throw new GatewayError('CONFLICT', 'Idempotency key used with different request')
      if (pending) return { body: await pending.promise, status: 201 }
      const promise = (async () => {
        const response = await ctx.lifecycle.instanceFor(id).postInput({
          text: input.text,
          attachments: input.attachments,
          idempotencyKey: input.idempotencyKey,
          source: 'owner',
        })
        ctx.store.saveIdempotency(scope, input.idempotencyKey, hash, response, 201)
        ctx.store.markOwnerMessage(id)
        return response
      })()
      pendingMessages.set(pendingKey, { hash, promise })
      try {
        return { body: await promise, status: 201 }
      } finally {
        pendingMessages.delete(pendingKey)
      }
    }
    case 'botMessageDelete':
      await ctx.lifecycle.instanceFor(id).deleteInput(params.inputId)
      return { status: 204 }
    case 'botInteractionResolve':
      await ctx.lifecycle.instanceFor(id).resolveInteraction(params.interactionId, body)
      return { status: 204 }
    case 'botConversationCall':
      return { body: await ctx.lifecycle.instanceFor(id).conversationCall(body as FleetConversationCallRequest) }
    case 'botUiOpen':
      await ctx.lifecycle.instanceFor(id).uiOpen(body)
      return { status: 204 }
    case 'botTakeover': {
      requireBot(ctx, id)
      const device = ctx.auth.device(res.req?.headers.authorization)
      return { body: await ctx.lifecycle.takeover(id, device.id, device.name) }
    }
    case 'botTakeoverRelease': {
      requireBot(ctx, id)
      const device = ctx.auth.device(res.req?.headers.authorization)
      return { body: await ctx.lifecycle.releaseTakeover(id, device.id, body.note, body.continue) }
    }
    case 'botScreenTicket': {
      requireBot(ctx, id)
      const device = ctx.auth.device(res.req?.headers.authorization)
      return { body: ctx.screen!.ticket(id, device.id, body.mode), status: 201 }
    }
    case 'screen':
      throw new GatewayError('INVALID_REQUEST', 'WebSocket upgrade required')
    case 'botRoutinesList':
      requireBot(ctx, id)
      return { body: { routines: ctx.routines!.list(id) } }
    case 'botRoutinesCreate':
      requireBot(ctx, id)
      return { body: ctx.routines!.create(id, body), status: 201 }
    case 'botRoutinePatch':
      requireBot(ctx, id)
      return { body: ctx.routines!.patch(id, params.rid, body) }
    case 'botRoutineDelete':
      requireBot(ctx, id)
      ctx.routines!.delete(id, params.rid)
      return { status: 204 }
    case 'botRoutineRun':
      requireBot(ctx, id)
      return { body: await ctx.routines!.run(id, params.rid) }
    case 'inbox':
      return {
        body: {
          items: ctx.lifecycle.inbox(),
        },
      }
    case 'peerMessages':
      return { body: { messages: ctx.store.peerMessages(number(url.searchParams.get('limit'), 200, 200)) } }
    case 'activity':
      return {
        body: {
          entries: ctx.store.activity(
            number(url.searchParams.get('after'), Number.MAX_SAFE_INTEGER, 0),
            number(url.searchParams.get('limit'), 500, 200)
          ),
          lastSeq: ctx.store.lastActivitySeq(),
        },
      }
    case 'events':
      ctx.events.add(res, ctx.store.lastActivitySeq(), ctx.auth.device(res.req?.headers.authorization).id)
      return { stream: true }
    default:
      throw new GatewayError('NOT_FOUND', 'Route not found')
  }
}
