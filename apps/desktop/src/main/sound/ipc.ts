import type { WebContents } from 'electron'
import type { SoundPlayAck, SoundPlaybackFailure } from '../../shared/sound-playback'
import type { IpcRegistrar } from '../ipc-registrar'
import { getMainWebContents } from '../window-ipc'
import { soundService, type SoundService } from './service'

const ACK_FAILURES = new Set<SoundPlaybackFailure>([
  'asset-missing',
  'asset-read-failed',
  'renderer-unavailable',
  'context-suspended',
  'decode-failed',
  'start-failed',
  'timeout',
])

function validAck(value: unknown): value is SoundPlayAck {
  if (!value || typeof value !== 'object') return false
  const ack = value as Record<string, unknown>
  if (typeof ack.requestId !== 'string' || !ack.requestId) return false
  if (ack.status === 'started') return true
  return ack.status === 'failed' && ACK_FAILURES.has(ack.reason as SoundPlaybackFailure)
}

export interface SoundIpcDeps {
  service: SoundService
  getTarget: () => WebContents | null
}

export function registerSoundIpc(
  reg: IpcRegistrar,
  deps: SoundIpcDeps = { service: soundService, getTarget: getMainWebContents },
): void {
  reg.mon('sound:renderer-ready', (event) => {
    if (event.sender === deps.getTarget()) deps.service.setRendererReady(event.sender)
  })
  reg.mon('sound:ack', (event, ack: unknown) => {
    if (event.sender === deps.getTarget() && validAck(ack)) deps.service.acknowledge(event.sender, ack)
  })
}
