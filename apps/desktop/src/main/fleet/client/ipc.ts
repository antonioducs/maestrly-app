import { registerFleetEnvironmentSettingsIpc } from './environment-settings-ipc'
import { app } from 'electron'
import { validateAttachmentBytes } from '../instance/incoming-attachments'
import { registerFleetProvisioningIpc } from './provisioning/ipc'
import { z } from 'zod'
import {
  FLEET_BOT_MOVE_FEATURE,
  FLEET_CANCEL_CONVERSATION_QUERY,
  FLEET_PARALLEL_TURNS_FEATURE,
  FLEET_DICTATION_FEATURE,
  FLEET_PHONES_FEATURE,
  FLEET_DEVICES_FEATURE,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_WORKSPACES_ENVIRONMENTS_FEATURE,
  FLEET_WORKSPACES_HOST_FEATURE,
  fleetCpuLimitSchema,
  fleetIdleStopMinutesSchema,
  fleetMemoryLimitSchema,
  fleetNameSchema,
  fleetTintSchema,
  fleetBotIdSchema,
  fleetFileIdSchema,
  fleetEnvironmentIdSchema,
  fleetPatchEnvironmentRequestSchema,
  fleetEnvironmentUpdateRequestSchema,
  fleetOwnerMemoryCreateRequestSchema,
  fleetOwnerMemoryPatchRequestSchema,
  fleetBotMemoryPatchRequestSchema,
  fleetConversationOpSchema,
  fleetConversationCallRequestSchema,
  fleetBotMoveRequestSchema,
  fleetCreateBotRequestSchema,
  fleetCreateRoutineRequestSchema,
  fleetInteractionResolutionSchema,
  fleetPatchBotRequestSchema,
  fleetPatchRoutineRequestSchema,
  fleetTakeoverReleaseRequestSchema,
  fleetUiOpenRequestSchema,
  fleetSendMessageRequestSchema,
  fleetEditMessageRequestSchema,
  FLEET_FILES_FEATURE,
  FLEET_FILE_LIMITS,
  FLEET_MESSAGE_EDIT_FEATURE,
  FLEET_REASONING_QUERY,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  FLEET_ROUTINE_RUN_LIMITS,
  FLEET_PEER_CONVERSATIONS_FEATURE,
  fleetPeerThreadSettingsSchema,
  fleetPeerThreadPatchRequestSchema,
  fleetAddApiKeyAccountRequestSchema,
  fleetRoutineRunSettingsSchema,
} from '@maestrly/bot-fleet-protocol'
import type { IpcRegistrar } from '../../ipc-registrar'
import { isHeadlessInstance } from '../../remote-host/server/config'
import { FLEET_ATTENDED_FILES_MAX } from '../../../shared/fleet-downloads'
import { FleetClientError } from './api'
import { setAttendedFleetFiles } from './download-notices'
import { type FleetClientService, fleetClientService } from './service'
import { type FleetIpcRegistrar, fleetIpcRegistrar } from './scoped-ipc'
import { FLEET_SERVER_UNKNOWN, isFleetServerId } from '../../../shared/fleet-servers'
import { getDictationEngine, getDictationKey } from '../../dictation/settings'
import {
  FLEET_BOT_MOVE_UNSUPPORTED,
  FLEET_DEVICES_UNSUPPORTED,
  FLEET_EDIT_CONFLICT,
  FLEET_EDIT_UNSUPPORTED,
  FLEET_RUN_CONFLICT,
  FLEET_RUNS_UNSUPPORTED,
  FLEET_PEER_THREAD_CONFLICT,
  FLEET_PEER_THREADS_UNSUPPORTED,
  FLEET_SCOPES_UNSUPPORTED,
} from '../../../shared/fleet-targets'
import {
  provisioningRoute,
  requireEnvironmentUpdates,
  requireEnvironments,
  requireRuntimeUpdates,
  resolveProvisioningTarget,
  resolveScreenTarget,
  screenTicketError,
} from './targets'

const id = fleetBotIdSchema
const deviceIdSchema = z.string().min(1).max(128)
const environmentId = fleetEnvironmentIdSchema
/** A new workspaces environment, as the renderer asks for it; omitted settings take the server's defaults. */
const createWorkspacesInput = z
  .object({
    name: fleetNameSchema.optional(),
    memoryLimitBytes: fleetMemoryLimitSchema.nullable().optional(),
    cpuLimit: fleetCpuLimitSchema.nullable().optional(),
    idleStopMinutes: fleetIdleStopMinutesSchema.nullable().optional(),
    tint: fleetTintSchema.nullable().optional(),
  })
  .strict()
const opaqueId = z.string().min(1).max(256)
const optionalLimit = z.number().int().min(1).max(500).optional()
const outgoingAttachments = z
  .array(
    z
      .object({
        kind: z.enum(['image', 'pdf', 'text']).default('image'),
        name: z.string().min(1).max(200),
        mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain']),
        data: z.instanceof(Uint8Array).refine((data) => data.byteLength <= FLEET_FILE_LIMITS.pdfMaxBytes),
      })
      .strict()
  )
  .max(FLEET_FILE_LIMITS.attachmentsMax)
  .refine(
    (items) => items.reduce((sum, item) => sum + item.data.byteLength, 0) <= FLEET_FILE_LIMITS.attachmentsTotalMaxBytes
  )
  .refine((items) => items.filter((item) => item.kind === 'pdf').length <= FLEET_FILE_LIMITS.pdfsMax)
