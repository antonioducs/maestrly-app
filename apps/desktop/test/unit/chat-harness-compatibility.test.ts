import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeStore, getDb, initStore } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getCodexThreadBinding, putCodexThreadBinding } from '../../src/main/chat/codex-subscription/thread-store'
import {
  canonicalJson,
  compareHarnessCompatibility,
  createHarnessSnapshot,
  snapshotAllowsResume,
} from '../../src/main/chat/harness/compatibility'
import { resolveChatHarness } from '../../src/main/chat/harness/execution'
import { createHarnessRegistry } from '../../src/main/chat/harness/registry'
import { resolveHarness } from '../../src/main/chat/harness/resolver'
import { canReplayOpenAIInferenceState, parseOpenAIInferenceState } from '../../src/main/chat/openai/inference-store'
import { INVALID_HARNESS_SNAPSHOT, parseHarnessSnapshot, readHarnessSnapshotJson } from '../../src/shared/harness'
import { createOpenAIResponsesLedger } from '../../src/main/chat/openai/ledger'

const FINGERPRINT = 'a'.repeat(64)

describe('harness snapshots', () => {
  it('captures only serializable contract identity', () => {
    const harness = resolveChatHarness('claude-subscription', 'claude-opus-5').harness
    const snapshot = createHarnessSnapshot(harness)
    expect(Object.keys(snapshot).sort()).toEqual(
      ['compatibilityGroup', 'contractId', 'definitionHash', 'profileId', 'profileVersion', 'snapshotVersion'].sort()
    )
    expect(JSON.stringify(snapshot)).not.toContain('Lead with the outcome')
    expect(parseHarnessSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
  })

  it('distinguishes a corrupt snapshot from an absent one', () => {
    expect(readHarnessSnapshotJson(null)).toBeNull()
    expect(readHarnessSnapshotJson('{not json')).toBe(INVALID_HARNESS_SNAPSHOT)
    expect(readHarnessSnapshotJson('{"snapshotVersion":99}')).toBe(INVALID_HARNESS_SNAPSHOT)
    expect(parseHarnessSnapshot({ snapshotVersion: 2 })).toBeNull()
    const state = {
      version: 4,
      providerId: 'p',
      modelId: 'gpt-5.4',
      providerFingerprint: FINGERPRINT,
      modelHarnessProfileId: 'openai-default-v1',
      ledger: createOpenAIResponsesLedger(),
    }
    expect(parseOpenAIInferenceState(state)).not.toBeNull()
    expect(parseOpenAIInferenceState({ ...state, harnessSnapshot: { snapshotVersion: 9 } })).toBeNull()
  })

  it('round-trips an unknown but well-formed identity without turning it into the default', () => {
    const parsed = parseOpenAIInferenceState({
      version: 4,
      providerId: 'p',
      modelId: 'future-model',
      providerFingerprint: FINGERPRINT,
      modelHarnessProfileId: 'maestrly-future-model-v3',
      ledger: createOpenAIResponsesLedger(),
    })
    expect(parsed?.modelHarnessProfileId).toBe('maestrly-future-model-v3')
    expect(
      parseOpenAIInferenceState({
        version: 4,
        providerId: 'p',
        modelId: 'm',
        providerFingerprint: FINGERPRINT,
        modelHarnessProfileId: 'Not A Valid Id!',
        ledger: createOpenAIResponsesLedger(),
      })
    ).toBeNull()
  })
})

describe('harness compatibility', () => {
  it('keeps Codex Sol/Luna continuity on the same default contract', () => {
    const sol = resolveChatHarness('codex-subscription', 'gpt-5.6-sol').harness
    const luna = resolveChatHarness('codex-subscription', 'gpt-5.6-luna').harness
    expect(compareHarnessCompatibility(createHarnessSnapshot(sol), luna)).toEqual({ compatible: true, reason: 'match' })
  })

  it('marks Astra and the default contract incompatible', () => {
    const astra = resolveChatHarness('codex-subscription', 'gpt-6-astra').harness
    const plain = resolveChatHarness('codex-subscription', 'gpt-5.6-sol').harness
    expect(compareHarnessCompatibility(createHarnessSnapshot(astra), plain).compatible).toBe(false)
    expect(snapshotAllowsResume(createHarnessSnapshot(astra), plain)).toBe(false)
  })

  it('treats a missing snapshot as legacy, never as a forged match', () => {
    const plain = resolveChatHarness('codex-subscription', 'gpt-5.6-sol').harness
    expect(compareHarnessCompatibility(null, plain)).toEqual({ compatible: false, reason: 'legacy-missing-snapshot' })
    // The transport keeps its own legacy proof; the snapshot gate does not block it.
    expect(snapshotAllowsResume(null, plain)).toBe(true)
  })

  it('blocks resume when a snapshot is present but corrupt', () => {
    const plain = resolveChatHarness('codex-subscription', 'gpt-5.6-sol').harness
    const corrupt = readHarnessSnapshotJson('{bad')
    const wrongVersion = readHarnessSnapshotJson('{"snapshotVersion":99}')
    expect(corrupt).toBe(INVALID_HARNESS_SNAPSHOT)
    expect(wrongVersion).toBe(INVALID_HARNESS_SNAPSHOT)
    expect(snapshotAllowsResume(corrupt, plain)).toBe(false)
    expect(snapshotAllowsResume(wrongVersion, plain)).toBe(false)
  })

  it('invalidates a session when a prompt text changes even without a version bump', () => {
    const config = JSON.stringify({
      schemaVersion: 1,
      id: 'default-test',
      profileVersion: 1,
      bindings: [{ providerKind: '*', overrides: { prompts: { styleAndWork: 'style.md' } } }],
    })
    const before = createHarnessRegistry({
      'profiles/default/config.json': config,
      'profiles/default/style.md': 'ORIGINAL',
    })
    const after = createHarnessRegistry({
      'profiles/default/config.json': config,
      'profiles/default/style.md': 'CHANGED',
    })
    const crlf = createHarnessRegistry({
      'profiles/default/config.json': config,
      'profiles/default/style.md': 'ORIGINAL\r\n',
    })
    const resolve = (registry: ReturnType<typeof createHarnessRegistry>) => {
      const result = resolveHarness({ providerKind: 'anthropic', requestedModelId: 'x' }, registry)
      if (!result.ok) throw new Error(result.reason)
      return result.harness
    }
    const saved = createHarnessSnapshot(resolve(before))
    expect(compareHarnessCompatibility(saved, resolve(after))).toEqual({
      compatible: false,
      reason: 'definition-changed',
    })
    expect(compareHarnessCompatibility(saved, resolve(crlf)).compatible).toBe(true)
  })

  it('does not depend on volatile environment, date or user text', () => {
    const first = resolveChatHarness('claude-subscription', 'claude-fable-5-1').harness
    const second = resolveChatHarness('claude-subscription', 'claude-fable-5-1').harness
    expect(first.definitionHash).toBe(second.definitionHash)
  })

  it('serializes canonically regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 'x\r\n' } })).toBe(canonicalJson({ a: { c: 'x', d: 2 }, b: 1 }))
  })

  it('rejects replay of an OpenAI sidecar recorded under another contract', () => {
    const astra = createHarnessSnapshot(
      resolveChatHarness('openai-responses', 'gpt-6-astra', 'https://api.openai.com/v1').harness
    )
    const stale = { ...astra, definitionHash: 'b'.repeat(64) }
    const state = {
      version: 4 as const,
      providerId: 'p',
      modelId: 'gpt-6-astra',
      providerFingerprint: FINGERPRINT,
      modelHarnessProfileId: 'openai-gpt-6-astra-v1',
      harnessSnapshot: stale,
      ledger: createOpenAIResponsesLedger(),
    }
    const current = { ...state, harnessSnapshot: astra }
    expect(canReplayOpenAIInferenceState(state, current)).toBe(false)
    expect(canReplayOpenAIInferenceState({ ...state, harnessSnapshot: astra }, current)).toBe(true)
    expect(canReplayOpenAIInferenceState(state, { ...current, providerFingerprint: 'c'.repeat(64) })).toBe(false)
    // Legacy row without a snapshot stays replayable under the existing identity checks.
    const { harnessSnapshot: _omit, ...legacy } = state
    expect(canReplayOpenAIInferenceState(legacy, current)).toBe(true)
  })
})

