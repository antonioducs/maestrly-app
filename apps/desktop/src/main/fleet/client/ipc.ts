import { app } from 'electron'
import { registerFleetProvisioningIpc } from './provisioning/ipc'
import { z } from 'zod'
import {
  fleetBotIdSchema,
  fleetOwnerMemoryCreateRequestSchema,
  fleetOwnerMemoryPatchRequestSchema,
  fleetBotMemoryPatchRequestSchema,
  fleetConversationOpSchema,
  fleetConversationCallRequestSchema,
  fleetCreateBotRequestSchema,
  fleetCreateRoutineRequestSchema,
  fleetInteractionResolutionSchema,
  fleetNonNegativeIntSchema,
  fleetPatchBotRequestSchema,
  fleetPatchRoutineRequestSchema,
  fleetTakeoverReleaseRequestSchema,
  fleetUiOpenRequestSchema,
  fleetSendMessageRequestSchema,
  fleetImageMediaTypeSchema,
  FLEET_IMAGE_LIMITS,
  fleetAddApiKeyAccountRequestSchema,
} from '@maestrly/bot-fleet-protocol'
import type { IpcRegistrar } from '../../ipc-registrar'
import { FleetClientError } from './api'
import { fleetClientService as fleet } from './service'

const id = fleetBotIdSchema
const opaqueId = z.string().min(1).max(256)
const optionalLimit = z.number().int().min(1).max(500).optional()
const outgoingAttachments = z
  .array(
    z
      .object({
        name: z.string().min(1).max(200),
        mediaType: fleetImageMediaTypeSchema,
        data: z
          .instanceof(Uint8Array)
          .refine((data) => data.byteLength > 0 && data.byteLength <= FLEET_IMAGE_LIMITS.attachmentMaxBytes),
      })
      .strict()
  )
  .max(FLEET_IMAGE_LIMITS.attachmentsMax)
  .refine(
    (items) => items.reduce((sum, item) => sum + item.data.byteLength, 0) <= FLEET_IMAGE_LIMITS.attachmentsTotalMaxBytes
  )
const imageId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/)
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

export function registerFleetClientIpc(reg: IpcRegistrar): void {
  registerFleetProvisioningIpc(reg, fleet)
  if (process.env.MAESTRLY_BOT_MODE !== '1') {
    fleet.start()
    app.once('will-quit', () => fleet.stop())
  }
  reg.handle('fleet:getConnection', () => fleet.getConnection())
  reg.mhandle('fleet:connect', (_event, input: unknown) => fleet.connect(connectInput.parse(input)))
  reg.mhandle('fleet:disconnect', () => fleet.disconnect())
  reg.handle('fleet:getSnapshot', () => fleet.getSnapshot())
  reg.mhandle('fleet:refresh', () => fleet.refresh())
  reg.handle('fleet:getHost', () => fleet.call('host'))
  reg.handle('fleet:listBots', () => fleet.call('botsList'))
  reg.handle('fleet:getBot', (_event, botId: unknown) => fleet.call('botGet', { params: { id: id.parse(botId) } }))
  reg.mhandle('fleet:createBot', (_event, input: unknown) =>
    fleet.call('botsCreate', {
      body: fleetCreateBotRequestSchema.parse({
        ...createBotInput.parse(input),
        idempotencyKey: fleet.idempotencyKey(),
      }),
    })
  )
  reg.mhandle('fleet:updateBot', (_event, botId: unknown, patch: unknown) =>
    fleet.call('botPatch', { params: { id: id.parse(botId) }, body: fleetPatchBotRequestSchema.parse(patch) })
  )
  reg.mhandle('fleet:botAction', (_event, botId: unknown, rawAction: unknown) =>
    fleet.call(actionRoute[action.parse(rawAction)], { params: { id: id.parse(botId) } })
  )
  reg.handle('fleet:listArchivedBots', () => fleet.call('archivedBotsList'))
  reg.mhandle('fleet:restoreArchivedBot', (_event, botId: unknown) =>
    fleet.call('archivedBotRestore', { params: { id: id.parse(botId) } })
  )
  reg.mhandle('fleet:deleteArchivedBot', (_event, botId: unknown) =>
    fleet.call('archivedBotDelete', { params: { id: id.parse(botId) } })
  )
  reg.handle('fleet:listSelections', (_event, botId: unknown) =>
    fleet.call('botSelections', { params: { id: id.parse(botId) } })
  )
  reg.mhandle('fleet:add-api-key-account', (_event, botId: unknown, input: unknown) =>
    fleet.call('botApiKeyAccountAdd', {
      params: { id: id.parse(botId) },
      body: fleetAddApiKeyAccountRequestSchema.parse(input),
    })
  )
  reg.mhandle('fleet:remove-account', (_event, botId: unknown, providerId: unknown) =>
    fleet.call('botAccountRemove', { params: { id: id.parse(botId), providerId: opaqueId.parse(providerId) } })
  )
  reg.handle('fleet:getTranscript', (_event, botId: unknown, before: unknown, limit: unknown) =>
    fleet.call('botTranscript', {
      params: { id: id.parse(botId) },
      query: { before: z.string().max(256).nullable().optional().parse(before), limit: optionalLimit.parse(limit) },
    })
  )
  reg.mhandle('fleet:sendMessage', (_event, botId: unknown, text: unknown, attachments: unknown = []) => {
    const input = fleetSendMessageRequestSchema.parse({
      text: z.string().max(16_000).parse(text),
      attachments: outgoingAttachments.parse(attachments).map((item) => ({
        name: item.name,
        mediaType: item.mediaType,
        dataBase64: Buffer.from(item.data).toString('base64'),
      })),
      idempotencyKey: fleet.idempotencyKey(),
    })
    return fleet.call('botMessageSend', { params: { id: id.parse(botId) }, body: input })
  })
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
  reg.mhandle('fleet:ownerMemoryCreate', (_event, input: unknown) =>
    fleet.call('ownerMemoryCreate', {
      body: {
        ...fleetOwnerMemoryCreateRequestSchema.omit({ idempotencyKey: true }).parse(input),
        idempotencyKey: fleet.idempotencyKey(),
      },
    })
  )
  reg.mhandle('fleet:ownerMemoryUpdate', (_event, entryId: unknown, patch: unknown) =>
    fleet.call('ownerMemoryPatch', {
      params: { mid: opaqueId.parse(entryId) },
      body: fleetOwnerMemoryPatchRequestSchema.parse(patch),
    })
  )
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
  reg.handle('fleet:getDigest', () => fleet.getDigest())
  reg.mhandle('fleet:ackDigest', (_event, seq: unknown) => fleet.ackDigest(fleetNonNegativeIntSchema.parse(seq)))
  reg.mhandle('fleet:screenOpen', (event, botId: unknown, mode: unknown) =>
    fleet.screens.openScreen(event.sender, id.parse(botId), z.enum(['view', 'control']).parse(mode))
  )
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
}
