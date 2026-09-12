import type { ClaudeSubscriptionAccountIdentity } from '../claude-agent-sdk/manager'

export interface ClaudeAttempt {
  providerId: string
  accountIdentity: ClaudeSubscriptionAccountIdentity
  scope: 'root' | 'subagent' | 'helper'
  conversationId?: string
  abort: (reason?: unknown) => void
  done: Promise<void>
}

type AttemptOwner = (attempt: Omit<ClaudeAttempt, 'done'>) => (() => void) | void
const attempts = new Set<ClaudeAttempt>()
let owner: AttemptOwner | null = null

export function setClaudeAttemptOwner(next: AttemptOwner | null): void {
  owner = next
}

export function listClaudeAttempts(): readonly ClaudeAttempt[] {
  return Object.freeze([...attempts])
}

export function beginClaudeAttempt(input: Omit<ClaudeAttempt, 'done'>): {
  done: Promise<void>
  release(): void
} {
  let settle!: () => void
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const attempt = Object.freeze({ ...input, done })
  attempts.add(attempt)
  let releaseOwner: (() => void) | void
  try {
    releaseOwner = owner?.(input)
  } catch (error) {
    attempts.delete(attempt)
    settle()
    throw error
  }
  let released = false
  return {
    done,
    release() {
      if (released) return
      released = true
      try {
        releaseOwner?.()
      } finally {
        attempts.delete(attempt)
        settle()
      }
    },
  }
}