const TABLES = ['chat_codex_threads', 'chat_github_copilot_sessions', 'chat_claude_sessions'] as const

describe('harness snapshot migration', () => {
  let dir: string | null = null
  afterEach(() => {
    closeStore()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('adds the nullable column to a pre-snapshot database, idempotently, keeping existing rows', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'harness-migration-'))
    const file = path.join(dir, 'test.db')
    initStore(file)
    closeStore()
    // Rebuild the three tables exactly as they existed before the snapshot column.
    const legacy = new DatabaseSync(file)
    legacy.exec('PRAGMA foreign_keys=OFF;')
    for (const table of TABLES) {
      const columns = (legacy.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((column) => column.name)
        .filter((name) => name !== 'harness_snapshot_json')
      legacy.exec(`CREATE TABLE ${table}_old AS SELECT ${columns.join(', ')} FROM ${table};`)
      legacy.exec(`DROP TABLE ${table};`)
      legacy.exec(`ALTER TABLE ${table}_old RENAME TO ${table};`)
    }
    legacy.exec(`INSERT INTO chat_codex_threads (conversation_id, thread_id, model_id, tool_signature,
      instruction_hash, harness_profile, last_message_id, usage_json, account_id, updated_at)
      VALUES ('legacy-conv', 'thread-1', 'gpt-5.6-sol', 'tools', '', 'openai-default-v1', 'm', '{}', '', 1);`)
    legacy.close()

    initStore(file)
    closeStore()
    initStore(file)
    for (const table of TABLES) {
      const names = (getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name
      )
      expect(names.filter((name) => name === 'harness_snapshot_json'), table).toHaveLength(1)
    }
    const binding = getCodexThreadBinding('legacy-conv')
    expect(binding?.harnessProfile).toBe('openai-default-v1')
    expect(binding?.harnessSnapshot).toBeNull()
  })
})

