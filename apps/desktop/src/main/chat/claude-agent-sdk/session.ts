import type { ChatMessage } from '../../../shared/chat'
import { droppedImageText, renderNativeSeedTranscript } from '../message'
import { resolveFileImageBytesSync } from '../attachment-artifacts'
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
}

export function isClaudeSessionBindingCompatible(
  binding: ClaudeSessionBinding | null,
  expected: ClaudeSessionCompatibility
): boolean {
  return Boolean(
    binding &&
      binding.modelId === expected.modelId &&
      binding.effort === (expected.reasoningEffort ?? '') &&
      binding.fastMode === Boolean(expected.fastMode) &&
      binding.cwd === expected.cwd &&
      binding.harnessProfile === CLAUDE_HARNESS_PROFILE &&
      binding.promptHash === expected.promptHash &&
      binding.toolSignature === expected.toolSignature &&
      binding.accountFingerprint === expected.accountIdentity.fingerprint &&
      binding.accountEpoch === expected.accountIdentity.epoch &&
      // Multiple accounts: a session lives in its owner's CLAUDE_CONFIG_DIR; another account must never resume it.
      binding.accountId === (expected.accountId ?? null)
  )
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

export function buildClaudeSessionPrompt(
  message: ChatMessage,
  seedTranscript: string,
  opts: { dropImages?: boolean; transientContext?: string } = {}
): GatedClaudeUserPrompt {
  const content: Array<Record<string, unknown>> = []
  if (seedTranscript) {
    content.push({
      type: 'text',
      text: `Previous Maestrly transcript (continue from this context):\n\n${seedTranscript}`,
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
        }
      }
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return gatedClaudeHumanPrompt(content as unknown as Parameters<typeof gatedClaudeHumanPrompt>[0])
}

export function claudeSeedTranscript(history: readonly ChatMessage[], resume: string | undefined): string {
  return resume ? '' : renderNativeSeedTranscript(history.slice(0, -1))
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
}

export function buildClaudeSessionBinding(
  args: BuildClaudeSessionBindingArgs
): Omit<ClaudeSessionBinding, 'updatedAt'> {
  if (!args.accountIdentity.fingerprint) throw new Error('Claude is not authenticated.')
  return {
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    modelId: args.modelId,
    effort: args.reasoningEffort ?? '',
    fastMode: Boolean(args.fastMode),
    cwd: args.cwd,
    harnessProfile: CLAUDE_HARNESS_PROFILE,
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
