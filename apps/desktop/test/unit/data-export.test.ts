import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildExportBundle,
  EXPORT_SCHEMA_VERSION,
  filterExportableSettings,
} from '../../src/main/local-data/data-export'
import { closeDb, freshDb } from '../helpers/db'
import { getDb } from '../../src/main/store'
import { archiveLocalMemory, createLocalMemory } from '../../src/main/memory/local-memory-service'
import { makeWorkspace } from '../helpers/factories'

beforeEach(freshDb)
afterEach(closeDb)

describe('data export v7', () => {
  it('exposes the standalone export schema version', () => {
    expect(EXPORT_SCHEMA_VERSION).toBe(7)
  })

  it('excludes hosted metadata and secrets while preserving ordinary settings', () => {
    expect(
      filterExportableSettings([
        { key: 'license.state', value: '{"tier":"trial"}' },
        { key: 'license.device_id', value: 'device-1' },
        { key: 'provider.api_key', value: 'private' },
        { key: 'telemetry.enabled', value: 'true' },
        { key: 'cloud.state', value: '{}' },
        { key: 'ui.locale', value: 'pt-BR' },
      ])
    ).toEqual({
      'ui.locale': 'pt-BR',
    })
  })

  it('exports durable usage history without transcript contents', async () => {
    getDb()
      .prepare(
        `INSERT INTO chat_usage_ledger (message_id, provider_id, model_id, usage_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        'usage-1',
        'p',
        'm',
        JSON.stringify({
          usageVersion: 2,
          input: 10,
          output: 2,
          runtimeEstimatedCostUsd: 0.01,
          contextIdentity: 'export-private-hash',
        }),
        123
      )

    const bundle = await buildExportBundle()
    expect(bundle).not.toHaveProperty('account')
    expect(bundle).not.toHaveProperty('boards')
    expect(bundle).not.toHaveProperty('cardConversations')
    expect(bundle.meta).not.toHaveProperty('deviceId')
    expect(bundle.usageHistory).toEqual([
      {
        messageId: 'usage-1',
        providerId: 'p',
        modelId: 'm',
        usage: { usageVersion: 2, input: 10, output: 2, runtimeEstimatedCostUsd: 0.01 },
        createdAt: 123,
      },
    ])
    expect(bundle.usageHistory[0]?.usage).not.toHaveProperty('contextIdentity')
    expect(JSON.stringify(bundle.usageHistory)).not.toContain('parts')
    expect(JSON.stringify(bundle.usageHistory)).not.toContain('tool output')
  })

  it('reports corrupt usage records as export omissions', async () => {
    getDb()
      .prepare(`INSERT INTO chat_usage_ledger (message_id, provider_id, model_id, usage_json, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run('corrupt', 'p', 'm', '{', 123)
    const bundle = await buildExportBundle()
    expect(bundle.usageHistory).toEqual([])
    expect(bundle.omissions).toContain('Could not read usage record corrupt.')
  })

  it('includes all durable local memories without search indexes or embeddings', async () => {
    const workspace = makeWorkspace()
    const active = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Release decision',
      content: 'Use signed tags.',
      type: 'decision',
      tags: ['release'],
      source: 'user',
    }).memory
    const archived = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Old procedure',
      content: 'Historical deployment procedure.',
      type: 'procedure',
      source: 'agent',
    }).memory
    archiveLocalMemory(workspace.id, archived.id)

    const bundle = await buildExportBundle()

    expect(bundle.localMemories).toEqual([
      {
        workspaceId: workspace.id,
        memories: expect.arrayContaining([
          expect.objectContaining({ id: active.id, status: 'active', content: 'Use signed tags.' }),
          expect.objectContaining({ id: archived.id, status: 'archived', content: 'Historical deployment procedure.' }),
        ]),
      },
    ])
    const serialized = JSON.stringify(bundle.localMemories)
    expect(serialized).not.toContain('embedding')
    expect(serialized).not.toContain('chunkId')
  })
})