describe('harness snapshot persistence', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('round-trips a new profile identity and its snapshot without editing the store', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const snapshot = createHarnessSnapshot(resolveChatHarness('codex-subscription', 'gpt-6-astra').harness)
    putCodexThreadBinding({
      conversationId: conversation.id,
      threadId: 'thread',
      modelId: 'future-model',
      toolSignature: 'tools',
      instructionHash: 'instructions',
      harnessProfile: 'maestrly-future-model-v7',
      harnessSnapshot: snapshot,
      lastMessageId: 'message',
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    })
    const binding = getCodexThreadBinding(conversation.id)
    expect(binding?.harnessProfile).toBe('maestrly-future-model-v7')
    expect(binding?.harnessSnapshot).toEqual(snapshot)
  })

  it('blocks resume for a present but corrupt stored snapshot', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    putCodexThreadBinding({
      conversationId: conversation.id,
      threadId: 'thread',
      modelId: 'gpt-5.6-sol',
      toolSignature: 'tools',
      lastMessageId: 'message',
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    })
    const harness = resolveChatHarness('codex-subscription', 'gpt-5.6-sol').harness
    for (const snapshotJson of ['{bad', '{"snapshotVersion":99}']) {
      getDb()
        .prepare('UPDATE chat_codex_threads SET harness_snapshot_json = ? WHERE conversation_id = ?')
        .run(snapshotJson, conversation.id)
      const binding = getCodexThreadBinding(conversation.id)
      expect(binding?.harnessSnapshot).toBe(INVALID_HARNESS_SNAPSHOT)
      expect(snapshotAllowsResume(binding?.harnessSnapshot ?? null, harness)).toBe(false)
    }
  })
})
