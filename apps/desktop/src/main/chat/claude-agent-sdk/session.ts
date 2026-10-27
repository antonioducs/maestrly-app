import type { ChatMessage, MessagePart } from '../../../shared/chat'
import type { HarnessSnapshotV1 } from '../../../shared/harness'
import {
  MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE,
  MAX_ATTACHMENT_IMAGES_PER_MESSAGE,
} from '../../../shared/memory-policy'
import { snapshotAllowsResume } from '../harness/compatibility'
import type { ResolvedHarness } from '../harness/types'
import { activeChatContext, droppedImageText, renderNativeSeedTranscript, transcriptImageText } from '../message'
import { resolveFileImageBytesSync, resolveFilePdfBytesSync } from '../attachment-artifacts'
import { estimateTextTokens, PORTABLE_IMAGE_TOKENS } from '../portable-context'
import { pdfFallbackText, sendPdfNatively } from '../pdf-attachments'
import type { ClaudeSubscriptionAccountIdentity } from './manager'
import {
  CLAUDE_HARNESS_PROFILE,
  type ClaudeContextSnapshot,
  type ClaudeSessionBinding,
  type ClaudeSessionUsageSnapshot,
} from './session-store'
import { gatedClaudeHumanPrompt, type GatedClaudeUserPrompt } from './user-prompt'

export interface ClaudeSessionCompatibility {
  modelId: string
  reasoningEffort?: string
  fastMode?: boolean
  cwd: string
  promptHash: string
  toolSignature: string
  accountIdentity: ClaudeSubscriptionAccountIdentity
  /** Subscription account slot; absent/null means the default account. */
  accountId?: string | null
  /** Current harness contract. A recorded snapshot must match it; legacy rows keep the prompt-hash proof. */
  harness?: ResolvedHarness
}

/** Names of the axes that keep `binding` from being resumed; empty when it is compatible. Never holds values. */
export function claudeSessionBindingMismatches(
  binding: ClaudeSessionBinding,
  expected: ClaudeSessionCompatibility
): string[] {
  const checks: Array<[string, boolean]> = [
    ['model', binding.modelId === expected.modelId],
    ['effort', binding.effort === (expected.reasoningEffort ?? '')],
    ['fast-mode', binding.fastMode === Boolean(expected.fastMode)],
    ['cwd', binding.cwd === expected.cwd],
    ['harness-profile', binding.harnessProfile === CLAUDE_HARNESS_PROFILE],
    ['prompt', binding.promptHash === expected.promptHash],
    ['tools', binding.toolSignature === expected.toolSignature],
    ['account-fingerprint', binding.accountFingerprint === expected.accountIdentity.fingerprint],
    ['account-epoch', binding.accountEpoch === expected.accountIdentity.epoch],
    // Multiple accounts: a session lives in its owner's CLAUDE_CONFIG_DIR; another account must never resume it.
    ['account', binding.accountId === (expected.accountId ?? null)],
    ['harness', !expected.harness || snapshotAllowsResume(binding.harnessSnapshot, expected.harness)],
  ]
  return checks.filter(([, ok]) => !ok).map(([axis]) => axis)
}

export function isClaudeSessionBindingCompatible(
  binding: ClaudeSessionBinding | null,
  expected: ClaudeSessionCompatibility
): boolean {
  return !!binding && claudeSessionBindingMismatches(binding, expected).length === 0
}

export interface ResolveClaudeSessionArgs {
  binding: ClaudeSessionBinding | null
  compatible: boolean
  previousMessageId: string | null
  mappedAssistantUuid: string | null
  mappedSessionId: string | null
}

export interface ResolvedClaudeSession {
  resume?: string
  resumeSessionAt?: string
  forkSession: boolean
  retireExisting: boolean
}

export function resolveClaudeSession(args: ResolveClaudeSessionArgs): ResolvedClaudeSession {
  const existing = args.binding
  let resume: string | undefined
  let resumeSessionAt: string | undefined
  let forkSession = false
  if (args.compatible && existing) {
    if (existing.lastMessageId === args.previousMessageId) {
      resume = existing.sessionId
    } else if (args.previousMessageId && args.mappedSessionId === existing.sessionId && args.mappedAssistantUuid) {
      resume = existing.sessionId
      resumeSessionAt = args.mappedAssistantUuid
      forkSession = true
    }
  }
  return {
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    forkSession,
    retireExisting: Boolean(
      existing && (!args.compatible || (!resume && existing.lastMessageId !== args.previousMessageId))
    ),
  }
}

