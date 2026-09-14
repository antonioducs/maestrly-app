import { join } from 'node:path'
import { sessionIdSchema } from '@maestrly/host-protocol'
import type { SessionRecord } from './catalog.js'

export function sessionPaths(record: Pick<SessionRecord, 'id' | 'legacy'>) {
  sessionIdSchema.parse(record.id)
  return {
    home: record.legacy ? '/home/maestrlybot' : `/home/maestrly-sessions/${record.id}`,
    state: record.legacy ? '/var/lib/maestrly-bot' : `/var/lib/maestrly-sessions/${record.id}`,
    socketDirectory: `/run/maestrly-vm/${record.id}`,
    runtimeUnit: `maestrly-bot-runtime@${record.id}.service`,
    desktopUnit: `maestrly-bot-desktop@${record.id}.service`,
    slice: `maestrly-bots-${record.id.replaceAll('-', '')}.slice`,
  }
}
export function sessionEnvironment(record: SessionRecord) {
  const p = sessionPaths(record)
  return {
    HOME: p.home, DISPLAY: ':10', XAUTHORITY: join(p.state, 'Xauthority'),
    MAESTRLY_BOT_SESSION_ID: record.id, MAESTRLY_BOT_ID: record.botId,
    MAESTRLY_BOT_STATE: p.state, MAESTRLY_BOT_WORKSPACE: join(p.home, 'workspace'),
    MAESTRLY_BOT_CONTROL_PATH: join(p.socketDirectory, 'control.sock'),
    MAESTRLY_BOT_EGRESS_PATH: join(p.socketDirectory, 'egress.sock'),
    MAESTRLY_BOT_PROXY_PORT: '3128', MAESTRLY_BOT_DESKTOP_MANAGED: '1', MAESTRLY_BOT_PACKAGED: '1',
    MAESTRLY_BOT_MCP_MAIN: '/opt/maestrly-bot/app/tools/mcp-main.js', MAESTRLY_CODEX_BINARY: '/opt/maestrly-bot/codex/bin/codex',
    MAESTRLY_DESKTOP_WIDTH: '1280', MAESTRLY_DESKTOP_HEIGHT: '800',
  }
}
// Separate network namespaces also separate X11 abstract sockets and loopback proxies.
// Each runtime joins ONLY its own desktop's namespace. Paths are generated, never user input.
export function sessionDropIn(record: SessionRecord, desktop: boolean): string {
  const p = sessionPaths(record)
  const env = sessionEnvironment(record)
  // botId is opaque and may contain punctuation: systemd Environment quoting must not interpret it.
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(record.botId)) throw new Error('Unsupported bot identity')
  return `[Unit]\n${desktop ? `PartOf=${p.runtimeUnit}` : `After=${p.desktopUnit}\nRequires=${p.desktopUnit}\nJoinsNamespaceOf=${p.desktopUnit}`}\n
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
InaccessiblePaths=-/dev/virtio-ports /var/lib/maestrly-vm
UMask=0077
KillMode=control-group
TimeoutStopSec=15
Restart=on-failure
RestartSec=2
`
}
export function sessionSlice(record: SessionRecord): string {
  return `[Unit]\nDescription=Maestrly bot session resources\n[Slice]\nCPUAccounting=yes\nMemoryAccounting=yes\nTasksAccounting=yes\nCPUQuota=${record.profile.cpuQuotaPercent}%\nMemoryMax=${record.profile.memoryMiB}M\nMemorySwapMax=0\nTasksMax=${record.profile.tasksMax}\n`
}
