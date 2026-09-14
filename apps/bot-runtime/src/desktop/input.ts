import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runtimeError } from '../turns/service.js'
const execute = promisify(execFile)
export const X11_TOOLS = { input: '/usr/bin/xdotool', capture: '/usr/bin/scrot', inspect: '/usr/bin/xdpyinfo' } as const
export async function x11Command(tool: keyof typeof X11_TOOLS, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  if (process.platform !== 'linux') throw runtimeError('COMPUTER_UNAVAILABLE', 'Desktop input runs only inside Linux')
  signal?.throwIfAborted()
  return execute(X11_TOOLS[tool], args, { env, signal, timeout: 10000, maxBuffer: 128 * 1024 })
}
export function x11Key(key: string) {
  const aliases: Record<string, string> = { Control: 'ctrl', Meta: 'super', Alt: 'alt', Shift: 'shift', Enter: 'Return', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backspace: 'BackSpace', ' ': 'space' }
  const parts = key.split('+').map(part => aliases[part] ?? part)
  if (parts.length > 5 || parts.some(part => !/^[a-zA-Z0-9_]{1,24}$/.test(part))) throw runtimeError('INVALID_KEY', 'Invalid keyboard chord')
  return parts.join('+')
}