const imageId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/)
/** The files a window shows, each with its server; each send replaces that window's whole list. */
const attendedFiles = z
  .array(z.object({ serverId: z.string().refine(isFleetServerId), botId: id, fileId: fleetFileIdSchema }).strict())
  .max(FLEET_ATTENDED_FILES_MAX)
const connectInput = z
  .object({
    url: z.string().min(1).max(2048),
    code: z.string().min(1).max(64),
    deviceName: z.string().min(1).max(160).optional(),
  })
  .strict()
// A refined schema cannot `.omit()` the key: the renderer's fields are checked with the key the main process picks.
const createBotInput = z.record(z.string(), z.unknown())
/** Where a bot moves: an existing environment or a new one by its name; the request schema checks it is one of them. */
const moveInput = z
  .object({
    environmentId: environmentId.optional(),
    newEnvironment: z.object({ name: fleetNameSchema }).strict().optional(),
  })
  .strict()
const createRoutine = fleetCreateRoutineRequestSchema.omit({ idempotencyKey: true })
const action = z.enum(['start', 'stop', 'restart', 'archive', 'pause', 'resume', 'cancel'])
/** The conversation whose turn a cancel stops: the bot's own, or a side conversation's id. */
const cancelConversation = z.union([z.literal('primary'), z.string().regex(/^[A-Za-z0-9-]{1,80}$/)])
const actionRoute = {
  start: 'botStart',
  stop: 'botStop',
  restart: 'botRestart',
  archive: 'botArchive',
  pause: 'botPause',
  resume: 'botResume',
  cancel: 'botCancel',
} as const
// Lifecycle actions act on every bot of the environment; archiving keeps its files and bots on the server.
const environmentAction = z.enum(['start', 'stop', 'restart', 'archive'])
const environmentActionRoute = {
  start: 'environmentStart',
  stop: 'environmentStop',
  restart: 'environmentRestart',
  archive: 'environmentArchive',
} as const
// `idle` waits for the environment's bots and answers at once; `now` restarts it, interrupting them.
const updateWhen = fleetEnvironmentUpdateRequestSchema.shape.when

/** The registrar of channels that name their server; until servers are listed, the one paired server answers. */
export function fleetScopedRegistrar(reg: IpcRegistrar): FleetIpcRegistrar {
  return fleetIpcRegistrar(reg, (serverId) => {
    if (serverId !== fleetClientService.serverId || !fleetClientService.view()) throw new Error(FLEET_SERVER_UNKNOWN)
    return fleetClientService
  })
}

