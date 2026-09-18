import { lstat, readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { RotatingLog } from './log.js'
import { startSocket } from './rpc-server.js'
import { startDesktopSocket } from './desktop-server.js'
import { DESKTOP_SOCKET_PATH, SOCKET_PATH } from './transport.js'

export async function daemon() {
  if (process.platform !== 'darwin') throw Error('daemon requires macOS')
  if (process.getuid?.() === 0 || userInfo().username !== '_maestrlyhost')
    throw Error('Dedicated nonroot service account required')
  process.umask(0o007)
  const configPath = '/Library/MaestrlyHost/etc/host.json'
  const info = await lstat(configPath)
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || info.size > 1024 * 1024)
    throw Error('Unsafe configuration')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (config.stateDirectory !== '/Library/MaestrlyHost/state') throw Error('Invalid state directory')
  const { HostService, forkAsrWorker } = await import('@maestrly/host-core')
  /**
   * Local speech recognition, when this Host has a bundle installed. The directory is named
   * in the root-owned configuration, never chosen by a client, and every file inside it is
   * verified against its manifest before a worker is allowed to start. Without it the Host
   * simply does not advertise voice, and the text chat is unaffected.
   */
  const asrDirectory = typeof config.asrBundleDirectory === 'string' ? config.asrBundleDirectory : undefined
  if (asrDirectory && !asrDirectory.startsWith('/Library/MaestrlyHost/')) throw Error('Invalid ASR bundle directory')
  const { asrBundleDirectory: _ignored, ...serviceConfig } = config
  const service = new HostService({
    ...serviceConfig,
    ...(asrDirectory ? { asr: { bundleDirectory: asrDirectory, factory: forkAsrWorker() } } : {}),
  })
  await service.ready()
  const log = new RotatingLog('/Library/MaestrlyHost/log/host.jsonl')
  let closeSocket: () => Promise<void>
  let closeDesktop: () => Promise<void> = async () => {}
  try {
    closeSocket = await startSocket(
      SOCKET_PATH,
      (request, context) => service.dispatch(request, context),
      (event) => log.write(event),
      (connectionId) => void service.disconnect(connectionId).catch(() => {})
    )
    closeDesktop = await startDesktopSocket(DESKTOP_SOCKET_PATH, (ticket) => service.attachDesktop(ticket), (event) => log.write(event))
  } catch (error) {
    await closeDesktop()
    await service.close()
    throw error
  }
  log.write('started')
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await closeDesktop()
    await closeSocket()
    await service.close()
    log.write('stopped')
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void stop().catch(() => {
        process.exitCode = 1
      })
    })
}
