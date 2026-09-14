import { runtimeError } from '../turns/service.js'
import type { ShellContext } from './shell.js'

// Never launch sudo here: in-process approvals cannot authenticate a helper
// against calls from the provider's native shell running as the same user.
export function systemExec(_command: string[], _context: ShellContext): never {
  throw runtimeError(
    'ELEVATION_UNSUPPORTED',
    'Elevated execution is unavailable: a separate authenticated privileged helper is required. Neither ask nor full-vm grants root access.'
  )
}
