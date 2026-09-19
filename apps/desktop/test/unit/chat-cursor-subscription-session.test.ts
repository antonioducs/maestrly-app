import { describe, expect, it } from 'vitest'
import {
  buildCursorSeedTranscript,
  cursorUserInputText,
  hashCursorHarnessEnvelope,
  isCursorAgentBindingCompatible,
  type CursorHarnessEnvelope,
} from '../../src/main/chat/cursor-subscription/session'
import type { CursorAgentBinding } from '../../src/main/chat/cursor-subscription/session-store'
import type { ChatMessage } from '../../src/shared/chat'

function binding(overrides: Partial<CursorAgentBinding> = {}): CursorAgentBinding {
  return {
    conversationId: 'conv-1',
    agentId: 'agent-1',
    modelId: 'composer-2.5',
    modelParams: [{ id: 'fast', value: 'false' }],
    cwd: '/repo',
    harnessProfile: 'cursor-subscription-v1',
    instructionHash: 'h1',
    toolSignature: 'sig1',
    lastMessageId: 'last-1',
    accountFingerprint: 'user:7',
    accountId: null,
    usageJson: '{}',
    updatedAt: 1,
    ...overrides,
  }
}

function input(
  overrides: Partial<Parameters<typeof isCursorAgentBindingCompatible>[0]> = {}
): Parameters<typeof isCursorAgentBindingCompatible>[0] {
  return {
    binding: binding(),
    previousMessageId: 'last-1',
    modelId: 'composer-2.5',
    modelParams: [{ id: 'fast', value: 'false' }],
    cwd: '/repo',
    harnessProfile: 'cursor-subscription-v1',
    instructionHash: 'h1',
    toolSignature: 'sig1',
    accountFingerprint: 'user:7',
    accountId: null,
    ...overrides,
  }
}

describe('isCursorAgentBindingCompatible', () => {
  it('resumes only when all compatibility invariants match', () => {
    expect(isCursorAgentBindingCompatible(input())).toBe(true)
  })

  it('rejects missing bindings or previous messages', () => {
    expect(isCursorAgentBindingCompatible(input({ binding: null }))).toBe(false)
    expect(isCursorAgentBindingCompatible(input({ previousMessageId: null }))).toBe(false)
  })

  it.each([
    ['modelId', { modelId: 'other' }],
    ['modelParams', { modelParams: [{ id: 'fast', value: 'true' }] }],
    ['empty model parameters', { modelParams: [] }],
    ['cwd', { cwd: '/other' }],
    ['harnessProfile', { harnessProfile: 'other-v1' }],
    ['instructionHash', { instructionHash: 'h2' }],
    ['toolSignature', { toolSignature: 'sig2' }],
    ['accountFingerprint', { accountFingerprint: 'user:8' }],
    ['accountId', { accountId: 'acc_A' }],
    ['different previous message', { previousMessageId: 'last-9' }],
  ] as const)('invalidates on %s', (_name, patch) => {
    expect(isCursorAgentBindingCompatible(input(patch as never))).toBe(false)
  })

  it('preserves durable compatibility across process restarts', () => {
    expect(
      isCursorAgentBindingCompatible(
        input({ accountFingerprint: 'user:7', accountId: null, previousMessageId: 'last-1' })
      )
    ).toBe(true)
  })
})

describe('seed / envelope', () => {
  function message(id: string, text: string): ChatMessage {
    return {
      id,
      conversationId: 'conv-1',
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: 1,
    } as ChatMessage
  }

  it('seeds previous history without the current message', () => {
    const seed = buildCursorSeedTranscript([message('m1', 'primeira'), message('m2', 'segunda')])
    expect(seed).toContain('primeira')
    expect(seed).not.toContain('segunda')
  })

  it('combines seed context with the current user input', () => {
    const input = cursorUserInputText(message('m2', 'segunda'), 'SEED_TEXT')
    expect(input).toContain('SEED_TEXT')
    expect(input).toContain('segunda')
  })

  it('hashes envelopes deterministically and includes mode and instructions', () => {
    const base: CursorHarnessEnvelope = {
      mode: 'agent',
      modelId: 'composer-2.5',
      cwd: '/repo',
      projectContext: 'ctx',
      skillCatalog: '',
      agentCatalog: '',
      environment: 'OS: macOS',
      ultra: false,
      instructions: 'use only offered tools',
    }
    const a = hashCursorHarnessEnvelope(base)
    const b = hashCursorHarnessEnvelope({ ...base })
    const c = hashCursorHarnessEnvelope({ ...base, instructions: 'other' })
    const d = hashCursorHarnessEnvelope({ ...base, mode: 'plan' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
  })
})
