import { FLEET_ENVIRONMENT_LIMITS, FLEET_ENVIRONMENTS_FEATURE } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createBotIssue,
  environmentChoices,
  initialEnvironment,
  joinAvailability,
  newBotRequest,
  type NewBotForm,
} from '../src/fleet/create-bot'
import { environmentRecord } from '../src/fleet/factories'
import { GatewayError } from '../src/gateway/client'

const capable = { capabilities: [FLEET_ENVIRONMENTS_FEATURE] }
const studio = environmentRecord({ id: 'studio', name: 'studio', ...capable })
const form: NewBotForm = {
  name: '  Juno ',
  instructions: ' Ship it \n',
  environmentId: 'studio',
  ceiling: 'auto',
  talksTo: [],
}

describe('joining an environment from the phone', () => {
  it('takes a bot only in a running environment with room, on an image that hosts several bots', () => {
    expect(joinAvailability(studio)).toBe('ready')
    const ids = Array.from({ length: FLEET_ENVIRONMENT_LIMITS.botsMax }, (_, index) => `bot${index}`)
    expect(joinAvailability({ ...studio, botIds: ids })).toBe('full')
    expect(joinAvailability({ ...studio, lifecycle: 'stopped' })).toBe('stopped')
    expect(joinAvailability({ ...studio, lifecycle: 'failed' })).toBe('stopped')
    expect(joinAvailability({ ...studio, lifecycle: 'restarting' })).toBe('starting')
    expect(joinAvailability({ ...studio, capabilities: [] })).toBe('restart')
  })

  it('offers the environments of bots, not those of workspaces or archived ones', () => {
    const list = [
      studio,
      environmentRecord({ id: 'personal', name: 'Personal', kind: 'workspaces', ...capable }),
      environmentRecord({ id: 'old', name: 'old', lifecycle: 'archived', ...capable }),
      environmentRecord({ id: 'lab', name: 'lab', lifecycle: 'stopped', ...capable }),
    ]
    expect(environmentChoices(list).map(({ environment, availability }) => [environment.id, availability])).toEqual([
      ['studio', 'ready'],
      ['lab', 'stopped'],
    ])
  })

  it('starts on the environment asked for, else the only one that can take a bot', () => {
    const lab = environmentRecord({ id: 'lab', name: 'lab', ...capable })
    const stopped = environmentRecord({ id: 'stopped', name: 'stopped', lifecycle: 'stopped', ...capable })
    expect(initialEnvironment(environmentChoices([studio, lab]), 'lab')).toBe('lab')
    // Two could take it: the owner picks.
    expect(initialEnvironment(environmentChoices([studio, lab]), null)).toBeNull()
    expect(initialEnvironment(environmentChoices([studio, stopped]), 'stopped')).toBe('studio')
    expect(initialEnvironment(environmentChoices([stopped]), null)).toBeNull()
  })
})

describe('the create request', () => {
  it('trims the text, joins the chosen environment and leaves publishing to the server', () => {
    expect(newBotRequest({ ...form, talksTo: ['atlas', 'atlas', 'pixel'] })).toEqual({
      ok: true,
      request: {
        name: 'Juno',
        instructions: 'Ship it',
        ceiling: 'auto',
        talksTo: ['atlas', 'pixel'],
        environmentId: 'studio',
      },
    })
  })

  it('needs a name and an environment', () => {
    expect(newBotRequest({ ...form, name: '   ' })).toEqual({ ok: false, problem: 'name' })
    expect(newBotRequest({ ...form, environmentId: null })).toEqual({ ok: false, problem: 'environment' })
  })

  it('says why the server did not create the bot', () => {
    expect(createBotIssue(new GatewayError('NETWORK', 0, 'down'))).toBe('offline')
    expect(createBotIssue(new GatewayError('TIMEOUT', 0, 'slow'))).toBe('offline')
    expect(createBotIssue(new GatewayError('NOT_FOUND', 404, 'Environment not found'))).toBe('gone')
    expect(createBotIssue(new GatewayError('CONFLICT', 409, 'This environment already has 8 bots.'))).toBe('cannotJoin')
    expect(createBotIssue(new GatewayError('PROTOCOL_INCOMPATIBLE', 426, 'old'))).toBe('outdated')
    expect(createBotIssue(new GatewayError('INVALID_REQUEST', 400, 'bad'))).toBe('invalid')
    expect(createBotIssue(new GatewayError('INTERNAL', 500, 'boom'))).toBe('failed')
    expect(createBotIssue(z.string().safeParse(1).error)).toBe('invalid')
    expect(createBotIssue(new Error('other'))).toBe('failed')
  })
})