type FilePart = Extract<MessagePart, { type: 'file' }>

export interface ClaudeSeedImage {
  /** 1-based number the transcript uses to refer to this image. */
  index: number
  name: string
  bytes: Uint8Array
  mediaType: string
}

/** Text transcript for a fresh session plus the earlier images re-sent as real image blocks after it. */
export interface ClaudeSeed {
  transcript: string
  images: ClaudeSeedImage[]
}

export interface ClaudeSeedImageBudget {
  images: number
  bytes: number
}

/** A rebuilt session may carry as many image bytes as one admitted message, so the request stays within that size. */
const CLAUDE_SEED_IMAGE_BUDGET: ClaudeSeedImageBudget = {
  images: MAX_ATTACHMENT_IMAGES_PER_MESSAGE,
  bytes: MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE,
}

function unreadableImageText(part: FilePart): string {
  return `[Image attachment ${part.name} could not be decoded by the host.]`
}

function imagePartBytes(part: FilePart): number {
  if (part.byteSize != null) return part.byteSize
  const data = part.data ?? ''
  return Math.ceil(((data.length - data.indexOf(',') - 1) * 3) / 4)
}

/** Image allowance left after the message that is sent with the seed. */
function claudeSeedImageBudgetAfter(message: ChatMessage | undefined): ClaudeSeedImageBudget {
  let images = 0
  let bytes = 0
  for (const part of message?.parts ?? []) {
    if (part.type !== 'file' || part.kind !== 'image') continue
    images += 1
    bytes += imagePartBytes(part)
  }
  return {
    images: Math.max(0, CLAUDE_SEED_IMAGE_BUDGET.images - images),
    bytes: Math.max(0, CLAUDE_SEED_IMAGE_BUDGET.bytes - bytes),
  }
}

/**
 * Transcript that seeds a fresh Claude session. A text transcript cannot carry pixels, so unless the runtime drops
 * images, the most recent image attachments that fit `budget` are re-sent as image blocks and the transcript points to
 * them by number. Older ones keep a reference that does not claim Claude is blind to images.
 */
export function renderClaudeSeed(
  messages: readonly ChatMessage[],
  opts: { dropImages?: boolean; budget?: ClaudeSeedImageBudget } = {}
): ClaudeSeed {
  if (opts.dropImages) {
    return { transcript: renderNativeSeedTranscript(messages, { imageText: droppedImageText }), images: [] }
  }
  const candidates: Array<{ conversationId: string; part: FilePart }> = []
  for (const message of activeChatContext([...messages]).messages) {
    for (const part of message.parts) {
      if (part.type !== 'file' || part.kind !== 'image') continue
      candidates.push({ conversationId: message.conversationId, part })
    }
  }
  const budget = opts.budget ?? CLAUDE_SEED_IMAGE_BUDGET
  const selected = new Map<FilePart, { bytes: Uint8Array; mediaType: string }>()
  const unreadable = new Set<FilePart>()
  let bytesLeft = budget.bytes
  for (let i = candidates.length - 1; i >= 0 && selected.size < budget.images && bytesLeft > 0; i--) {
    const { conversationId, part } = candidates[i]
    const image = resolveFileImageBytesSync(conversationId, part)
    if (!image) {
      unreadable.add(part)
      continue
    }
    // Newest first: an image over the remaining budget is skipped so smaller older ones can still fit.
    if (image.bytes.byteLength > bytesLeft) continue
    selected.set(part, image)
    bytesLeft -= image.bytes.byteLength
  }
  const images: ClaudeSeedImage[] = []
  const numbers = new Map<FilePart, number>()
  for (const { part } of candidates) {
    const image = selected.get(part)
    if (!image) continue
    const index = images.length + 1
    numbers.set(part, index)
    images.push({ index, name: part.name, bytes: image.bytes, mediaType: image.mediaType })
  }
  const transcript = renderNativeSeedTranscript(messages, {
    imageText: (part) => {
      const index = numbers.get(part)
      if (index != null) return `[image "${part.name}" — re-sent below as transcript image ${index}]`
      return unreadable.has(part) ? unreadableImageText(part) : transcriptImageText(part)
    },
  })
  return { transcript, images }
}

/** Seed for a turn that sends `history.at(-1)` itself: nothing when a native session resumes. */
export function claudeSessionSeed(
  history: readonly ChatMessage[],
  resume: string | undefined,
  opts: { dropImages?: boolean } = {}
): ClaudeSeed {
  if (resume) return { transcript: '', images: [] }
  return renderClaudeSeed(history.slice(0, -1), {
    dropImages: opts.dropImages,
    budget: claudeSeedImageBudgetAfter(history.at(-1)),
  })
}

