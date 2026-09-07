import type { ChatMode } from './chat'
import type { ChatBehavior } from './conversation-experience'

export type ChatCapabilityBehavior = Exclude<ChatBehavior, 'design'>

export function isChatMode(value: unknown): value is ChatMode {
  return value === 'agent' || value === 'design' || value === 'plan' || value === 'ask'
}

export function normalizeChatMode(value: unknown): ChatMode {
  return isChatMode(value) ? value : 'agent'
}

export function capabilityBehaviorFor(mode: ChatBehavior): ChatCapabilityBehavior {
  switch (mode) {
    case 'design':
      return 'agent'
    case 'agent':
    case 'plan':
    case 'ask':
    case 'maestro':
      return mode
  }
}

export function cycleChatMode(mode: ChatMode): ChatMode {
  switch (mode) {
    case 'agent':
      return 'design'
    case 'design':
      return 'plan'
    case 'plan':
      return 'ask'
    case 'ask':
      return 'agent'
  }
}
