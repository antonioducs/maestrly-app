import type { FleetBot, FleetTakeoverState } from '@maestrly/bot-fleet-protocol'

export function ownsTakeover(takeover: FleetTakeoverState, deviceId: string | null): boolean {
  return takeover.state === 'human' && deviceId !== null && takeover.deviceId === deviceId
}

export function takeoverBlocksResume(takeover: FleetTakeoverState): boolean {
  return takeover.state !== 'none'
}

export function botsWithDifferentVersion(bots: FleetBot[], macVersion: string): FleetBot[] {
  return macVersion ? bots.filter((bot) => bot.appVersion !== null && bot.appVersion !== macVersion) : []
}
