import type { FleetConnectionView } from '../../../preload/api-fleet'
import type { FleetInstallerStepId, FleetInstallerStatus, FleetInstallMode } from '../../../shared/fleet-installer'

export function stepLabelKey(id: FleetInstallerStepId, mode: FleetInstallMode): string {
  return id === 'check' ? `botServer.step.check${mode === 'local' ? 'Local' : 'Remote'}` : `botServer.step.${id}`
}

export function panelState(status: FleetInstallerStatus, connection: FleetConnectionView) {
  const mode = status.record?.mode ?? (connection.state === 'unconfigured' ? null : 'manual')
  const busy = status.job?.state === 'running'
  const connected = connection.state === 'connected'
  const reachable = connected && (mode !== 'remote' || status.tunnel === 'connected')
  return {
    mode,
    canUpdate: !!status.record && status.update === 'available' && reachable && !busy,
    serverNewer: !!status.record && status.update === 'server-newer',
    canRemove: !!status.record && reachable && !busy,
    canTogglePrivateNetwork: !!status.record && reachable && !busy,
    busy,
  }
}

export interface RemoteForm {
  host: string
  port: string
  username: string
  password: string
  useKey: boolean
  privateKey: string
}

export function validateRemoteForm(form: RemoteForm): Partial<Record<keyof RemoteForm, string>> {
  const errors: Partial<Record<keyof RemoteForm, string>> = {}
  const host = form.host.trim()
  const bare = host.replace(/^\[(.*)\]$/, '$1')
  const ipv6 = bare.split(':').length >= 3 && /^[a-fA-F0-9:.]+$/.test(bare)
  if (!host || /[\s/@]/.test(host) || (host.includes(':') && !ipv6)) errors.host = 'botServer.validation.host'
  const port = Number(form.port)
  if (!/^\d+$/.test(form.port) || !Number.isInteger(port) || port < 1 || port > 65535)
    errors.port = 'botServer.validation.port'
  if (!form.username.trim() || /\s/.test(form.username)) errors.username = 'botServer.validation.username'
  if (form.useKey ? !form.privateKey.trim() : !form.password) {
    if (form.useKey) errors.privateKey = 'botServer.validation.privateKey'
    else errors.password = 'botServer.validation.password'
  }
  return errors
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
