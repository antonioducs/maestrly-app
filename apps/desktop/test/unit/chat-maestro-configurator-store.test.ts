import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import {
  appendMaestroConfiguratorMessage,
  getMaestroConfiguratorThread,
  getStoredMaestroConfiguratorProfile,
  resetMaestroConfiguratorThread,
  setStoredMaestroConfiguratorProfile,
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