/** Conservative token load of a seed: images use the same allowance as the portable context estimate. */
export function estimateClaudeSeedTokens(seed: ClaudeSeed): number {
  return estimateTextTokens(seed.transcript) + seed.images.length * PORTABLE_IMAGE_TOKENS
}

export function buildClaudeSessionPrompt(
  message: ChatMessage,
  seed: ClaudeSeed | string,
  /** `nativePdf` defaults to true: Claude reads PDF document blocks; tests and future gates may disable it. */
  opts: { dropImages?: boolean; transientContext?: string; nativePdf?: boolean } = {}
): GatedClaudeUserPrompt {
  const { transcript, images } = typeof seed === 'string' ? { transcript: seed, images: [] } : seed
  const content: Array<Record<string, unknown>> = []
  if (transcript) {
    content.push({
      type: 'text',
      text: `Previous Maestrly transcript (continue from this context):\n\n${transcript}`,
    })
  }
  for (const image of images) {
    content.push({ type: 'text', text: `Transcript image ${image.index} ("${image.name}"):` })
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: Buffer.from(image.bytes).toString('base64') },
    })
  }
  if (opts.transientContext) content.push({ type: 'text', text: opts.transientContext })
  for (const part of message.parts) {
    if (part.type === 'text' || part.type === 'context' || part.type === 'compaction') {
      content.push({ type: 'text', text: part.text })
    } else if (part.type === 'skill-invocation') {
      // `/skill` invocation: send the expanded block (instructions + root + inventory) to the model instead of the chip.
      if (part.body) content.push({ type: 'text', text: part.body })
    } else if (part.type === 'file' && part.kind === 'text') {
      content.push({ type: 'text', text: `File ${part.name}:\n\n${part.data}` })
    } else if (part.type === 'file' && part.kind === 'image') {
      if (opts.dropImages) {
        content.push({ type: 'text', text: droppedImageText(part) })
      } else {
        const image = resolveFileImageBytesSync(message.conversationId, part)
        if (image) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mediaType,
              data: Buffer.from(image.bytes).toString('base64'),
            },
          })
        } else {
          content.push({ type: 'text', text: unreadableImageText(part) })
        }
      }
    } else if (part.type === 'file' && part.kind === 'pdf') {
      const bytes = sendPdfNatively(part, opts.nativePdf ?? true)
        ? resolveFilePdfBytesSync(message.conversationId, part)
        : null
      if (bytes) {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') },
          title: part.name,
        })
      } else {
        content.push({ type: 'text', text: pdfFallbackText(part) })
      }
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return gatedClaudeHumanPrompt(content as unknown as Parameters<typeof gatedClaudeHumanPrompt>[0])
}

export interface BuildClaudeSessionBindingArgs {
  conversationId: string
  sessionId: string
  modelId: string
  reasoningEffort?: string
  fastMode?: boolean
  cwd: string
  promptHash: string
  toolSignature: string
  lastMessageId: string
  lastAssistantUuid: string | null
  accountIdentity: ClaudeSubscriptionAccountIdentity
  /** Subscription account slot owning the session; absent/null means the default account. */
  accountId?: string | null
  usage: ClaudeSessionUsageSnapshot
  context: ClaudeContextSnapshot | null
  /** Versioned harness contract of the execution that created this session. */
  harnessSnapshot?: HarnessSnapshotV1 | null
}

export function buildClaudeSessionBinding(
  args: BuildClaudeSessionBindingArgs
): Omit<ClaudeSessionBinding, 'updatedAt' | 'harnessSnapshot'> & {
  harnessSnapshot: HarnessSnapshotV1 | null
} {
  if (!args.accountIdentity.fingerprint) throw new Error('Claude is not authenticated.')
  return {
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    modelId: args.modelId,
    effort: args.reasoningEffort ?? '',
    fastMode: Boolean(args.fastMode),
    cwd: args.cwd,
    harnessProfile: CLAUDE_HARNESS_PROFILE,
    harnessSnapshot: args.harnessSnapshot ?? null,
    promptHash: args.promptHash,
    toolSignature: args.toolSignature,
    lastMessageId: args.lastMessageId,
    lastAssistantUuid: args.lastAssistantUuid,
    accountFingerprint: args.accountIdentity.fingerprint,
    accountEpoch: args.accountIdentity.epoch,
    accountId: args.accountId ?? null,
    usage: args.usage,
    context: args.context,
  }
}
