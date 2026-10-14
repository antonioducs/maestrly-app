import { registerFleetEnvironmentSettingsIpc } from './environment-settings-ipc'
import { app } from 'electron'
import { validateAttachmentBytes } from '../instance/incoming-attachments'
import { registerFleetProvisioningIpc } from './provisioning/ipc'
import { z } from 'zod'
import {
  FLEET_PHONES_FEATURE,
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
  fleetAddApiKeyAccountRequestSchema,
} from '@maestrly/bot-fleet-protocol'
import type { IpcRegistrar } from '../../ipc-registrar'
import { isHeadlessInstance } from '../../remote-host/server/config'
import { FLEET_ATTENDED_FILES_MAX } from '../../../shared/fleet-downloads'
import { FleetClientError } from './api'
import { setAttendedFleetFiles } from './download-notices'
import { fleetClientService as fleet } from './service'
import { FLEET_EDIT_CONFLICT, FLEET_EDIT_UNSUPPORTED, FLEET_SCOPES_UNSUPPORTED } from '../../../shared/fleet-targets'
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
/** The files a window shows; each send replaces that window's whole list. */
const attendedFiles = z.array(z.object({ botId: id, fileId: fleetFileIdSchema }).strict()).max(FLEET_ATTENDED_FILES_MAX)
const connectInput = z
  .object({
    url: z.string().min(1).max(2048),
    code: z.string().min(1).max(64),
    deviceName: z.string().min(1).max(160).optional(),
  })
  .strict()
// A refined schema cannot `.omit()` the key: the renderer's fields are checked with the key the main process picks.
const createBotInput = z.record(z.string(), z.unknown())
const createRoutine = fleetCreateRoutineRequestSchema.omit({ idempotencyKey: true })
const action = z.enum(['start', 'stop', 'restart', 'archive', 'pause', 'resume', 'cancel'])
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

