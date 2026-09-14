import type { TurnHooks } from '../providers/provider.js'
import { runtimeError } from '../turns/service.js'

export async function approveSystem(
  _mode: 'ask' | 'full-vm',
  _command: string[],
  _reason: string,
  _hooks: TurnHooks
): Promise<never> {
  throw runtimeError(
    'ELEVATION_UNSUPPORTED',
    'Elevated execution is unavailable in both ask and full-vm modes; privileged approvals are not implemented.'
  )
}
