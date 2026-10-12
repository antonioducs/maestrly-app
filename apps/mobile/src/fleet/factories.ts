import {
  FLEET_SCREEN,
  fleetBotSchema,
  fleetEnvironmentSchema,
  type FleetBot,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'

const STAMP = '2026-10-12T12:00:00.000Z'

/** A complete, schema-valid bot record from the fields that matter; the demo server and tests build bots with it. */
export function botRecord(fields: Partial<FleetBot> & Pick<FleetBot, 'id' | 'name'>): FleetBot {
  return fleetBotSchema.parse({
    role: '',
    instructions: '',
    tint: '#4f7cac',
    ceiling: 'ask',
    selection: null,
    talksTo: [],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'idle',
    activity: null,
    pendingCount: 0,
    accounts: { connected: true, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
    screen: { width: FLEET_SCREEN.width, height: FLEET_SCREEN.height, display: ':1' },
    appVersion: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...fields,
  })
}

export function environmentRecord(
  fields: Partial<FleetEnvironment> & Pick<FleetEnvironment, 'id' | 'name'>
): FleetEnvironment {
  return fleetEnvironmentSchema.parse({
    kind: 'bots',
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
    memoryLimitBytes: null,
    appVersion: null,
    botIds: [],
    createdAt: STAMP,
    updatedAt: STAMP,
    ...fields,
  })
}
