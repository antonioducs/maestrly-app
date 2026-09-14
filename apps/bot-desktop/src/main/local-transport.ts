import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { SshTransport } from './ssh-transport'
import type { LocalHostStatus } from '../shared/types'

export const LOCAL_HOST_EXECUTABLE = '/Library/MaestrlyHost/bin/maestrly-host'
export const LOCAL_HOST_RUN_DIRECTORY = '/Library/MaestrlyHost/run'
export const LOCAL_HOST_SOCKET = '/Library/MaestrlyHost/run/host.sock'
/**
 * The local Host is reached through the same `rpc-stdio` command the SSH path uses, but the
 * executable is a fixed root-owned path on this Mac. No shell, no arguments from the renderer,
 * no localhost SSH. If the installation is missing or untrusted, nothing is spawned.
 */
export async function inspectLocalHost(): Promise<LocalHostStatus> {
  if (process.platform !== 'darwin') return { state: 'unsupported', reason: 'O Host local só existe no macOS' }
  try {
    for (const path of ['/Library/MaestrlyHost', '/Library/MaestrlyHost/bin', LOCAL_HOST_EXECUTABLE]) {
      const stat = await lstat(path)
      if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
        return { state: 'untrusted', reason: 'A instalação do Host neste Mac não é de propriedade do administrador' }
    }
    const executable = await lstat(LOCAL_HOST_EXECUTABLE)
    if (!executable.isFile() || !(executable.mode & 0o111)) return { state: 'untrusted', reason: 'O executável do Host não é válido' }
    const run = await lstat(LOCAL_HOST_RUN_DIRECTORY)
    if (!run.isDirectory() || run.uid === 0) return { state: 'untrusted', reason: 'O diretório de execução do Host não é válido' }
    return { state: 'installed' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return { state: 'untrusted', reason: 'Não foi possível verificar a instalação do Host' }
  }
}
export function localArgs(): string[] {
  return ['rpc-stdio']
}
/** Reuses the SSH framing/timeouts with a different, fixed launcher. */
export class LocalTransport extends SshTransport {
  constructor(timeout = 30_000, launch?: (command: string, args: string[]) => ChildProcessWithoutNullStreams) {
    super(
      launch ??
        ((command, args) =>
          spawn(command, args, { shell: false, env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })),
      timeout
    )
  }
  async connectLocal(): Promise<void> {
    const status = await inspectLocalHost()
    if (status.state !== 'installed') throw new Error(status.state === 'missing' ? 'O Host não está instalado neste Mac' : status.reason)
    this.launchFixed(LOCAL_HOST_EXECUTABLE, localArgs(), 'local')
  }
}