export function registerFleetClientIpc(reg: IpcRegistrar): void {
  const scoped = fleetScopedRegistrar(reg)
  registerFleetProvisioningIpc(reg, scoped)
  registerFleetEnvironmentSettingsIpc(scoped)
  if (!isHeadlessInstance()) {
    fleetClientService.start()
    app.once('will-quit', () => fleetClientService.stop())
  }
  reg.handle('fleet:servers', () => fleetClientService.servers())
  scoped.handle('fleet:getConnection', (fleet) => fleet.getConnection())
  // Pairs this computer with a server; the server named, if any, is the one paired again.
  reg.mhandle('fleet:connect', async (_event, input: unknown, _serverId: unknown = undefined) => {
    await fleetClientService.connect(connectInput.parse(input))
    return fleetClientService.view()
  })
  scoped.mhandle('fleet:disconnect', (fleet) => fleet.disconnect())
  // A one-use code for another device (a phone), shown as a QR code; older gateways cannot create one.
  scoped.mhandle('fleet:createPairing', async (fleet) => {
    if (!fleet.hasFeature(FLEET_PHONES_FEATURE))
      throw new FleetClientError('PROTOCOL_INCOMPATIBLE', 426, 'Update the bot server to pair a phone')
    return fleet.call('pairingsCreate', { body: {} })
  })
  // The devices paired with the server, phones and computers; older gateways list them only in their CLI.
  scoped.handle('fleet:devices', (fleet) => {
    if (!fleet.hasFeature(FLEET_DEVICES_FEATURE)) throw new Error(FLEET_DEVICES_UNSUPPORTED)
    return fleet.call('devicesList')
  })
  scoped.mhandle('fleet:revokeDevice', (fleet, _event, deviceId: unknown) => {
    if (!fleet.hasFeature(FLEET_DEVICES_FEATURE)) throw new Error(FLEET_DEVICES_UNSUPPORTED)
    return fleet.call('deviceRevoke', { params: { deviceId: deviceIdSchema.parse(deviceId) } })
  })
  // The server's speech-to-text key, which its phones dictate through; null from servers that predate it.
  const requireDictation = (fleet: FleetClientService) => {
    if (!fleet.hasFeature(FLEET_DICTATION_FEATURE))
      throw new FleetClientError('PROTOCOL_INCOMPATIBLE', 426, 'Update the bot server to dictate from the phone')
  }
  scoped.handle('fleet:dictation', (fleet) =>
    fleet.hasFeature(FLEET_DICTATION_FEATURE) ? fleet.call('dictationGet') : null
  )
  // Sends this computer's dictation engine and key, so phones dictate with the same one.
  scoped.mhandle('fleet:dictationUseLocal', (fleet) => {
    requireDictation(fleet)
    const engine = getDictationEngine()
    const key = engine === 'local' ? null : getDictationKey(engine)
    if (engine === 'local' || !key) throw new Error('No dictation key on this computer')
    return fleet.call('dictationKeySet', { body: { provider: engine, key } })
  })
  scoped.mhandle('fleet:dictationRemove', (fleet) => {
    requireDictation(fleet)
    return fleet.call('dictationKeyDelete')
  })
  scoped.handle('fleet:getSnapshot', (fleet) => fleet.getSnapshot())
  scoped.mhandle('fleet:refresh', (fleet) => fleet.refresh())
  scoped.handle('fleet:getHost', (fleet) => fleet.call('host'))
  scoped.handle('fleet:listBots', (fleet) => fleet.call('botsList'))
  scoped.handle('fleet:getBot', (fleet, _event, botId: unknown) =>
    fleet.call('botGet', { params: { id: id.parse(botId) } })
  )
  scoped.mhandle('fleet:createBot', (fleet, _event, input: unknown) => {
    const body = fleetCreateBotRequestSchema.parse({
      ...createBotInput.parse(input),
      idempotencyKey: fleet.idempotencyKey(),
    })
    // An older gateway drops both fields and gives the bot its own container: never let a join silently do that.
    if (body.environmentId !== undefined || body.environment !== undefined) requireEnvironments(fleet)
    return fleet.call('botsCreate', { body })
  })
  scoped.mhandle('fleet:updateBot', (fleet, _event, botId: unknown, patch: unknown) =>
    fleet.call('botPatch', { params: { id: id.parse(botId) }, body: fleetPatchBotRequestSchema.parse(patch) })
  )
  scoped.mhandle('fleet:botAction', (fleet, _event, botId: unknown, rawAction: unknown) =>
    fleet.call(actionRoute[action.parse(rawAction)], { params: { id: id.parse(botId) } })
  )
  // One conversation's turn (`parallel-turns`): `primary` for the bot's own, or a side conversation's id. A gateway
  // that predates them stops the bot's only turn.
  scoped.mhandle('fleet:cancelTurn', (fleet, _event, botId: unknown, conversation: unknown) =>
    fleet.call('botCancel', {
      params: { id: id.parse(botId) },
      ...(fleet.hasFeature(FLEET_PARALLEL_TURNS_FEATURE)
        ? { query: { [FLEET_CANCEL_CONVERSATION_QUERY]: cancelConversation.parse(conversation) } }
        : {}),
    })
  )
  // The gateway answers at once; the move's progress arrives in the bot's `move`, through the events already followed.
  scoped.mhandle('fleet:moveBot', (fleet, _event, botId: unknown, input: unknown) => {
    if (!fleet.hasFeature(FLEET_BOT_MOVE_FEATURE)) throw new Error(FLEET_BOT_MOVE_UNSUPPORTED)
    const body = fleetBotMoveRequestSchema.parse({ ...moveInput.parse(input), idempotencyKey: fleet.idempotencyKey() })
    return fleet.call('botMove', { params: { id: id.parse(botId) }, body })
  })
  scoped.handle('fleet:botMove', (fleet, _event, botId: unknown) => {
    if (!fleet.hasFeature(FLEET_BOT_MOVE_FEATURE)) throw new Error(FLEET_BOT_MOVE_UNSUPPORTED)
    return fleet.call('botMoveGet', { params: { id: id.parse(botId) } })
  })
  scoped.handle('fleet:listArchivedBots', (fleet) =>
    fleet.call('archivedBotsList', { query: { separateEnvironments: 1 } })
  )
  scoped.mhandle('fleet:restoreArchivedBot', (fleet, _event, botId: unknown) =>
    fleet.call('archivedBotRestore', { params: { id: id.parse(botId) } })
  )
  scoped.mhandle('fleet:deleteArchivedBot', (fleet, _event, botId: unknown) =>
    fleet.call('archivedBotDelete', { params: { id: id.parse(botId) } })
  )
  scoped.mhandle('fleet:environmentAction', (fleet, _event, rawId: unknown, rawAction: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    const route = environmentActionRoute[environmentAction.parse(rawAction)]
    requireEnvironments(fleet)
    return fleet.call(route, { params })
  })
  // A server hosts the owner's chats and workspaces in environments of their own kind, with no bots: one per scope of
  // the owner's work on servers with `workspaces-environments`, one in all on older ones.
  scoped.mhandle('fleet:createWorkspaces', (fleet, _event, raw: unknown) => {
    if (!fleet.hasFeature(FLEET_WORKSPACES_HOST_FEATURE))
      throw new FleetClientError('INVALID_REQUEST', 400, 'Update the server to run workspaces on it.')
    const input = createWorkspacesInput.parse(raw ?? {})
    // An older server drops the settings it does not know; they are not sent, so none is silently lost.
    const scoped = fleet.hasFeature(FLEET_WORKSPACES_ENVIRONMENTS_FEATURE)
    return fleet.call('environmentsCreate', {
      body: {
        name: input.name ?? 'Workspaces',
        memoryLimitBytes: input.memoryLimitBytes ?? null,
        kind: 'workspaces',
        ...(scoped
          ? {
              cpuLimit: input.cpuLimit ?? null,
              idleStopMinutes: input.idleStopMinutes ?? null,
              tint: input.tint ?? null,
            }
          : {}),
        idempotencyKey: fleet.idempotencyKey(),
      },
    })
  })
  scoped.mhandle('fleet:environmentUpdate', (fleet, _event, rawId: unknown, rawWhen: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    const body = { when: updateWhen.parse(rawWhen) }
    requireEnvironmentUpdates(fleet)
    return fleet.call('environmentUpdate', { params, body })
  })
  scoped.mhandle('fleet:environmentUpdateCancel', (fleet, _event, rawId: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    requireEnvironmentUpdates(fleet)
    return fleet.call('environmentUpdateCancel', { params })
  })
  // Answers at once: the environment checks in the background and reports the results in its runtimes.
  scoped.mhandle('fleet:environmentRuntimesCheck', (fleet, _event, rawId: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    requireRuntimeUpdates(fleet)
    return fleet.call('environmentRuntimesCheck', { params })
  })
  scoped.mhandle('fleet:patchEnvironment', (fleet, _event, rawId: unknown, patch: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    const body = fleetPatchEnvironmentRequestSchema.parse(patch)
    requireEnvironments(fleet)
    // An older server drops these fields, and then refuses or ignores the change.
    const scoped = ['cpuLimit', 'idleStopMinutes', 'tint', 'hostFolder'] as const
    if (scoped.some((key) => body[key] !== undefined) && !fleet.hasFeature(FLEET_WORKSPACES_ENVIRONMENTS_FEATURE))
      throw new FleetClientError('INVALID_REQUEST', 400, FLEET_SCOPES_UNSUPPORTED)
    return fleet.call('environmentPatch', { params, body })
  })
  // Listed on demand, like archived bots; a gateway without environments has none.
  scoped.handle('fleet:listArchivedEnvironments', async (fleet) =>
    fleet.hasFeature(FLEET_ENVIRONMENTS_FEATURE) ? fleet.call('archivedEnvironmentsList') : { environments: [] }
  )
  scoped.mhandle('fleet:restoreArchivedEnvironment', (fleet, _event, rawId: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    requireEnvironments(fleet)
    return fleet.call('archivedEnvironmentRestore', { params })
  })
  scoped.mhandle('fleet:deleteArchivedEnvironment', (fleet, _event, rawId: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    requireEnvironments(fleet)
    return fleet.call('archivedEnvironmentDelete', { params })
  })
  scoped.mhandle('fleet:environmentUiOpen', (fleet, _event, rawId: unknown, target: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    const body = fleetUiOpenRequestSchema.parse({ target })
    requireEnvironments(fleet)
    return fleet.call('environmentUiOpen', { params, body })
  })
  scoped.handle('fleet:listSelections', (fleet, _event, botId: unknown) =>
    fleet.call('botSelections', { params: { id: id.parse(botId) } })
  )
  // The models of an environment's accounts, for its default compaction model.
  scoped.handle('fleet:environmentSelections', (fleet, _event, rawId: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    requireEnvironments(fleet)
    return fleet.call('environmentSelections', { params })
  })
  scoped.mhandle('fleet:add-api-key-account', (fleet, _event, target: unknown, input: unknown) => {
    const body = fleetAddApiKeyAccountRequestSchema.parse(input)
    const route = provisioningRoute(resolveProvisioningTarget(fleet, target), 'apiKeyAccountAdd')
    return fleet.call(route.key, { params: route.params, body })
  })
  scoped.mhandle('fleet:remove-account', (fleet, _event, target: unknown, providerId: unknown) => {
    const account = { providerId: opaqueId.parse(providerId) }
    const route = provisioningRoute(resolveProvisioningTarget(fleet, target), 'accountRemove', account)
    return fleet.call(route.key, { params: route.params })
  })
  scoped.handle('fleet:getTranscript', (fleet, _event, botId: unknown, before: unknown, limit: unknown) =>
    fleet.call('botTranscript', {
      params: { id: id.parse(botId) },
      query: {
        before: z.string().max(256).nullable().optional().parse(before),
        limit: optionalLimit.parse(limit),
        // This app reads `reasoning` items; an older gateway ignores the parameter and sends none.
        [FLEET_REASONING_QUERY]: 1,
      },
    })
  )
  /** An owner's message, as the composer sends it; with `citation`, it refers to one of the bot's routine runs. */
  const ownerMessage = (fleet: FleetClientService, text: unknown, attachments: unknown, citation?: string) => {
    const admitted = outgoingAttachments.parse(attachments)
    try {
      for (const attachment of admitted) validateAttachmentBytes(attachment, attachment.data)
    } catch {
      throw new Error('FLEET_ATTACHMENT_INVALID')
    }
    return fleetSendMessageRequestSchema.parse({
      text: z.string().max(16_000).parse(text),
      attachments: admitted.map((item) => ({
        kind: item.kind,
        name: item.name,
        mediaType: item.mediaType,
        dataBase64: Buffer.from(item.data).toString('base64'),
      })),
      idempotencyKey: fleet.idempotencyKey(),
      ...(citation ? { citation: { runId: citation } } : {}),
    })
  }
  /**
   * Checks the bot can take documents, when the message has some. A gateway without them throws at once, as every
   * invalid input does; the bot's answer settles the promise.
   */
  const requireFiles = (
    fleet: FleetClientService,
    botId: string,
    input: { attachments: Array<{ kind?: string }> }
  ): Promise<void> => {
    if (!input.attachments.some((attachment) => attachment.kind !== 'image')) return Promise.resolve()
    if (!fleet.hasFeature(FLEET_FILES_FEATURE)) throw new Error('FLEET_FILES_UNSUPPORTED')
    return fleet.call('botGet', { params: { id: botId } }).then((bot) => {
      if (!bot.capabilities.includes(FLEET_FILES_FEATURE)) throw new Error('FLEET_FILES_UNSUPPORTED')
    })
  }
  /** The bot after checking it and its gateway keep routine runs in conversations of their own. */
  const requireRuns = async (fleet: FleetClientService, botId: string) => {
    if (!fleet.hasFeature(FLEET_ROUTINE_CONVERSATIONS_FEATURE)) throw new Error(FLEET_RUNS_UNSUPPORTED)
    const bot = await fleet.call('botGet', { params: { id: botId } })
    if (!bot.capabilities.includes(FLEET_ROUTINE_CONVERSATIONS_FEATURE)) throw new Error(FLEET_RUNS_UNSUPPORTED)
  }
  /** A run's conversation that is working or gone answers 409: the renderer says so. */
  const runConflict = (error: unknown): never => {
    if (error instanceof FleetClientError && error.status === 409) throw new Error(FLEET_RUN_CONFLICT)
    throw error
  }
  scoped.mhandle(
    'fleet:sendMessage',
    (fleet, _event, botId: unknown, text: unknown, attachments: unknown = [], citation: unknown = null) => {
      const params = { id: id.parse(botId) }
      const run = citation === null ? undefined : opaqueId.parse(citation)
      const input = ownerMessage(fleet, text, attachments, run)
      if (run && !fleet.hasFeature(FLEET_ROUTINE_CONVERSATIONS_FEATURE)) throw new Error(FLEET_RUNS_UNSUPPORTED)
      return requireFiles(fleet, params.id, input).then(() => fleet.call('botMessageSend', { params, body: input }))
    }
  )
  // A bot's routine runs, each in a conversation of its own (`routine-conversations`).
  scoped.handle(
    'fleet:listRuns',
    (fleet, _event, botId: unknown, before: unknown = null, routineId: unknown = null) => {
      if (!fleet.hasFeature(FLEET_ROUTINE_CONVERSATIONS_FEATURE)) throw new Error(FLEET_RUNS_UNSUPPORTED)
      return fleet.call('botRuns', {
        params: { id: id.parse(botId) },
        query: {
          before: opaqueId.nullable().parse(before) ?? undefined,
          routineId: opaqueId.nullable().parse(routineId) ?? undefined,
          limit: FLEET_ROUTINE_RUN_LIMITS.pageMax,
        },
      })
    }
  )
  scoped.handle('fleet:getRun', (fleet, _event, botId: unknown, runId: unknown) =>
    fleet.call('botRunGet', { params: { id: id.parse(botId), runId: opaqueId.parse(runId) } })
  )
  scoped.handle(
    'fleet:getRunTranscript',
    (fleet, _event, botId: unknown, runId: unknown, before: unknown, limit: unknown) =>
      fleet.call('botRunTranscript', {
        params: { id: id.parse(botId), runId: opaqueId.parse(runId) },
        query: {
          before: z.string().max(256).nullable().optional().parse(before),
          limit: optionalLimit.parse(limit),
          [FLEET_REASONING_QUERY]: 1,
        },
      })
  )
  scoped.mhandle('fleet:pinRun', (fleet, _event, botId: unknown, runId: unknown, pinned: unknown) =>
    fleet.call('botRunPatch', {
      params: { id: id.parse(botId), runId: opaqueId.parse(runId) },
      body: { pinned: z.boolean().parse(pinned) },
    })
  )
  scoped.mhandle('fleet:deleteRunConversation', (fleet, _event, botId: unknown, runId: unknown) =>
    fleet
      .call('botRunConversationDelete', { params: { id: id.parse(botId), runId: opaqueId.parse(runId) } })
      .catch(runConflict)
  )
  scoped.mhandle(
    'fleet:sendRunMessage',
    (fleet, _event, botId: unknown, runId: unknown, text: unknown, attachments: unknown = []) => {
      const params = { id: id.parse(botId), runId: opaqueId.parse(runId) }
      const input = ownerMessage(fleet, text, attachments)
      return requireRuns(fleet, params.id)
        .then(() => requireFiles(fleet, params.id, input))
        .then(() => fleet.call('botRunMessageSend', { params, body: input }).catch(runConflict))
    }
  )
  scoped.mhandle('fleet:setRunSettings', (fleet, _event, botId: unknown, settings: unknown) => {
    if (!fleet.hasFeature(FLEET_ROUTINE_CONVERSATIONS_FEATURE)) throw new Error(FLEET_RUNS_UNSUPPORTED)
    return fleet.call('botRunSettings', {
      params: { id: id.parse(botId) },
      body: fleetRoutineRunSettingsSchema.parse(settings),
    })
  })
  // A bot's conversations with other bots, each in a conversation of its own (`peer-conversations`).
  const requireThreads = (fleet: FleetClientService) => {
    if (!fleet.hasFeature(FLEET_PEER_CONVERSATIONS_FEATURE)) throw new Error(FLEET_PEER_THREADS_UNSUPPORTED)
  }
  /** A thread's conversation that is working or gone answers 409: the renderer says so. */
  const threadConflict = (error: unknown): never => {
    if (error instanceof FleetClientError && error.status === 409) throw new Error(FLEET_PEER_THREAD_CONFLICT)
    throw error
  }
  const threadParams = (botId: unknown, threadId: unknown) => ({
    id: id.parse(botId),
    threadId: opaqueId.parse(threadId),
  })
  scoped.handle('fleet:listPeerThreads', (fleet, _event, botId: unknown) => {
    requireThreads(fleet)
    return fleet.call('botPeerThreads', { params: { id: id.parse(botId) } })
  })
  scoped.handle(
    'fleet:getPeerThreadTranscript',
    (fleet, _event, botId: unknown, threadId: unknown, before: unknown, limit: unknown) => {
      requireThreads(fleet)
      return fleet.call('botPeerThreadTranscript', {
        params: threadParams(botId, threadId),
        query: {
          before: z.string().max(256).nullable().optional().parse(before),
          limit: optionalLimit.parse(limit),
          [FLEET_REASONING_QUERY]: 1,
        },
      })
    }
  )
  scoped.mhandle('fleet:patchPeerThread', (fleet, _event, botId: unknown, threadId: unknown, patch: unknown) => {
    requireThreads(fleet)
    return fleet.call('botPeerThreadPatch', {
      params: threadParams(botId, threadId),
      body: fleetPeerThreadPatchRequestSchema.parse(patch),
    })
  })
  scoped.mhandle('fleet:deletePeerThreadConversation', (fleet, _event, botId: unknown, threadId: unknown) => {
    requireThreads(fleet)
    return fleet
      .call('botPeerThreadConversationDelete', { params: threadParams(botId, threadId) })
      .catch(threadConflict)
  })
  scoped.mhandle(
    'fleet:sendPeerThreadMessage',
    (fleet, _event, botId: unknown, threadId: unknown, text: unknown, attachments: unknown = []) => {
      requireThreads(fleet)
      const params = threadParams(botId, threadId)
      const input = ownerMessage(fleet, text, attachments)
      return requireFiles(fleet, params.id, input).then(() =>
        fleet.call('botPeerThreadMessageSend', { params, body: input }).catch(threadConflict)
      )
    }
  )
  scoped.mhandle('fleet:setPeerThreadSettings', (fleet, _event, botId: unknown, settings: unknown) => {
    requireThreads(fleet)
    return fleet.call('botPeerThreadSettings', {
      params: { id: id.parse(botId) },
      body: fleetPeerThreadSettingsSchema.parse(settings),
    })
  })
  // A missing file rejects with FLEET_FILE_NOT_FOUND, a canceled one with FLEET_DOWNLOAD_CANCELED.
  scoped.mhandle('fleet:downloadFile', (fleet, _event, botId: unknown, fileId: unknown) =>
    fleet.downloadFile(id.parse(botId), fleetFileIdSchema.parse(fileId))
  )
  scoped.mhandle('fleet:cancelDownload', (fleet, _event, botId: unknown, fileId: unknown) =>
    fleet.cancelDownload(id.parse(botId), fleetFileIdSchema.parse(fileId))
  )
  scoped.handle('fleet:getActiveDownload', (fleet, _event, botId: unknown, fileId: unknown) =>
    fleet.getActiveDownload(id.parse(botId), fleetFileIdSchema.parse(fileId))
  )
  reg.mhandle('fleet:attendDownloads', (event, files: unknown) =>
    setAttendedFleetFiles(event.sender, attendedFiles.parse(files))
  )
  scoped.handle('fleet:getDownload', (fleet, _event, botId: unknown, fileId: unknown) =>
    fleet.getDownload(id.parse(botId), fleetFileIdSchema.parse(fileId))
  )
  reg.mhandle('fleet:revealDownload', (_event, receipt: unknown) =>
    fleetClientService.revealDownload(z.string().uuid().parse(receipt))
  )
  // Returns a capability URL for `<video>`, so only the app's trusted windows may ask for one.
  scoped.mhandle('fleet:prepareMedia', (fleet, _event, botId: unknown, fileId: unknown) =>
    fleet.prepareMedia(id.parse(botId), fleetFileIdSchema.parse(fileId)).catch((error: unknown) => {
      if (error instanceof FleetClientError && (error.status === 404 || error.code === 'NOT_FOUND'))
        throw new Error('FLEET_FILE_NOT_FOUND')
      throw error
    })
  )
  scoped.handle('fleet:getImage', (fleet, _event, botId: unknown, rawImageId: unknown, runId: unknown = null) =>
    fleet
      .getImage(id.parse(botId), imageId.parse(rawImageId), opaqueId.nullable().parse(runId))
      .catch((error: unknown) => {
        // IPC keeps only the message: mark a truly missing image so the UI can tell it from a failed load.
        if (error instanceof FleetClientError && (error.status === 404 || error.code === 'NOT_FOUND'))
          throw new Error('FLEET_IMAGE_NOT_FOUND')
        throw error
      })
  )
  scoped.mhandle('fleet:removeQueuedMessage', (fleet, _event, botId: unknown, inputId: unknown) =>
    fleet.call('botMessageDelete', { params: { id: id.parse(botId), inputId: opaqueId.parse(inputId) } })
  )
  // The owner's last message, edited: the bot's conversation is cut from it and the new text runs as a new turn. The
  // message keeps its attachments.
  scoped.mhandle('fleet:editMessage', async (fleet, _event, botId: unknown, inputId: unknown, text: unknown) => {
    const params = { id: id.parse(botId), inputId: opaqueId.parse(inputId) }
    const body = fleetEditMessageRequestSchema.parse({
      text: z.string().max(16_000).parse(text),
      idempotencyKey: fleet.idempotencyKey(),
    })
    if (!fleet.hasFeature(FLEET_MESSAGE_EDIT_FEATURE)) throw new Error(FLEET_EDIT_UNSUPPORTED)
    const bot = await fleet.call('botGet', { params: { id: params.id } })
    if (!bot.capabilities.includes(FLEET_MESSAGE_EDIT_FEATURE)) throw new Error(FLEET_EDIT_UNSUPPORTED)
    try {
      return await fleet.call('botMessageEdit', { params, body })
    } catch (error) {
      if (error instanceof FleetClientError && error.status === 409) throw new Error(FLEET_EDIT_CONFLICT)
      throw error
    }
  })
  scoped.mhandle(
    'fleet:resolveInteraction',
    (fleet, _event, botId: unknown, interactionId: unknown, resolution: unknown) =>
      fleet.call('botInteractionResolve', {
        params: { id: id.parse(botId), interactionId: opaqueId.parse(interactionId) },
        body: fleetInteractionResolutionSchema.parse(resolution),
      })
  )
  scoped.mhandle('fleet:takeover', async (fleet, _event, botId: unknown) => {
    try {
      return await fleet.call('botTakeover', { params: { id: id.parse(botId) } })
    } catch (error) {
      if (error instanceof FleetClientError && error.status === 409) throw new Error('FLEET_TAKEOVER_CONFLICT')
      throw error
    }
  })
  scoped.mhandle('fleet:releaseTakeover', (fleet, _event, botId: unknown, input: unknown) =>
    fleet.call('botTakeoverRelease', {
      params: { id: id.parse(botId) },
      body: fleetTakeoverReleaseRequestSchema.parse(input),
    })
  )
  scoped.mhandle('fleet:conversationCall', (fleet, _event, botId: unknown, op: unknown, args: unknown) => {
    const body = fleetConversationCallRequestSchema.parse({ op: fleetConversationOpSchema.parse(op), args })
    return fleet
      .call('botConversationCall', { params: { id: id.parse(botId) }, body })
      .then((response) => response.result)
  })
  scoped.mhandle('fleet:uiOpen', (fleet, _event, botId: unknown, input: unknown) =>
    fleet.call('botUiOpen', { params: { id: id.parse(botId) }, body: fleetUiOpenRequestSchema.parse(input) })
  )
  scoped.handle('fleet:listRoutines', (fleet, _event, botId: unknown) =>
    fleet.call('botRoutinesList', { params: { id: id.parse(botId) } })
  )
  scoped.mhandle('fleet:createRoutine', (fleet, _event, botId: unknown, input: unknown) =>
    fleet.call('botRoutinesCreate', {
      params: { id: id.parse(botId) },
      body: { ...createRoutine.parse(input), idempotencyKey: fleet.idempotencyKey() },
    })
  )
  scoped.mhandle('fleet:updateRoutine', (fleet, _event, botId: unknown, routineId: unknown, input: unknown) =>
    fleet.call('botRoutinePatch', {
      params: { id: id.parse(botId), rid: opaqueId.parse(routineId) },
      body: fleetPatchRoutineRequestSchema.parse(input),
    })
  )
  scoped.mhandle('fleet:deleteRoutine', (fleet, _event, botId: unknown, routineId: unknown) =>
    fleet.call('botRoutineDelete', { params: { id: id.parse(botId), rid: opaqueId.parse(routineId) } })
  )
  scoped.mhandle('fleet:runRoutine', (fleet, _event, botId: unknown, routineId: unknown) =>
    fleet.call('botRoutineRun', { params: { id: id.parse(botId), rid: opaqueId.parse(routineId) } })
  )
  scoped.handle('fleet:ownerMemoryList', (fleet, _event, status: unknown) =>
    fleet.call('ownerMemoryList', { query: { status: status === 'active' ? 'active' : 'all' } })
  )
  // An older gateway drops the scope: an entry meant for one environment would reach every bot.
  scoped.mhandle('fleet:ownerMemoryCreate', (fleet, _event, input: unknown) => {
    const body = fleetOwnerMemoryCreateRequestSchema.omit({ idempotencyKey: true }).parse(input)
    if (body.environmentId !== null) requireEnvironments(fleet)
    return fleet.call('ownerMemoryCreate', { body: { ...body, idempotencyKey: fleet.idempotencyKey() } })
  })
  scoped.mhandle('fleet:ownerMemoryUpdate', (fleet, _event, entryId: unknown, patch: unknown) => {
    const params = { mid: opaqueId.parse(entryId) }
    const body = fleetOwnerMemoryPatchRequestSchema.parse(patch)
    if (body.environmentId !== undefined) requireEnvironments(fleet)
    return fleet.call('ownerMemoryPatch', { params, body })
  })
  scoped.mhandle('fleet:ownerMemoryDelete', (fleet, _event, entryId: unknown) =>
    fleet.call('ownerMemoryDelete', { params: { mid: opaqueId.parse(entryId) } })
  )
  scoped.handle('fleet:listRoutineRuns', (fleet, _event, botId: unknown, routineId: unknown) =>
    fleet.call('botRoutineRuns', { params: { id: id.parse(botId), rid: opaqueId.parse(routineId) } })
  )
  scoped.handle('fleet:listBotMemories', (fleet, _event, botId: unknown, status: unknown) =>
    fleet.call('botMemoriesList', {
      params: { id: id.parse(botId) },
      query: {
        status: ['active', 'archived', 'superseded', 'all'].includes(String(status)) ? String(status) : 'active',
      },
    })
  )
  scoped.mhandle('fleet:patchBotMemory', (fleet, _event, botId: unknown, memoryId: unknown, patch: unknown) =>
    fleet.call('botMemoryPatch', {
      params: { id: id.parse(botId), mid: opaqueId.parse(memoryId) },
      body: fleetBotMemoryPatchRequestSchema.parse(patch),
    })
  )
  scoped.mhandle('fleet:deleteBotMemory', (fleet, _event, botId: unknown, memoryId: unknown) =>
    fleet.call('botMemoryDelete', { params: { id: id.parse(botId), mid: opaqueId.parse(memoryId) } })
  )
  scoped.handle('fleet:getInbox', (fleet) => fleet.call('inbox'))
  scoped.handle('fleet:getPeerMessages', (fleet, _event, limit: unknown) =>
    fleet.call('peerMessages', { query: { limit: z.number().int().min(1).max(200).optional().parse(limit) } })
  )
  scoped.mhandle('fleet:screenOpen', (fleet, event, rawTarget: unknown, rawMode: unknown) => {
    const mode = z.enum(['view', 'control']).parse(rawMode)
    const target = resolveScreenTarget(fleet, rawTarget)
    return fleet.screens.openScreen(event.sender, target, mode).catch((error: unknown) => {
      // Only a control session on the shared display is a conflict; the other 409s need a start or a restart.
      throw screenTicketError(error, target)
    })
  })
  reg.mhandle('fleet:screenSend', (event, channelId: unknown, data: unknown) => {
    const bytes = z
      .instanceof(ArrayBuffer)
      .refine((value) => value.byteLength <= 1_048_576)
      .parse(data)
    fleetClientService.screens.send(event.sender, opaqueId.parse(channelId), bytes)
  })
  reg.mhandle('fleet:screenClose', (event, channelId: unknown) =>
    fleetClientService.screens.close(event.sender, opaqueId.parse(channelId))
  )
  reg.mhandle('fleet:screenClipboardRead', (event, channelId: unknown) =>
    fleetClientService.screens.readClipboard(event.sender, opaqueId.parse(channelId))
  )
  reg.mhandle('fleet:screenClipboardWrite', (event, channelId: unknown, text: unknown) =>
    fleetClientService.screens.writeClipboard(event.sender, opaqueId.parse(channelId), text)
  )
}
