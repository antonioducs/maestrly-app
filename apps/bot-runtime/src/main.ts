import { realpathSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CodexAdapter } from './providers/codex/adapter.js'
import { FixtureProvider } from './providers/fixture.js'
import { runtimeVersion, RuntimeSupervisor } from './runtime-supervisor.js'
import { sessionIdSchema } from '@maestrly/host-protocol'
export async function main() {
  const state = process.env.MAESTRLY_BOT_STATE ?? '/var/lib/maestrly-bot'
  const workspace = process.env.MAESTRLY_BOT_WORKSPACE ?? '/home/maestrlybot/workspace'
  const provider = process.env.MAESTRLY_BOT_PROVIDER ?? 'codex'
  if (!['codex', 'fixture'].includes(provider)) throw new Error('MAESTRLY_BOT_PROVIDER must be codex or fixture')
  const installed = await access(join(state, 'installed.json')).then(
    () => true,
    () => false
  )
  if (provider === 'fixture' && (process.env.MAESTRLY_BOT_PACKAGED === '1' || installed))
    throw new Error('Fixture provider is refused in packaged or installed runtimes')
  if ((process.env.MAESTRLY_BOT_PACKAGED === '1' || installed) && (process.platform !== 'linux' || process.getuid?.() === 0))
    throw new Error('Installed bot workers must run as an unprivileged Linux user')
  if (process.env.MAESTRLY_BOT_SESSION_REQUIRED === '1') {
    sessionIdSchema.parse(process.env.MAESTRLY_BOT_SESSION_ID)
    if (!process.env.MAESTRLY_BOT_ID || !process.env.MAESTRLY_BOT_STATE || !process.env.XAUTHORITY || !process.env.MAESTRLY_BOT_CONTROL_PATH)
      throw new Error('Managed session environment missing')
  }
  const version = await runtimeVersion()
  const supervisor = new RuntimeSupervisor({
    state,
    workspace,
    version,
    controlPath: process.env.MAESTRLY_BOT_CONTROL_PATH ?? '/dev/virtio-ports/org.maestrly.bot.control.0',
    providerFactory: () =>
      provider === 'fixture'
        ? Promise.resolve(new FixtureProvider(workspace))
        : CodexAdapter.connect({ state, workspace, version }),
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void supervisor.close()
    })
  try {
    await supervisor.run()
  } finally {
    await supervisor.close()
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main().catch((error) => {
    process.stderr.write(`Bot runtime: ${error instanceof Error ? error.message : 'startup failed'}\n`)
    process.exitCode = 1
  })
}
