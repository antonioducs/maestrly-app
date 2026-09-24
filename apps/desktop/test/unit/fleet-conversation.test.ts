import { describe, expect, it } from 'vitest'
import { fleetConversationCallRequestSchema } from '@maestrly/bot-fleet-protocol'
import { projectFleetChatConfig, validateFleetConversationArgs } from '../../src/main/fleet/instance/conversation'

describe('fleet conversation boundary', () => {
  it('rejects caller supplied conversation identifiers and extra op arguments', () => {
    expect(
      fleetConversationCallRequestSchema.safeParse({ op: 'chatGetConvTools', args: [], conversationId: 'other' })
        .success
    ).toBe(false)
    expect(() => validateFleetConversationArgs('chatGetConvTools', ['other'])).toThrow()
    expect(() => validateFleetConversationArgs('chatSetConvTools', [{ imageGen: false }, 'other'])).toThrow()
    expect(() => validateFleetConversationArgs('chatSetConvTools', [{ imageGen: false }])).not.toThrow()
  })

  it('projects chat config to only safe menu fields', () => {
    expect(
      projectFleetChatConfig({
        providers: [{ id: 'secret', apiKey: 'private' }],
        mcpServers: [
          {
            id: 'server',
            name: 'Server',
            transport: 'http',
            enabled: true,
            url: 'https://user:secret@example.test',
            command: 'secret',
          },
        ],
        appToolsEnabled: true,
        imageGenEnabled: false,
        storageMode: 'keychain',
      } as never)
    ).toEqual({
      mcpServers: [{ id: 'server', name: 'Server', transport: 'http', enabled: true }],
      appToolsEnabled: true,
      imageGenEnabled: false,
    })
  })
})
