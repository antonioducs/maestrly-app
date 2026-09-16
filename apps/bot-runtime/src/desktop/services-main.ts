import { chmod, lstat, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sessionIdSchema } from '@maestrly/host-protocol'
import { FileService } from '../files/service.js'
import { LocalProxy } from '../network/proxy.js'
import { EgressTransport } from '../network/serial-transport.js'
import { BrowserSession } from '../tools/browser.js'
import { adminRequestSchema, agentRequestSchema, serveLineRpc } from './service-protocol.js'
import { DesktopServices } from './services.js'
import { DesktopSession } from './session.js'
import { VncTransmitter } from './vnc-server.js'
import { X11Connection } from './x11.js'

async function listenPath(server: Server, path: string) {
  const old = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (old) {
    if (!old.isSocket() || old.uid !== process.getuid?.()) throw new Error('Unsafe desktop services socket path')
    await unlink(path)
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(path, 0o600)
}
/** Graphical services of one managed session: browser, egress proxy, screen and input. */
export async function main() {
  const env = process.env
  const packaged = env.MAESTRLY_BOT_PACKAGED === '1'
  if (packaged && (process.platform !== 'linux' || process.getuid?.() === 0))
    throw new Error('Desktop services must run as an unprivileged Linux user')
  if (env.MAESTRLY_BOT_SESSION_REQUIRED === '1') {
    sessionIdSchema.parse(env.MAESTRLY_BOT_SESSION_ID)
    if (!env.MAESTRLY_BOT_STATE || !env.XAUTHORITY || !env.MAESTRLY_BOT_DESKTOP_SERVICES) throw new Error('Managed session environment missing')
  }
  const state = env.MAESTRLY_BOT_STATE ?? '/var/lib/maestrly-bot'
  const workspace = env.MAESTRLY_BOT_WORKSPACE ?? join(state, 'workspace')
  const agentPath = env.MAESTRLY_BOT_DESKTOP_SERVICES ?? join(state, 'desktop-agent.sock')
  const runtimeDirectory = env.RUNTIME_DIRECTORY?.split(':')[0] ?? env.MAESTRLY_DESKTOP_RUNTIME_DIR
  if (!runtimeDirectory) throw new Error('Desktop runtime directory missing')
  // A supervised administrative socket arrives from systemd, root-owned with mode 0600.
  const supervised = env.LISTEN_PID === String(process.pid) && env.LISTEN_FDS === '1'
  for (const key of ['LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES']) delete env[key]
  const files = new FileService(workspace)
  await files.init()
  const egress = new EgressTransport()
  await egress.start()
  const proxy = new LocalProxy(egress)
  await proxy.start()
  const desktop = new DesktopSession()
  const notifiers = new Set<(event: 'invalidate') => void>()
  const invalidate = () => {
    for (const notify of notifiers) notify('invalidate')
  }
  const browser = new BrowserSession(state, files, desktop, invalidate)
  const transmitter = new VncTransmitter({ display: desktop.display, socketPath: join(runtimeDirectory, 'rfb.sock'), environment: env })
  const services = new DesktopServices({
    files,
    browser,
    transmitter,
    proxy,
    openX11: () => X11Connection.open({ display: desktop.display, xauthority: env.XAUTHORITY }),
    invalidate,
    supervised,
  })
  const sockets = new Set<Socket>()
  const agent = createServer((socket) => {
    if (sockets.size >= 16) return socket.destroy()
    sockets.add(socket)
    const notify = serveLineRpc(socket, agentRequestSchema, (request) => services.agent(request))
    notifiers.add(notify)
    socket.once('close', () => {
      sockets.delete(socket)
      notifiers.delete(notify)
    })
  })
  const admin = createServer((socket) => {
    if (sockets.size >= 16) return socket.destroy()
    sockets.add(socket)
    serveLineRpc(socket, adminRequestSchema, (request) => services.admin(request), { maxInFlight: 32 })
    socket.once('close', () => sockets.delete(socket))
  })
  await listenPath(agent, agentPath)
  if (supervised)
    await new Promise<void>((resolve, reject) => {
      admin.once('error', reject)
      admin.listen({ fd: 3 }, () => resolve())
    })
  else if (!packaged && env.MAESTRLY_DESKTOP_ADMIN_PATH) await listenPath(admin, env.MAESTRLY_DESKTOP_ADMIN_PATH)
  else throw new Error('Supervised administrative socket missing')
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all([agent, admin].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
      await services.close()
      await browser.close().catch(() => {})
      await proxy.close()
      egress.close()
    })())
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void close())
  return close
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  void main().catch((error) => {
    process.stderr.write(`Desktop services: ${error instanceof Error ? error.message : 'startup failed'}\n`)
    process.exitCode = 1
  })
