import {
  FLEET_PHONE_SCREENS_FEATURE,
  FLEET_UNIFIED_DESKTOP_FEATURE,
  FLEET_VIDEO_SCREENS_FEATURE,
  type FleetBot,
} from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { translator } from '../src/i18n/translate'
import { botRecord, environmentRecord } from '../src/fleet/factories'
import { fleetReducer, initialFleetState } from '../src/fleet/state'
import {
  botScreenSurface,
  botStatusLine,
  botWorksHere,
  botsByEnvironment,
  interactionForItem,
  isComposerLocked,
  ownsTakeover,
  statusLineText,
  waitingItems,
} from '../src/fleet/selectors'

const text = translator('en')
const at = (second: number) => `2026-10-12T12:00:${String(second).padStart(2, '0')}.000Z`
const studio = environmentRecord({ id: 'studio', name: 'studio' })
const research = environmentRecord({ id: 'research', name: 'research' })
const bots = [
  botRecord({ id: 'juno', name: 'Juno', role: 'QA tester', environmentId: 'studio', status: 'working' }),
  botRecord({ id: 'ledger', name: 'Ledger', role: 'Cost analyst', environmentId: 'research' }),
  botRecord({ id: 'atlas', name: 'Atlas', role: 'Release engineer', environmentId: 'studio' }),
  botRecord({ id: 'loose', name: 'Loose', role: 'Helper', environmentId: null }),
]
const inbox = [
  {
    botId: 'atlas',
    interaction: {
      kind: 'permission' as const,
      id: 'p2',
      at: at(5),
      title: 'Run',
      detail: null,
      tool: null,
      itemId: 'i2',
    },
  },
  {
    botId: 'atlas',
    interaction: { kind: 'help' as const, id: 'h1', at: at(1), reason: 'Login', itemId: 'i1' },
  },
  {
    botId: 'juno',
    interaction: { kind: 'question' as const, id: 'q1', at: at(3), questions: [], itemId: 'i3' },
  },
]
const state = fleetReducer(initialFleetState, { type: 'snapshot', bots, environments: [studio, research], inbox })

const line = (fields: Partial<FleetBot>) =>
  botStatusLine(botRecord({ id: 'b', name: 'B', role: 'Writer', ...fields }), text)

