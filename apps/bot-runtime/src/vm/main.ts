import { readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { JsonWire, MediaMux, SessionRouter, type MediaStream } from '@maestrly/guest-transport'
import {
  DESKTOP_MEDIA_PROTOCOL,
  DESKTOP_PORT_NAME,
  VM_RUNTIME_PROTOCOL,
  mediaWelcomeSchema,
  sessionCapacitySchema,
  vmRequestSchema,
  vmWelcomeSchema,
} from '@maestrly/host-protocol'
import { openControlTransport } from '../control/transport.js'
import { VmCatalog } from './catalog.js'
import { VmSupervisor } from './supervisor.js'
import { SystemdSessionDriver } from './systemd-driver.js'
import { ControlRouter } from './control-router.js'
import { EgressRouter } from './egress-router.js'
import { DesktopControl } from './desktop-control.js'

export async function main() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('VM supervisor only runs as Linux root')
  const catalog = new VmCatalog('/var/lib/maestrly-vm')
  const control = new ControlRouter('control')
  const egress = new EgressRouter()
  const driver = new SystemdSessionDriver(async record => { await control.listen(record); await egress.listen(record) })
  const capacity = await readFile('/opt/maestrly-bot/session-capacity.json', 'utf8').then(s => sessionCapacitySchema.parse(JSON.parse(s))).catch(e => { if (e.code !== 'ENOENT') throw e; return undefined })
  const desktop = new DesktopControl(catalog, driver, { capabilities: () => driver.capabilities() })
  const supervisor = new VmSupervisor(catalog, driver, capacity, desktop)
  const version = JSON.parse(await readFile('/opt/maestrly-bot/package.json', 'utf8')).version as string
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  const generation = Number(catalog.metadata('generation') ?? 0) + 1
  catalog.setMetadata('generation', String(generation))
  const stop = new AbortController()
  const channels = new Set<{ close(): void }>()
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stop.abort(); for (const wire of channels) wire.close() })
  for (const record of catalog.list()) if (record.provisioned) { await control.listen(record); await egress.listen(record) }
  await supervisor.recover()
  const leaseTimer = setInterval(() => { void supervisor.expireLeases() }, 1000)
  const desktopTimer = setInterval(() => { void supervisor.synchronizeDesktops() }, 2000)
  const pause = (ms: number) => new Promise<void>(resolve => {
    if (stop.signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); stop.signal.removeEventListener('abort', done); resolve() }
    stop.signal.addEventListener('abort', done, { once: true })
  })
  async function lane(name: 'control' | 'egress') {
    while (!stop.signal.aborted) {
      let wire: JsonWire | undefined
      try {
        wire = new JsonWire(await openControlTransport(`/dev/virtio-ports/org.maestrly.bot.${name}.0`))
        channels.add(wire)
        const channel = wire
        const nonce = randomUUID()
        let trusted = false
        let pending = 0
        const routes = new SessionRouter(channel, identity => {
          const session = catalog.get(identity.sessionId)
          return trusted && session?.provisioned === true && session.desiredState === 'running' && session.generation === identity.generation
        }, route => (name === 'control' ? control : egress).attach(route))
        const timeout = setTimeout(() => channel.close(), 15000)
        channel.on('frame', (raw: unknown) => {
          if (!raw || typeof raw !== 'object' || !('type' in raw)) return channel.close()
          if (raw.type === 'vm.welcome') {
            if (trusted) return channel.close()
            const welcome = vmWelcomeSchema.parse(raw)
            const oldHost = catalog.metadata('hostId')
            const oldGeneration = Number(catalog.metadata('hostGeneration') ?? 0)
            if (welcome.nonce !== nonce || oldHost && welcome.hostId !== oldHost || welcome.hostGeneration < oldGeneration) return channel.close()
            catalog.transaction(() => { catalog.setMetadata('hostId', welcome.hostId); catalog.setMetadata('hostGeneration', String(welcome.hostGeneration)) })
            trusted = true
            clearTimeout(timeout)
            return
          }
          if (!trusted) return channel.close()
          if (raw.type !== 'vm.request') return // SessionRouter owns route.* frames.
          if (name !== 'control' || pending >= 16) return channel.close()
          const request = vmRequestSchema.parse(raw)
          pending++
          void supervisor.handle(request).then(result => {
            if (request.method === 'session.stop') { control.disconnect(request.params.sessionId); egress.disconnect(request.params.sessionId) }
            channel.send({ type: 'vm.response', id: request.id, result })
          }, error => {
            // Diagnostics expose stable codes, never command stderr or guest secrets.
            channel.send({ type: 'vm.response', id: request.id, error: { code: /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'SESSION_OPERATION_FAILED', message: 'Não foi possível concluir a operação da área de trabalho; consulte o estado.' } })
          }).catch(() => channel.close()).finally(() => { pending-- })
        })
        channel.send({ type: 'vm.hello', protocol: VM_RUNTIME_PROTOCOL, version, bootId, generation, nonce })
        await new Promise<void>(resolve => channel.once('close', resolve))
        clearTimeout(timeout)
        routes.close()
      } catch { wire?.close() }
      finally { if (wire) channels.delete(wire) }
      await pause(1000)
    }
  }
  /**
   * Private media lane: RFB bytes only. The Host must already be trusted by the control
   * lane; this lane never establishes a Host identity on its own.
   */
  async function desktopLane() {
    const path = `/dev/virtio-ports/${DESKTOP_PORT_NAME}`
    while (!stop.signal.aborted) {
      let mux: MediaMux | undefined
      try {
        // Older launch profiles have no desktop port; the live view stays unavailable.
        if (!(await stat(path).then(() => true, () => false))) { await pause(10_000); continue }
        const hostId = catalog.metadata('hostId')
        if (!hostId) { await pause(1000); continue }
        mux = new MediaMux(await openControlTransport(path), 'guest')
        channels.add(mux)
        const current = mux
        const nonce = randomUUID()
        const trusted = await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => resolve(false), 15_000)
          current.once('close', () => { clearTimeout(timer); resolve(false) })
          current.once('welcome', (raw: unknown) => {
            clearTimeout(timer)
            const welcome = mediaWelcomeSchema.safeParse(raw)
            resolve(welcome.success && welcome.data.nonce === nonce && welcome.data.hostId === catalog.metadata('hostId') &&
              welcome.data.hostGeneration >= Number(catalog.metadata('hostGeneration') ?? 0))
          })
          current.hello({ protocol: DESKTOP_MEDIA_PROTOCOL, bootId, generation, nonce })
        })
        if (!trusted) { current.destroy(); await pause(1000); continue }
        current.on('open', (stream: MediaStream, payload: unknown) => { void desktop.attach(stream, payload) })
        await new Promise<void>(resolve => (current.alive ? current.once('close', () => resolve()) : resolve()))
      } catch { mux?.destroy() }
      finally { if (mux) channels.delete(mux) }
      await pause(1000)
    }
  }
  try { await Promise.all([lane('control'), lane('egress'), desktopLane()]) }
  finally { clearInterval(leaseTimer); clearInterval(desktopTimer); desktop.close(); await control.close(); await egress.close(); catalog.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  void main().catch(() => { process.stderr.write('VM supervisor failed; inspect the private session journal.\n'); process.exitCode = 1 })
