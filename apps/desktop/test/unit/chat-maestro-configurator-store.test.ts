import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import {
  appendMaestroConfiguratorMessage,
  getMaestroConfiguratorThread,
  getStoredMaestroConfiguratorProfile,
  resetMaestroConfiguratorThread,
  sanitizeMaestroConfiguratorEvent,
  setStoredMaestroConfiguratorProfile,
  updateMaestroConfiguratorMessage,
} from '../../src/main/chat/maestro-configurator-store'

beforeEach(freshDb)
afterEach(closeDb)

describe('Maestro configurator persistence', () => {
  it('keeps a bounded global thread and resets it independently of project chats', () => {
    for (let index = 0; index < 45; index++) {
      appendMaestroConfiguratorMessage({
        id: `message-${index}`,
        role: index % 2 ? 'assistant' : 'user',
        text: `message ${index}`,
        createdAt: index,
      })
    }
    const thread = getMaestroConfiguratorThread()
    expect(thread.messages).toHaveLength(40)
    expect(thread.messages[0].id).toBe('message-5')
    expect(resetMaestroConfiguratorThread().messages).toEqual([])
  })

  it('keeps editor events and image transcriptions, and drops malformed ones', () => {
    appendMaestroConfiguratorMessage({
      id: 'u1',
      role: 'user',
      text: '',
      createdAt: 1,
      images: [
        { name: 'pool.png', mediaType: 'image/png', byteSize: 12, description: 'A Pool with six roles.' },
        { name: 42 } as never,
      ],
    })
    appendMaestroConfiguratorMessage({
      id: 'e1',
      role: 'event',
      text: 'applied',
      createdAt: 2,
      event: { kind: 'proposal-applied', proposalId: 'p1' },
    })
    appendMaestroConfiguratorMessage({
      id: 'e2',
      role: 'event',
      text: 'bogus',
      createdAt: 3,
      event: { kind: 'saved', target: 'elsewhere' } as never,
    })
    expect(getMaestroConfiguratorThread().messages).toEqual([
      {
        id: 'u1',
        role: 'user',
        text: '',
        createdAt: 1,
        images: [{ name: 'pool.png', mediaType: 'image/png', byteSize: 12, description: 'A Pool with six roles.' }],
      },
      { id: 'e1', role: 'event', text: 'applied', createdAt: 2, event: { kind: 'proposal-applied', proposalId: 'p1' } },
    ])
    updateMaestroConfiguratorMessage({ id: 'u1', role: 'user', text: 'updated', createdAt: 1 })
    expect(getMaestroConfiguratorThread().messages[0]).toEqual({
      id: 'u1',
      role: 'user',
      text: 'updated',
      createdAt: 1,
    })
  })

  it('keeps which parts of a proposal were left out and drops anything that is not a unit key', () => {
    expect(
      sanitizeMaestroConfiguratorEvent({
        kind: 'proposal-applied',
        proposalId: 'p1',
        skipped: ['strategy', 'resource:reviewer', 'strategy', 'pool', 42, 'resource:'],
      })
    ).toEqual({ kind: 'proposal-applied', proposalId: 'p1', skipped: ['strategy', 'resource:reviewer'] })
    expect(sanitizeMaestroConfiguratorEvent({ kind: 'proposal-applied', proposalId: 'p1', skipped: [] })).toEqual({
      kind: 'proposal-applied',
      proposalId: 'p1',
    })
    expect(sanitizeMaestroConfiguratorEvent({ kind: 'proposal-dismissed', proposalId: 'p2' })).toEqual({
      kind: 'proposal-dismissed',
      proposalId: 'p2',
    })
    expect(sanitizeMaestroConfiguratorEvent({ kind: 'proposal-dismissed' })).toBeNull()
  })

  it('persists only the public provider/model/effort/Fast profile axes', () => {
    setStoredMaestroConfiguratorProfile({
      providerId: ' provider ',
      modelId: ' model ',
      effort: ' HIGH ',
      fastMode: true,
    })
    expect(getStoredMaestroConfiguratorProfile()).toEqual({
      providerId: 'provider',
      modelId: 'model',
      effort: 'high',
      fastMode: true,
    })
  })
})