describe('fleet selectors', () => {
  it('groups bots by environment in server order and searches name, role and environment', () => {
    expect(
      botsByEnvironment(state, '').map((group) => [group.name, group.bots.map((bot) => bot.id), group.working])
    ).toEqual([
      ['studio', ['juno', 'atlas'], 1],
      ['research', ['ledger'], 0],
      ['Bots', ['loose'], 0],
    ])
    expect(botsByEnvironment(state, 'release').flatMap((group) => group.bots.map((bot) => bot.id))).toEqual(['atlas'])
    expect(botsByEnvironment(state, 'RESEARCH').flatMap((group) => group.bots.map((bot) => bot.id))).toEqual(['ledger'])
    expect(botsByEnvironment(state, 'nobody')).toEqual([])
  })

  it('lists one request per bot, the oldest first', () => {
    expect(waitingItems(state).map((item) => [item.bot.id, item.interaction.id])).toEqual([
      ['atlas', 'h1'],
      ['juno', 'q1'],
    ])
  })

  it('finds the request a transcript item stands for', () => {
    expect(interactionForItem(state, 'atlas', 'i2')?.id).toBe('p2')
    expect(interactionForItem(state, 'juno', 'i2')).toBeNull()
  })

  it('describes what each bot is doing', () => {
    expect(line({ status: 'waiting', activity: { kind: 'permission', title: 'Run' } })).toEqual({
      text: 'Needs your approval',
      tone: 'cue',
    })
    expect(line({ status: 'working', activity: { kind: 'tool', tool: 'bash', target: 'npm test' } })).toEqual({
      text: 'bash npm test',
      tone: 'mono',
    })
    expect(line({ status: 'working', activity: { kind: 'thinking' } }).text).toBe('Thinking…')
    expect(
      line({ status: 'idle', activity: { kind: 'idle', lastTurnSummary: 'Report delivered', lastTurnAt: null } }).text
    ).toBe('Report delivered')
    expect(line({ status: 'idle', activity: null }).text).toBe('Writer')
    expect(line({ status: 'setup', activity: { kind: 'setup', need: 'compaction' } }).text).toBe(
      'Needs a compaction model'
    )
    expect(line({ status: 'paused' }).text).toBe('Paused')
    expect(line({ status: 'offline' }).text).toBe('Stopped')
    expect(line({ status: 'starting' }).text).toBe('Starting…')
    expect(line({ status: 'human' }).text).toBe('You are using its screen')
  })

  it('shows a shell command as a prompt line', () => {
    const shell = botRecord({
      id: 'b',
      name: 'B',
      status: 'working',
      activity: { kind: 'tool', tool: 'bash', target: 'npm test' },
    })
    const read = botRecord({
      id: 'r',
      name: 'R',
      status: 'working',
      activity: { kind: 'tool', tool: 'read', target: 'a.md' },
    })
    expect(statusLineText(shell, botStatusLine(shell, text))).toBe('$ npm test')
    expect(statusLineText(read, botStatusLine(read, text))).toBe('read a.md')
  })

  it("tells when the bot's own conversation works, and not a routine run working beside it", () => {
    const startedAt = at(1)
    const routineOnly = botRecord({
      id: 'b',
      name: 'B',
      status: 'working',
      turns: [{ kind: 'routine', id: 'run-1', title: 'Prices', startedAt, tool: null, cancelling: false }],
    })
    expect(botWorksHere(routineOnly)).toBe(false)
    const both = botRecord({
      id: 'b',
      name: 'B',
      status: 'working',
      turns: [
        { kind: 'primary', id: null, title: '', startedAt, tool: null, cancelling: false },
        { kind: 'routine', id: 'run-1', title: 'Prices', startedAt, tool: null, cancelling: false },
      ],
    })
    expect(botWorksHere(both)).toBe(true)
    // A server that predates turns: working means the bot's own conversation, unless it works on a routine run.
    expect(botWorksHere(botRecord({ id: 'b', name: 'B', status: 'working' }))).toBe(true)
    const legacyRun = botRecord({
      id: 'b',
      name: 'B',
      status: 'working',
      runningRun: { id: 'run-1', routineId: 'r', title: 'Prices', startedAt },
    })
    expect(botWorksHere(legacyRun)).toBe(false)
  })

  it('locks the composer while the bot cannot take messages from the phone', () => {
    for (const status of ['paused', 'human', 'offline', 'starting', 'setup'] as const)
      expect(isComposerLocked(botRecord({ id: 'b', name: 'B', status }))).toBe(true)
    for (const status of ['idle', 'working', 'waiting'] as const)
      expect(isComposerLocked(botRecord({ id: 'b', name: 'B', status }))).toBe(false)
  })

  it('opens a bot’s screen only where the server lets phones and its environment streams video', () => {
    const video = (unified: boolean) =>
      environmentRecord({
        id: 'studio',
        name: 'studio',
        capabilities: [FLEET_VIDEO_SCREENS_FEATURE, ...(unified ? [FLEET_UNIFIED_DESKTOP_FEATURE] : [])],
      })
    const state = (features: string[], environment = video(true)) => ({ features, environments: [environment] })
    const juno = botRecord({ id: 'juno', name: 'Juno', environmentId: 'studio' })
    const phones = [FLEET_PHONE_SCREENS_FEATURE]
    // One desktop with the bot's browser as one more window; older images show the browser's area.
    expect(botScreenSurface(state(phones), juno)).toBe('apps')
    expect(botScreenSurface(state(phones, video(false)), juno)).toBe('browser')
    expect(botScreenSurface(state([]), juno)).toBeNull()
    expect(botScreenSurface(state(phones, environmentRecord({ id: 'studio', name: 'studio' })), juno)).toBeNull()
    expect(botScreenSurface(state(phones), { ...juno, status: 'offline' })).toBeNull()
    expect(botScreenSurface(state(phones), { ...juno, lifecycle: 'stopped' })).toBeNull()
    expect(botScreenSurface(state(phones, { ...video(true), lifecycle: 'stopped' }), juno)).toBeNull()

    const human = { state: 'human' as const, deviceId: 'phone', deviceName: 'Phone', since: at(1) }
    expect(ownsTakeover(human, 'phone')).toBe(true)
    expect(ownsTakeover(human, 'mac')).toBe(false)
    expect(ownsTakeover({ ...human, state: 'acquiring' }, 'phone')).toBe(false)
  })
})
