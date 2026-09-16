import { join } from 'node:path'
import { sessionIdSchema } from '@maestrly/host-protocol'
import type { SessionRecord } from './catalog.js'

export function sessionPaths(record: Pick<SessionRecord, 'id' | 'legacy'>) {
  sessionIdSchema.parse(record.id)
  const state = record.legacy ? '/var/lib/maestrly-bot' : `/var/lib/maestrly-sessions/${record.id}`
  const socketDirectory = `/run/maestrly-vm/${record.id}`
  return {
    home: record.legacy ? '/home/maestrlybot' : `/home/maestrly-sessions/${record.id}`,
    state,
    socketDirectory,
    runtimeUnit: `maestrly-bot-runtime@${record.id}.service`,
    desktopUnit: `maestrly-bot-desktop@${record.id}.service`,
    servicesUnit: `maestrly-bot-desktop-services@${record.id}.service`,
    servicesSocketUnit: `maestrly-bot-desktop-services@${record.id}.socket`,
    slice: `maestrly-bots-${record.id.replaceAll('-', '')}.slice`,
    /** Root-only (0600) systemd socket: the supervisor's administrative channel to the services. */
    adminSocket: join(socketDirectory, 'desktop-admin.sock'),
    egressSocket: join(socketDirectory, 'egress.sock'),
    /** Services-private runtime directory; hidden from the automation worker. */
    desktopRuntime: `/run/maestrly-desktop/${record.id}`,
    rfbSocket: `/run/maestrly-desktop/${record.id}/rfb.sock`,
    agentSocket: join(state, 'desktop-agent.sock'),
    desktopGeneration: join(state, 'desktop-generation'),
  }
}
export function sessionEnvironment(record: SessionRecord) {
  const p = sessionPaths(record)
  return {
    HOME: p.home, DISPLAY: ':10', XAUTHORITY: join(p.state, 'Xauthority'),
    MAESTRLY_BOT_SESSION_ID: record.id, MAESTRLY_BOT_ID: record.botId,
    MAESTRLY_BOT_STATE: p.state, MAESTRLY_BOT_WORKSPACE: join(p.home, 'workspace'),
    MAESTRLY_BOT_CONTROL_PATH: join(p.socketDirectory, 'control.sock'),
    MAESTRLY_BOT_EGRESS_PATH: p.egressSocket,
    MAESTRLY_BOT_DESKTOP_SERVICES: p.agentSocket,
    MAESTRLY_BOT_PROXY_PORT: '3128', MAESTRLY_BOT_DESKTOP_MANAGED: '1', MAESTRLY_BOT_PACKAGED: '1',
    MAESTRLY_BOT_MCP_MAIN: '/opt/maestrly-bot/app/tools/mcp-main.js', MAESTRLY_CODEX_BINARY: '/opt/maestrly-bot/codex/bin/codex',
    MAESTRLY_DESKTOP_WIDTH: '1280', MAESTRLY_DESKTOP_HEIGHT: '800',
  }
}
export type SessionRole = 'desktop' | 'services' | 'runtime'
/**
 * Separate network namespaces also separate X11 abstract sockets and loopback proxies.
 * Display, graphical services and automation are three units (three cgroups) in one
 * session slice and namespace: stopping automation leaves the display, browser and
 * proxy running. Paths are generated, never user input.
 */
export function sessionDropIn(record: SessionRecord, role: SessionRole | boolean): string {
  const unit: SessionRole = role === true ? 'desktop' : role === false ? 'runtime' : role
  const p = sessionPaths(record)
  const env = sessionEnvironment(record)
  // botId is opaque and may contain punctuation: systemd Environment quoting must not interpret it.
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(record.botId)) throw new Error('Unsupported bot identity')
  const ordering = {
    desktop: '',
    services: `After=${p.desktopUnit} ${p.servicesSocketUnit}\nBindsTo=${p.desktopUnit}\nRequires=${p.servicesSocketUnit}\nJoinsNamespaceOf=${p.desktopUnit}`,
    runtime: `After=${p.desktopUnit} ${p.servicesUnit}\nRequires=${p.desktopUnit}\nWants=${p.servicesUnit}\nJoinsNamespaceOf=${p.desktopUnit}`,
  }[unit]
  // The worker never sees the administrative or raw egress sockets, nor the screen socket.
  const hidden = unit === 'runtime'
    ? `-/dev/virtio-ports /var/lib/maestrly-vm -/run/maestrly-desktop -${p.adminSocket} -${p.egressSocket}`
    : '-/dev/virtio-ports /var/lib/maestrly-vm'
  return `[Unit]\n${ordering}\n
[Service]
User=${record.username}
Group=${record.username}
Slice=${p.slice}
${Object.entries(env).map(([key, value]) => `Environment="${key}=${value}"`).join('\n')}
PrivateNetwork=yes
PrivateIPC=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectProc=invisible
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
RestrictSUIDSGID=yes
ReadWritePaths=${p.home} ${p.state}
InaccessiblePaths=${hidden}
${unit === 'services' ? `RuntimeDirectory=maestrly-desktop/${record.id}\nRuntimeDirectoryMode=0700\n` : ''}UMask=0077
KillMode=control-group
TimeoutStopSec=15
Restart=on-failure
RestartSec=2
`
}
export function sessionSlice(record: SessionRecord): string {
  return `[Unit]\nDescription=Maestrly bot session resources\n[Slice]\nCPUAccounting=yes\nMemoryAccounting=yes\nTasksAccounting=yes\nCPUQuota=${record.profile.cpuQuotaPercent}%\nMemoryMax=${record.profile.memoryMiB}M\nMemorySwapMax=0\nTasksMax=${record.profile.tasksMax}\n`
}