export function registerFleetClientIpc(reg: IpcRegistrar): void {
  registerFleetProvisioningIpc(reg, fleet)
  registerFleetEnvironmentSettingsIpc(reg, fleet)
  if (!isHeadlessInstance()) {
    fleet.start()
    app.once('will-quit', () => fleet.stop())
  }
  reg.handle('fleet:getConnection', () => fleet.getConnection())
  reg.mhandle('fleet:connect', (_event, input: unknown) => fleet.connect(connectInput.parse(input)))
  reg.mhandle('fleet:disconnect', () => fleet.disconnect())
  // A one-use code for another device (a phone), shown as a QR code; older gateways cannot create one.
  reg.mhandle('fleet:createPairing', async () => {
    if (!fleet.hasFeature(FLEET_PHONES_FEATURE))
      throw new FleetClientError('PROTOCOL_INCOMPATIBLE', 426, 'Update the bot server to pair a phone')
    return fleet.call('pairingsCreate', { body: {} })
  })
  reg.handle('fleet:getSnapshot', () => fleet.getSnapshot())
  reg.mhandle('fleet:refresh', () => fleet.refresh())
  reg.handle('fleet:getHost', () => fleet.call('host'))
  reg.handle('fleet:listBots', () => fleet.call('botsList'))
  reg.handle('fleet:getBot', (_event, botId: unknown) => fleet.call('botGet', { params: { id: id.parse(botId) } }))
  reg.mhandle('fleet:createBot', (_event, input: unknown) => {
    const body = fleetCreateBotRequestSchema.parse({
      ...createBotInput.parse(input),
      idempotencyKey: fleet.idempotencyKey(),
    })
    // An older gateway drops both fields and gives the bot its own container: never let a join silently do that.
    if (body.environmentId !== undefined || body.environment !== undefined) requireEnvironments(fleet)
    return fleet.call('botsCreate', { body })
  })
  reg.mhandle('fleet:updateBot', (_event, botId: unknown, patch: unknown) =>
    fleet.call('botPatch', { params: { id: id.parse(botId) }, body: fleetPatchBotRequestSchema.parse(patch) })
  )
  reg.mhandle('fleet:botAction', (_event, botId: unknown, rawAction: unknown) =>
    fleet.call(actionRoute[action.parse(rawAction)], { params: { id: id.parse(botId) } })
  )
  reg.handle('fleet:listArchivedBots', () => fleet.call('archivedBotsList', { query: { separateEnvironments: 1 } }))
  reg.mhandle('fleet:restoreArchivedBot', (_event, botId: unknown) =>
    fleet.call('archivedBotRestore', { params: { id: id.parse(botId) } })
  )
  reg.mhandle('fleet:deleteArchivedBot', (_event, botId: unknown) =>
    fleet.call('archivedBotDelete', { params: { id: id.parse(botId) } })
  )
  reg.mhandle('fleet:environmentAction', (_event, rawId: unknown, rawAction: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    const route = environmentActionRoute[environmentAction.parse(rawAction)]
    requireEnvironments(fleet)
    return fleet.call(route, { params })
  })
  // A server hosts the owner's chats and workspaces in environments of their own kind, with no bots: one per scope of
  // the owner's work on servers with `workspaces-environments`, one in all on older ones.
  reg.mhandle('fleet:createWorkspaces', (_event, raw: unknown) => {
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
  reg.mhandle('fleet:environmentUpdate', (_event, rawId: unknown, rawWhen: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    const body = { when: updateWhen.parse(rawWhen) }
    requireEnvironmentUpdates(fleet)
    return fleet.call('environmentUpdate', { params, body })
  })
  reg.mhandle('fleet:environmentUpdateCancel', (_event, rawId: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    requireEnvironmentUpdates(fleet)
    return fleet.call('environmentUpdateCancel', { params })
  })
  // Answers at once: the environment checks in the background and reports the results in its runtimes.
  reg.mhandle('fleet:environmentRuntimesCheck', (_event, rawId: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    requireRuntimeUpdates(fleet)
    return fleet.call('environmentRuntimesCheck', { params })
  })
  reg.mhandle('fleet:patchEnvironment', (_event, rawId: unknown, patch: unknown) => {
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
  reg.handle('fleet:listArchivedEnvironments', async () =>
    fleet.hasFeature(FLEET_ENVIRONMENTS_FEATURE) ? fleet.call('archivedEnvironmentsList') : { environments: [] }
  )
  reg.mhandle('fleet:restoreArchivedEnvironment', (_event, rawId: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    requireEnvironments(fleet)
    return fleet.call('archivedEnvironmentRestore', { params })
  })
  reg.mhandle('fleet:deleteArchivedEnvironment', (_event, rawId: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    requireEnvironments(fleet)
    return fleet.call('archivedEnvironmentDelete', { params })
  })
  reg.mhandle('fleet:environmentUiOpen', (_event, rawId: unknown, target: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    const body = fleetUiOpenRequestSchema.parse({ target })
    requireEnvironments(fleet)
    return fleet.call('environmentUiOpen', { params, body })
  })
  reg.handle('fleet:listSelections', (_event, botId: unknown) =>
    fleet.call('botSelections', { params: { id: id.parse(botId) } })
  )
  // The models of an environment's accounts, for its default compaction model.
  reg.handle('fleet:environmentSelections', (_event, rawId: unknown) => {
    const params = { eid: environmentId.parse(rawId) }
    requireEnvironments(fleet)
    return fleet.call('environmentSelections', { params })
  })
  reg.mhandle('fleet:add-api-key-account', (_event, target: unknown, input: unknown) => {
    const body = fleetAddApiKeyAccountRequestSchema.parse(input)
    const route = provisioningRoute(resolveProvisioningTarget(fleet, target), 'apiKeyAccountAdd')
    return fleet.call(route.key, { params: route.params, body })
  })
  reg.mhandle('fleet:remove-account', (_event, target: unknown, providerId: unknown) => {
    const account = { providerId: opaqueId.parse(providerId) }
    const route = provisioningRoute(resolveProvisioningTarget(fleet, target), 'accountRemove', account)
    return fleet.call(route.key, { params: route.params })
  })
  reg.handle('fleet:getTranscript', (_event, botId: unknown, before: unknown, limit: unknown) =>
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
  reg.mhandle('fleet:sendMessage', (_event, botId: unknown, text: unknown, attachments: unknown = []) => {
    const admitted = outgoingAttachments.parse(attachments)
    try {
      for (const attachment of admitted) validateAttachmentBytes(attachment, attachment.data)
    } catch {
      throw new Error('FLEET_ATTACHMENT_INVALID')
    }
    const input = fleetSendMessageRequestSchema.parse({
      text: z.string().max(16_000).parse(text),
      attachments: admitted.map((item) => ({
        kind: item.kind,
        name: item.name,
        mediaType: item.mediaType,
        dataBase64: Buffer.from(item.data).toString('base64'),
      })),
      idempotencyKey: fleet.idempotencyKey(),
    })
    if (input.attachments.some((attachment) => attachment.kind !== 'image')) {
      if (!fleet.hasFeature(FLEET_FILES_FEATURE)) throw new Error('FLEET_FILES_UNSUPPORTED')
      return fleet.call('botGet', { params: { id: id.parse(botId) } }).then((bot) => {
        if (!bot.capabilities.includes(FLEET_FILES_FEATURE)) throw new Error('FLEET_FILES_UNSUPPORTED')
        return fleet.call('botMessageSend', { params: { id: id.parse(botId) }, body: input })
      })
    }
    return fleet.call('botMessageSend', { params: { id: id.parse(botId) }, body: input })
  })
  // A missing file rejects with FLEET_FILE_NOT_FOUND, a canceled one with FLEET_DOWNLOAD_CANCELED.
  reg.mhandle('fleet:downloadFile', (_event, botId: unknown, fileId: unknown) =>
    fleet.downloadFile(id.parse(botId), fleetFileIdSchema.parse(fileId))
  )
  reg.mhandle('fleet:cancelDownload', (_event, botId: unknown, fileId: unknown) =>
    fleet.cancelDownload(id.parse(botId), fleetFileIdSchema.parse(fileId))
  )
  reg.handle('fleet:getActiveDownload', (_event, botId: unknown, fileId: unknown) =>
    fleet.getActiveDownload(id.parse(botId), fleetFileIdSchema.parse(fileId))
  )
  reg.mhandle('fleet:attendDownloads', (event, files: unknown) =>
    setAttendedFleetFiles(event.sender, attendedFiles.parse(files))
  )
  reg.handle('fleet:getDownload', (_event, botId: unknown, fileId: unknown) =>
    fleet.getDownload(id.parse(botId), fleetFileIdSchema.parse(fileId))
  )
  reg.mhandle('fleet:revealDownload', (_event, receipt: unknown) =>
    fleet.revealDownload(z.string().uuid().parse(receipt))
  )
  // Returns a capability URL for `<video>`, so only the app's trusted windows may ask for one.
  reg.mhandle('fleet:prepareMedia', (_event, botId: unknown, fileId: unknown) =>
    fleet.prepareMedia(id.parse(botId), fleetFileIdSchema.parse(fileId)).catch((error: unknown) => {
      if (error instanceof FleetClientError && (error.status === 404 || error.code === 'NOT_FOUND'))
        throw new Error('FLEET_FILE_NOT_FOUND')
      throw error
    })
  )
  reg.handle('fleet:getImage', (_event, botId: unknown, rawImageId: unknown) =>
    fleet.getImage(id.parse(botId), imageId.parse(rawImageId)).catch((error: unknown) => {
      // IPC keeps only the message: mark a truly missing image so the UI can tell it from a failed load.
      if (error instanceof FleetClientError && (error.status === 404 || error.code === 'NOT_FOUND'))
        throw new Error('FLEET_IMAGE_NOT_FOUND')
      throw error
    })
  )
  reg.mhandle('fleet:removeQueuedMessage', (_event, botId: unknown, inputId: unknown) =>
    fleet.call('botMessageDelete', { params: { id: id.parse(botId), inputId: opaqueId.parse(inputId) } })
  )
  // The owner's last message, edited: the bot's conversation is cut from it and the new text runs as a new turn. The
  // message keeps its attachments.
  reg.mhandle('fleet:editMessage', async (_event, botId: unknown, inputId: unknown, text: unknown) => {
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
  reg.mhandle('fleet:resolveInteraction', (_event, botId: unknown, interactionId: unknown, resolution: unknown) =>
    fleet.call('botInteractionResolve', {
      params: { id: id.parse(botId), interactionId: opaqueId.parse(interactionId) },
      body: fleetInteractionResolutionSchema.parse(resolution),
    })
  )
  reg.mhandle('fleet:takeover', async (_event, botId: unknown) => {
    try {
      return await fleet.call('botTakeover', { params: { id: id.parse(botId) } })
    } catch (error) {
      if (error instanceof FleetClientError && error.status === 409) throw new Error('FLEET_TAKEOVER_CONFLICT')
      throw error
    }
  })
  reg.mhandle('fleet:releaseTakeover', (_event, botId: unknown, input: unknown) =>
    fleet.call('botTakeoverRelease', {
      params: { id: id.parse(botId) },
      body: fleetTakeoverReleaseRequestSchema.parse(input),
    })
  )
  reg.mhandle('fleet:conversationCall', (_event, botId: unknown, op: unknown, args: unknown) => {
    const body = fleetConversationCallRequestSchema.parse({ op: fleetConversationOpSchema.parse(op), args })
    return fleet
      .call('botConversationCall', { params: { id: id.parse(botId) }, body })
      .then((response) => response.result)
  })
  reg.mhandle('fleet:uiOpen', (_event, botId: unknown, input: unknown) =>
    fleet.call('botUiOpen', { params: { id: id.parse(botId) }, body: fleetUiOpenRequestSchema.parse(input) })
  )
  reg.handle('fleet:listRoutines', (_event, botId: unknown) =>
    fleet.call('botRoutinesList', { params: { id: id.parse(botId) } })
  )
  reg.mhandle('fleet:createRoutine', (_event, botId: unknown, input: unknown) =>
    fleet.call('botRoutinesCreate', {
      params: { id: id.parse(botId) },
      body: { ...createRoutine.parse(input), idempotencyKey: fleet.idempotencyKey() },
    })
  )
  reg.mhandle('fleet:updateRoutine', (_event, botId: unknown, routineId: unknown, input: unknown) =>
    fleet.call('botRoutinePatch', {
      params: { id: id.parse(botId), rid: opaqueId.parse(routineId) },
      body: fleetPatchRoutineRequestSchema.parse(input),
    })
  )
  reg.mhandle('fleet:deleteRoutine', (_event, botId: unknown, routineId: unknown) =>
    fleet.call('botRoutineDelete', { params: { id: id.parse(botId), rid: opaqueId.parse(routineId) } })
  )
  reg.mhandle('fleet:runRoutine', (_event, botId: unknown, routineId: unknown) =>
    fleet.call('botRoutineRun', { params: { id: id.parse(botId), rid: opaqueId.parse(routineId) } })
  )
  reg.handle('fleet:ownerMemoryList', (_event, status: unknown) =>
    fleet.call('ownerMemoryList', { query: { status: status === 'active' ? 'active' : 'all' } })
  )
  // An older gateway drops the scope: an entry meant for one environment would reach every bot.
  reg.mhandle('fleet:ownerMemoryCreate', (_event, input: unknown) => {
    const body = fleetOwnerMemoryCreateRequestSchema.omit({ idempotencyKey: true }).parse(input)
    if (body.environmentId !== null) requireEnvironments(fleet)
    return fleet.call('ownerMemoryCreate', { body: { ...body, idempotencyKey: fleet.idempotencyKey() } })
  })
  reg.mhandle('fleet:ownerMemoryUpdate', (_event, entryId: unknown, patch: unknown) => {
    const params = { mid: opaqueId.parse(entryId) }
    const body = fleetOwnerMemoryPatchRequestSchema.parse(patch)
    if (body.environmentId !== undefined) requireEnvironments(fleet)
    return fleet.call('ownerMemoryPatch', { params, body })
  })
  reg.mhandle('fleet:ownerMemoryDelete', (_event, entryId: unknown) =>
    fleet.call('ownerMemoryDelete', { params: { mid: opaqueId.parse(entryId) } })
  )
  reg.handle('fleet:listRoutineRuns', (_event, botId: unknown, routineId: unknown) =>
    fleet.call('botRoutineRuns', { params: { id: id.parse(botId), rid: opaqueId.parse(routineId) } })
  )
  reg.handle('fleet:listBotMemories', (_event, botId: unknown, status: unknown) =>
    fleet.call('botMemoriesList', {
      params: { id: id.parse(botId) },
      query: {
        status: ['active', 'archived', 'superseded', 'all'].includes(String(status)) ? String(status) : 'active',
      },
    })
  )
  reg.mhandle('fleet:patchBotMemory', (_event, botId: unknown, memoryId: unknown, patch: unknown) =>
    fleet.call('botMemoryPatch', {
      params: { id: id.parse(botId), mid: opaqueId.parse(memoryId) },
      body: fleetBotMemoryPatchRequestSchema.parse(patch),
    })
  )
  reg.mhandle('fleet:deleteBotMemory', (_event, botId: unknown, memoryId: unknown) =>
    fleet.call('botMemoryDelete', { params: { id: id.parse(botId), mid: opaqueId.parse(memoryId) } })
  )
  reg.handle('fleet:getInbox', () => fleet.call('inbox'))
  reg.handle('fleet:getPeerMessages', (_event, limit: unknown) =>
    fleet.call('peerMessages', { query: { limit: z.number().int().min(1).max(200).optional().parse(limit) } })
  )
  reg.mhandle('fleet:screenOpen', (event, rawTarget: unknown, rawMode: unknown) => {
    const mode = z.enum(['view', 'control']).parse(rawMode)
    const target = resolveScreenTarget(fleet, rawTarget)
    return fleet.screens.openScreen(event.sender, target, mode).catch((error: unknown) => {
      // Only a control session on the shared display is a conflict; the other 409s need a start or a restart.
      throw screenTicketError(error)
    })
  })
  reg.mhandle('fleet:screenSend', (event, channelId: unknown, data: unknown) => {
    const bytes = z
      .instanceof(ArrayBuffer)
      .refine((value) => value.byteLength <= 1_048_576)
      .parse(data)
    fleet.screens.send(event.sender, opaqueId.parse(channelId), bytes)
  })
  reg.mhandle('fleet:screenClose', (event, channelId: unknown) =>
    fleet.screens.close(event.sender, opaqueId.parse(channelId))
  )
  reg.mhandle('fleet:screenClipboardRead', (event, channelId: unknown) =>
    fleet.screens.readClipboard(event.sender, opaqueId.parse(channelId))
  )
  reg.mhandle('fleet:screenClipboardWrite', (event, channelId: unknown, text: unknown) =>
    fleet.screens.writeClipboard(event.sender, opaqueId.parse(channelId), text)
  )
}
