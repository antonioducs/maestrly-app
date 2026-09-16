import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import type { SessionRecord } from '../src/vm/catalog.js'
import { sessionDropIn, sessionEnvironment, sessionPaths } from '../src/vm/session-profile.js'

const record: SessionRecord = {
  id: randomUUID(), botId: 'bot-a', profile: { cpuQuotaPercent: 100, memoryMiB: 768, tasksMax: 256, diskMiB: 1024 },
  state: 'running', generation: 1, desiredState: 'running', legacy: false, username: `mb${'a'.repeat(24)}`, uid: 1001, gid: 1001, provisioned: true, createdAt: new Date().toISOString(),
}
it('separates display, graphical services and automation into units of one slice and namespace', () => {
  const p = sessionPaths(record)
  const desktop = sessionDropIn(record, 'desktop')
  const services = sessionDropIn(record, 'services')
  const runtime = sessionDropIn(record, 'runtime')
  // Stopping automation must not stop the display: no PartOf coupling remains.
  expect(desktop).not.toContain('PartOf=')
  expect(runtime).not.toContain('PartOf=')
  expect(services).toContain(`BindsTo=${p.desktopUnit}`)
  expect(services).toContain(`Requires=${p.servicesSocketUnit}`)
  expect(services).toContain(`RuntimeDirectory=maestrly-desktop/${record.id}`)
  expect(runtime).toContain(`Wants=${p.servicesUnit}`)
  for (const unit of [services, runtime]) expect(unit).toContain(`JoinsNamespaceOf=${p.desktopUnit}`)
  for (const unit of [desktop, services, runtime]) {
    expect(unit).toContain(`Slice=${p.slice}`)
    for (const setting of ['PrivateNetwork=yes', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'KillMode=control-group'])
      expect(unit).toContain(setting)
  }
  // The worker cannot reach the administrative, raw egress or screen sockets.
  const hidden = runtime.split('\n').find((line) => line.startsWith('InaccessiblePaths='))!
  for (const path of [p.adminSocket, p.egressSocket, '/run/maestrly-desktop', '/var/lib/maestrly-vm']) expect(hidden).toContain(path)
  expect(services.split('\n').find((line) => line.startsWith('InaccessiblePaths='))).not.toContain(p.adminSocket)
  expect(sessionDropIn(record, false)).toBe(runtime)
  expect(sessionDropIn(record, true)).toBe(desktop)
  expect(sessionEnvironment(record).MAESTRLY_BOT_DESKTOP_SERVICES).toBe(p.agentSocket)
})
it('ships a root-only administrative socket and a services unit that runs the pinned entry point', async () => {
  const socket = await readFile('../../deploy/bot-runtime/linux/maestrly-bot-desktop-services@.socket', 'utf8')
  for (const line of ['ListenStream=/run/maestrly-vm/%i/desktop-admin.sock', 'SocketUser=root', 'SocketGroup=root', 'SocketMode=0600', 'Accept=no'])
    expect(socket).toContain(line)
  const service = await readFile('../../deploy/bot-runtime/linux/maestrly-bot-desktop-services@.service', 'utf8')
  expect(service).toContain('ExecStart=/opt/maestrly-bot/runtime/bin/node /opt/maestrly-bot/app/desktop/services-main.js')
  expect(service).toContain('MAESTRLY_BOT_SESSION_REQUIRED=1')
  expect(service).not.toMatch(/--no-sandbox|remote-debugging|rfbport=5900|0\.0\.0\.0/)
  const install = await readFile('../../deploy/bot-runtime/linux/install.sh', 'utf8')
  expect(install).toContain('maestrly-bot-desktop-services@.service')
  expect(install).toContain('maestrly-bot-desktop-services@.socket')
})
it('paths are derived from validated identities, never from requests', () => {
  expect(() => sessionPaths({ id: '../../etc', legacy: false })).toThrow()
  const p = sessionPaths(record)
  expect(p.rfbSocket).toBe(`/run/maestrly-desktop/${record.id}/rfb.sock`)
  expect(p.adminSocket).toBe(`/run/maestrly-vm/${record.id}/desktop-admin.sock`)
})
