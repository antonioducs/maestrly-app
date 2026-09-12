import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { automationMayTrigger } from '../src/modules/automation/triggers.js'

describe('server safety defaults', () => {
  it('keeps public signup and test authentication disabled', () => {
    const config = loadConfig({})
    expect(config.publicSignup).toBe(false)
    expect(config.allowTestAuth).toBe(false)
  })

  it('rejects insecure production origins and secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', MIGRATION_DATABASE_URL: 'postgres://migrate', DATABASE_URL: 'postgres://runtime' })).toThrow(/BETTER_AUTH_SECRET|HTTPS/)
  })

  it('does not create agent automation cycles by default', () => {
    expect(automationMayTrigger({ changedColumn: true, source: 'agent', allowAutomationChain: false, chainDepth: 0 })).toBe(false)
    expect(automationMayTrigger({ changedColumn: true, source: 'agent', allowAutomationChain: true, chainDepth: 5 })).toBe(false)
    expect(automationMayTrigger({ changedColumn: true, source: 'human', allowAutomationChain: false, chainDepth: 0 })).toBe(true)
  })
})
