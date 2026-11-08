/**
 * What the owner does with a bot of a paired server, shared by the window's IPC and the assistant's tools: read its
 * conversation or a routine run's, list its runs, and send it a message. Inputs arrive already validated; each call
 * throws at once on what the gateway or the bot cannot take, as the IPC handlers always did.
 */
import { z } from 'zod'
import {
  FLEET_FILE_LIMITS,
  FLEET_FILES_FEATURE,
  FLEET_REASONING_QUERY,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  FLEET_ROUTINE_RUN_LIMITS,
  type FleetInputReceipt,
  type FleetRoutineRunPage,
  type FleetTranscriptPage,
  fleetSendMessageRequestSchema,
} from '@maestrly/bot-fleet-protocol'
import { FLEET_RUNS_UNSUPPORTED } from '../../../shared/fleet-targets'
import { validateAttachmentBytes } from '../instance/incoming-attachments'
import type { FleetClientService } from './service'

export type BotFleet = Pick<FleetClientService, 'call' | 'hasFeature' | 'idempotencyKey'>

export const outgoingAttachments = z
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

/** An owner's message, as the composer sends it; with `citation`, it refers to one of the bot's routine runs. */
export function ownerMessage(fleet: BotFleet, text: unknown, attachments: unknown, citation?: string) {
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
export function requireFiles(
  fleet: BotFleet,
  botId: string,
  input: { attachments: Array<{ kind?: string }> }
): Promise<void> {
  if (!input.attachments.some((attachment) => attachment.kind !== 'image')) return Promise.resolve()
  if (!fleet.hasFeature(FLEET_FILES_FEATURE)) throw new Error('FLEET_FILES_UNSUPPORTED')
  return fleet.call('botGet', { params: { id: botId } }).then((bot) => {
    if (!(bot as { capabilities: string[] }).capabilities.includes(FLEET_FILES_FEATURE))
      throw new Error('FLEET_FILES_UNSUPPORTED')
  })
}

export function readBotTranscript(
  fleet: BotFleet,
  botId: string,
  opts: { before?: string | null; limit?: number }
): Promise<FleetTranscriptPage> {
  return fleet.call('botTranscript', {
    params: { id: botId },
    query: {
      before: opts.before,
      limit: opts.limit,
      // This app reads `reasoning` items; an older gateway ignores the parameter and sends none.
      [FLEET_REASONING_QUERY]: 1,
    },
  }) as Promise<FleetTranscriptPage>
}

export function readBotRunTranscript(
  fleet: BotFleet,
  botId: string,
  runId: string,
  opts: { before?: string | null; limit?: number }
): Promise<FleetTranscriptPage> {
  return fleet.call('botRunTranscript', {
    params: { id: botId, runId },
    query: { before: opts.before, limit: opts.limit, [FLEET_REASONING_QUERY]: 1 },
  }) as Promise<FleetTranscriptPage>
}

/** A page of the bot's routine runs, newest first (`routine-conversations`). */
export function listBotRuns(
  fleet: BotFleet,
  botId: string,
  opts: { before?: string | null; routineId?: string | null } = {}
): Promise<FleetRoutineRunPage> {
  if (!fleet.hasFeature(FLEET_ROUTINE_CONVERSATIONS_FEATURE)) throw new Error(FLEET_RUNS_UNSUPPORTED)
  return fleet.call('botRuns', {
    params: { id: botId },
    query: {
      before: opts.before ?? undefined,
      routineId: opts.routineId ?? undefined,
      limit: FLEET_ROUTINE_RUN_LIMITS.pageMax,
    },
  }) as Promise<FleetRoutineRunPage>
}

/** Sends the owner's message; `citation` names a routine run of the bot it refers to. */
export function sendBotMessage(
  fleet: BotFleet,
  botId: string,
  text: unknown,
  attachments: unknown = [],
  citation: string | null = null
): Promise<FleetInputReceipt> {
  const run = citation ?? undefined
  const input = ownerMessage(fleet, text, attachments, run)
  if (run && !fleet.hasFeature(FLEET_ROUTINE_CONVERSATIONS_FEATURE)) throw new Error(FLEET_RUNS_UNSUPPORTED)
  return requireFiles(fleet, botId, input).then(
    () => fleet.call('botMessageSend', { params: { id: botId }, body: input }) as Promise<FleetInputReceipt>
  )
}
