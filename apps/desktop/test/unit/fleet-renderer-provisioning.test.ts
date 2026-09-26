import { describe, expect, it } from 'vitest'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import type { MacInventory } from '../../src/shared/fleet-provisioning'
import type { FleetController } from '../../src/renderer/lib/fleet/use-fleet'
import {
  accountHost,
  emptyImportChoice,
  hasImportChoice,
  recommendedImportChoice,
  provisioningAvailability,
} from '../../src/renderer/lib/fleet/provisioning'

describe('fleet provisioning choices', () => {
  const inventory: MacInventory = {
    apiKeys: [
      { id: 'remote', name: 'Remote', kind: 'openai', host: 'api.example.test', localOnly: false },
      { id: 'local', name: 'Local', kind: 'openai', host: 'localhost', localOnly: true },
    ],
    copies: [{ id: 'cursor', kind: 'cursor', label: 'Cursor', expiresAt: null }],
    logins: [{ id: 'grok', kind: 'grok', label: 'Grok', email: null }],
    skills: [
      { name: 'ready', description: '', files: 1, bytes: 10, scripts: false, problem: null },
      { name: 'broken', description: '', files: 1, bytes: 10, scripts: false, problem: 'no-skill-md' },
    ],
    mcpServers: [
      { id: 'ready', name: 'Ready', transport: 'stdio', target: 'node', warnings: [], recommended: true },
      {
        id: 'local',
        name: 'Local',
        transport: 'http',
        target: 'localhost',
        warnings: ['local-url'],
        recommended: true,
      },
    ],
  }
  it('starts local-only, problematic and warned items unselected', () => {
    expect(recommendedImportChoice(inventory, ['accounts', 'skills', 'mcp'])).toEqual({
      apiKeyIds: ['remote'],
      copyIds: ['cursor'],
      loginIds: ['grok'],
      skillNames: ['ready'],
      mcpServerIds: ['ready'],
    })
  })
  it('never selects accounts or logins for the skills and MCP dialog', () => {
    expect(recommendedImportChoice(inventory, ['skills', 'mcp'])).toMatchObject({
      apiKeyIds: [],
      copyIds: [],
      loginIds: [],
    })
  })
  it('distinguishes an empty creation from a login-only creation', () => {
    expect(hasImportChoice(emptyImportChoice())).toBe(false)
    expect(hasImportChoice({ ...emptyImportChoice(), loginIds: ['grok'] })).toBe(true)
  })
  it('checks the server feature before bot capabilities', () => {
    const fleet = (features: string[]) => ({ state: { connection: { features } } }) as FleetController
    const bot = (lifecycle: FleetBot['lifecycle'], capabilities: string[]) => ({ lifecycle, capabilities }) as FleetBot
    expect(provisioningAvailability(fleet([]), bot('running', ['provisioning']))).toBe('update-server')
    expect(provisioningAvailability(fleet(['provisioning']), bot('running', []))).toBe('restart-bot')
    expect(provisioningAvailability(fleet(['provisioning']), bot('running', ['provisioning']))).toBe('ready')
    expect(provisioningAvailability(fleet(['provisioning']), bot('creating', []))).toBe('ready')
  })
  it('matches default provider hosts and preserves nondefault ports', () => {
    expect(accountHost('anthropic', null)).toBe('api.anthropic.com')
    expect(accountHost('openai-responses', null)).toBe('api.openai.com')
    expect(accountHost('openai', 'https://models.example.test:8080/v1')).toBe('models.example.test:8080')
  })
})
