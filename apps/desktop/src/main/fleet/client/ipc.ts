import { app } from 'electron'
import { z } from 'zod'
import {
  fleetBotIdSchema,
  fleetCreateBotRequestSchema,
  fleetCreateRoutineRequestSchema,
  fleetInteractionResolutionSchema,
  fleetNonNegativeIntSchema,
  fleetPatchBotRequestSchema,
  fleetPatchRoutineRequestSchema,
  fleetTakeoverReleaseRequestSchema,
  fleetUiOpenRequestSchema,
  fleetMessageTextSchema,
  fleetAddApiKeyAccountRequestSchema,
} from '@maestrly/bot-fleet-protocol'
import type { IpcRegistrar } from '../../ipc-registrar'
import { FleetClientError } from './api'
import { fleetClientService as fleet } from './service'

const id = fleetBotIdSchema
const opaqueId = z.string().min(1).max(256)
const optionalLimit = z.number().int().min(1).max(500).optional()
const connectInput = z
  .object({
    url: z.string().min(1).max(2048),
    code: z.string().min(1).max(64),
    deviceName: z.string().min(1).max(160).optional(),
  })
  .strict()
const createBot = fleetCreateBotRequestSchema.omit({ idempotencyKey: true })
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
    fleet.call('botsCreate', { body: { ...createBot.parse(input), idempotencyKey: fleet.idempotencyKey() } })
  )
  reg.mhandle('fleet:updateBot', (_event, botId: unknown, patch: unknown) =>
    fleet.call('botPatch', { params: { id: id.parse(botId) }, body: fleetPatchBotRequestSchema.parse(patch) })
  )
  reg.mhandle('fleet:botAction', (_event, botId: unknown, rawAction: unknown) =>
    fleet.call(actionRoute[action.parse(rawAction)], { params: { id: id.parse(botId) } })
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
  reg.mhandle('fleet:sendMessage', (_event, botId: unknown, text: unknown) =>
    fleet.call('botMessageSend', {
      params: { id: id.parse(botId) },
      body: { text: fleetMessageTextSchema.parse(text), idempotencyKey: fleet.idempotencyKey() },
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
