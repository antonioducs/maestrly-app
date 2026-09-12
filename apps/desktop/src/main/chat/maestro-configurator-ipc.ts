import type { IpcMainInvokeEvent } from 'electron'
import {
  MAESTRO_CONFIGURATOR_EVENT_CHANNEL,
  type MaestroConfiguratorEvent,
  type MaestroConfiguratorProfile,
  type MaestroConfiguratorSendInput,
} from '../../shared/maestro-configurator'
import { maestroConfiguratorService, type MaestroConfiguratorService } from './maestro-configurator'

interface MaestroConfiguratorIpcDependencies {
  mhandle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void
  service?: Pick<MaestroConfiguratorService, 'state' | 'setProfile' | 'send' | 'cancel' | 'reset'>
}

const profileFrom = (value: unknown): MaestroConfiguratorProfile => {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return {
    providerId: typeof raw.providerId === 'string' ? raw.providerId : '',
    modelId: typeof raw.modelId === 'string' ? raw.modelId : '',
    effort: typeof raw.effort === 'string' ? raw.effort : 'off',
    ...(raw.fastMode === true ? { fastMode: true } : {}),
  }
}

/** IPC boundary stays deliberately small: model output never reaches a settings setter. */
export function registerMaestroConfiguratorIpc(dependencies: MaestroConfiguratorIpcDependencies): void {
  const service = dependencies.service ?? maestroConfiguratorService
  dependencies.mhandle('chat:maestro-configurator:state', () => service.state())
  dependencies.mhandle('chat:maestro-configurator:set-profile', (_event, value: unknown) =>
    service.setProfile(profileFrom(value))
  )
  dependencies.mhandle('chat:maestro-configurator:send', (event, value: unknown) => {
    const emit = (payload: MaestroConfiguratorEvent): void => {
      if (!event.sender.isDestroyed()) event.sender.send(MAESTRO_CONFIGURATOR_EVENT_CHANNEL, payload)
    }
    return service.send(value as MaestroConfiguratorSendInput, emit)
  })
  dependencies.mhandle('chat:maestro-configurator:cancel', (_event, turnId?: unknown) => ({
    ok: service.cancel(typeof turnId === 'string' ? turnId : undefined),
  }))
  dependencies.mhandle('chat:maestro-configurator:reset', (event) => {
    service.reset((payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(MAESTRO_CONFIGURATOR_EVENT_CHANNEL, payload)
    })
    return { ok: true }
  })
}
