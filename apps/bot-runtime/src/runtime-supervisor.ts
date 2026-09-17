import { EgressTransport } from './network/serial-transport.js'
import { LocalProxy } from './network/proxy.js'
import { DesktopSession } from './desktop/session.js'
import { BrowserSession } from './tools/browser.js'
import { ToolRegistry } from './tools/registry.js'
import { ToolsBridge } from './tools/bridge.js'
import { LocalDesktopTools, type DesktopTools } from './desktop/desktop-tools.js'
import { ManagedDesktopClient } from './desktop/managed-client.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXTENSIONS_CAPABILITY, ROUTINE_CAPABILITY, TEAM_CAPABILITY, TRANSCRIPT_CAPABILITY, narrowNetworkPolicy, narrowPermissionMode, type NetworkPolicy } from '@maestrly/host-protocol'
import { ExtensionsStore } from './extensions/store.js'
import { Journal } from './control/journal.js'
import { ControlSession, type HandlerMap } from './control/session.js'
import { openControlTransport } from './control/transport.js'
import { FileService } from './files/service.js'
import type { ProviderAdapter } from './providers/provider.js'
import { recoverTurns } from './turns/recovery.js'
import { CollaborationClient } from './teams/client.js'
import { RoutineClient } from './routines/client.js'
import { runtimeError, TurnService } from './turns/service.js'
export async function runtimeVersion() {
  return (
    JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      version: string
    }
  ).version
}
export class RuntimeSupervisor {
  readonly journal: Journal
  readonly files: FileService
  turns!: TurnService
  readonly egress = new EgressTransport()
  readonly proxy = new LocalProxy(this.egress)
  private desktop!: DesktopTools
  private tools!: ToolRegistry
  private collaboration!: CollaborationClient
  private routines!: RoutineClient
  private bridge!: ToolsBridge
  private capabilities = [
    'account.delegation.v1',
    'network.blocklist.v1',
    'network.proxy',
    'tools.system',
    'tools.memory',
    // Collaboration exists only when the Host also knows about teams; an older Host simply
    // never sends a team context and no team tool is ever offered.
    TEAM_CAPABILITY,
    'teams.collaboration',
    // Routine proposals exist only when the Host also knows about routines; an older Host
    // never sends a routine context and no proposal tool is ever offered.
    ROUTINE_CAPABILITY,
    // Tool, reasoning and usage events carry the detail a transcript needs; a Host that does
    // not fold transcripts simply keeps the summaries it always read.
    TRANSCRIPT_CAPABILITY,
    // Per-bot MCP servers and skills arrive before a turn; an older Host never sends them and
    // this runtime simply runs with the bot's own tool server, as it always did.
    EXTENSIONS_CAPABILITY,
  ]
  /** Outlives provider restarts: what the Host applied stays until the session ends. */
  readonly extensions: ExtensionsStore
  private provider!: ProviderAdapter
  private session?: ControlSession
  private stopped = new AbortController()
  private secrets = new Map<string, string>()
  private policy?: { network: NetworkPolicy; permissionMode: 'ask' | 'full-vm' }
  private monitor?: Promise<void>
  private accountTimer?: NodeJS.Timeout
  private accountState = ''
  private polling = false
  private restartAttempts: number[] = []
  constructor(
    private options: {
      state: string
      workspace: string
      controlPath: string
      version: string
      bootId?: string
      providerFactory: (extensions: ExtensionsStore) => Promise<ProviderAdapter>
      /** Agent socket of the session graphical services; absent in unmanaged workers. */
      desktopServices?: string
    }
  ) {
    this.journal = new Journal(options.state)
    this.files = new FileService(options.workspace)
    this.extensions = new ExtensionsStore(join(options.state, 'codex'))
  }
  async initialize() {
    await this.files.init()
    // Skills left by a previous run are not trusted to be current; the Host resends them.
    await this.extensions.reset()
    recoverTurns(this.journal)
    // Managed sessions: browser, egress and proxy belong to the persistent graphical
    // services, so stopping automation never closes them.
    const services = this.options.desktopServices
    if (!services) {
      await this.egress.start()
      await this.proxy.start()
    }
    this.desktop = services
      ? new ManagedDesktopClient(services, this.files, () => this.tools?.invalidate())
      : new LocalDesktopTools(new BrowserSession(this.options.state, this.files, new DesktopSession(), () => this.tools?.invalidate()), this.files)
    this.collaboration = new CollaborationClient(
      (input) => {
        const session = this.session
        if (!session) throw runtimeError('TEAM_UNAVAILABLE', 'O canal com o Host não está disponível')
        return session.requestCollaboration(input)
      },
      () => {
        const snapshot = this.turns.toolContext().snapshot
        return { turnId: snapshot.turnId, generation: snapshot.generation, team: snapshot.team }
      }
    )
    this.routines = new RoutineClient(
      (input) => {
        const session = this.session
        if (!session) throw runtimeError('ROUTINE_UPDATE_REQUIRED', 'O canal com o Host não está disponível')
        return session.requestRoutine(input)
      },
      () => {
        const snapshot = this.turns.toolContext().snapshot
        return { turnId: snapshot.turnId, generation: snapshot.generation, routines: snapshot.routines }
      }
    )
    this.tools = new ToolRegistry(
      this.journal,
      this.files,
      this.desktop,
      () => this.turns.toolContext(),
      // The stricter of the two, never the session's alone: a turn approved as "ask" keeps
      // asking even while the session as a whole is allowed to do more.
      () => {
        const snapshot = this.turns.toolContext().snapshot
        return this.policy ? narrowPermissionMode(this.policy.permissionMode, snapshot.permissionMode) : snapshot.permissionMode
      },
      this.collaboration,
      this.routines
    )
    this.bridge = new ToolsBridge(this.options.state, this.tools)
    await this.bridge.start()
    if (await this.desktop.available()) this.capabilities.push('tools.browser', 'tools.computer', 'desktop.session')
    this.provider = await this.connectProvider()
    this.turns = new TurnService(this.journal, this.provider, this.files)
    this.accountTimer = setInterval(() => {
      void this.pollAccount()
    }, 250)
    this.monitor = this.superviseProvider()
  }
  private async pollAccount() {
    if (this.polling || this.stopped.signal.aborted) return
    this.polling = true
    try {
      const account = await this.provider.auth.status()
      if (account.state !== this.accountState) {
        this.accountState = account.state
        this.journal.event({
          kind: 'account.changed',
          summary: 'Estado da conta atualizado',
          detail: { state: account.state },
        })
      }
    } catch {
      /* Provider supervision handles unavailable processes. */
    } finally {
      this.polling = false
    }
  }
  handlers(): HandlerMap {
    return {
      'runtime.inspect': async () => {
        const provider = await this.provider.inspect()
        return {
          ...provider,
          state: 'ready' as const,
          version: this.options.version,
          capabilities: [...new Set([...provider.capabilities, ...this.capabilities])],
        }
      },
      'models.list': () => this.provider.models(),
      'auth.prepareDelegation': async () => {
        if (this.turns.busy || !this.provider.auth.prepareDelegation) throw runtimeError('ACCOUNT_MIGRATION_REQUIRED', 'Stop the bot before changing its account mode')
        await this.provider.auth.prepareDelegation()
        return { prepared: true }
      },
      'auth.delegate': ({ credential }) => {
        if (!this.provider.auth.useDelegated) throw runtimeError('ACCOUNT_DELEGATION_UNAVAILABLE', 'Provider does not support delegated accounts')
        return this.provider.auth.useDelegated(credential)
      },
      'auth.exportLegacy': () => {
        if (this.turns.busy || !this.provider.auth.exportLegacy) throw runtimeError('ACCOUNT_MIGRATION_UNAVAILABLE', 'Stop the bot before migrating its account')
        return this.provider.auth.exportLegacy()
      },
      'auth.commitMigration': async ({ digest }) => {
        if (this.turns.busy || !this.provider.auth.commitMigration) throw runtimeError('ACCOUNT_MIGRATION_UNAVAILABLE', 'Stop the bot before migrating its account')
        await this.provider.auth.commitMigration(digest)
        return { committed: true }
      },
      'auth.status': () => this.provider.auth.status(),
      'auth.secret': ({ secretRef, apiKey }) => {
        if (this.secrets.size >= 64) throw runtimeError('SECRET_LIMIT', 'Too many pending secrets')
        this.secrets.set(secretRef, apiKey)
        return { stored: true }
      },
      'auth.start': async ({ method, secretRef }) => {
        if (method === 'device') return this.provider.auth.startDevice()
        const key = secretRef ? this.secrets.get(secretRef) : undefined
        if (secretRef) this.secrets.delete(secretRef)
        if (!key) throw runtimeError('SECRET_UNKNOWN', 'API key reference was not delivered or was already used')
        return this.provider.auth.startApiKey(key)
      },
      'auth.cancel': ({ loginId }) => this.provider.auth.cancel(loginId),
      'auth.logout': () => {
        this.secrets.clear()
        return this.provider.auth.logout()
      },
      'turn.start': async (snapshot) => {
        if (process.env.MAESTRLY_BOT_ID && snapshot.botId !== process.env.MAESTRLY_BOT_ID)
          throw runtimeError('SESSION_CONFLICT', 'This task belongs to another bot')
        this.tools.invalidate()
        // The session policy and the turn's own ceiling are INTERSECTED, never substituted.
        // Replacing the snapshot here used to let a session in full-vm mode widen a turn that
        // was approved as "ask" — a scheduled routine would then run with an authorization the
        // person never gave it. The stricter side always wins, in both directions.
        const effective = this.effectivePolicy(snapshot)
        await this.applyNetwork(effective.network)
        return this.turns.start({ ...snapshot, network: effective.network, permissionMode: effective.permissionMode })
      },
      'turn.reconcile': ({ turnId, generation }) => this.turns.reconcile(turnId, generation),
      'turn.cancel': ({ turnId, generation }) => this.turns.cancel(turnId, generation),
      'turn.lease': ({ turnId, generation, leaseMs }) => this.turns.lease(turnId, generation, leaseMs),
      'interaction.resolve': (input) => this.turns.resolve(input),
      'policy.update': async (policy) => {
        this.policy = policy
        await this.applyNetwork(policy.network)
        return { applied: true }
      },
      'files.list': (params) => this.files.list(params),
      'files.stat': (params) => this.files.stat(params),
      'files.read': (params) => this.files.read(params),
      'files.write': (params) => this.files.write(params),
      'files.abort': (params) => this.files.abort(params),
      // Refused while a turn runs: Codex keeps a thread's MCP processes until the next
      // archive/unarchive, so a change mid-turn would only take effect at an unknown moment.
      'extensions.apply': (payload) => {
        if (this.turns.busy) throw runtimeError('TURN_BUSY', 'Extensions change between turns, not during one')
        return this.extensions.apply(payload)
      },
    }
  }
  /**
   * What this turn may actually do: the intersection of the session's current policy and the
   * ceiling the Host approved for this specific piece of work. An authorization is never the
   * larger of the two, and a later widening of the session cannot reach a turn already
   * admitted under a narrower ceiling.
   */
  effectivePolicy(snapshot: { network: NetworkPolicy; permissionMode: 'ask' | 'full-vm' }) {
    if (!this.policy) return { network: snapshot.network, permissionMode: snapshot.permissionMode }
    return {
      network: narrowNetworkPolicy(this.policy.network, snapshot.network),
      permissionMode: narrowPermissionMode(this.policy.permissionMode, snapshot.permissionMode),
    }
  }
  /** The guest proxy is a first filter; the Host egress broker remains the authority. */
  private async applyNetwork(network: NetworkPolicy) {
    if (this.desktop?.managed && this.desktop.updatePolicy) await this.desktop.updatePolicy(network)
    else this.proxy.updatePolicy(network)
  }
  private async pause(ms: number) {
    if (this.stopped.signal.aborted) return
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.stopped.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.stopped.signal.addEventListener('abort', done, { once: true })
    })
  }
  private async connectProvider(): Promise<ProviderAdapter> {
    for (;;) {
      this.stopped.signal.throwIfAborted()
      const cutoff = Date.now() - 600_000
      this.restartAttempts = this.restartAttempts.filter((time) => time >= cutoff)
      if (this.restartAttempts.length >= 10) {
        this.journal.event({
          kind: 'diagnostic',
          summary: 'Provedor indisponível',
          detail: { code: 'PROVIDER_RESTART_LIMIT' },
        })
        await this.pause(Math.min(30_000, this.restartAttempts[0] + 600_000 - Date.now()))
        continue
      }
      if (this.restartAttempts.length) await this.pause(Math.min(30_000, 1000 * 2 ** (this.restartAttempts.length - 1)))
      this.stopped.signal.throwIfAborted()
      this.restartAttempts.push(Date.now())
      try {
        const provider = await this.options.providerFactory(this.extensions)
        provider.auth.setCredentialProvider?.((forceRefresh, credentialHash) => {
          if (!this.session) return Promise.reject(new Error('Account channel unavailable'))
          return this.session.requestAccount(forceRefresh, credentialHash)
        })
        return provider
      } catch {
        this.journal.event({
          kind: 'diagnostic',
          summary: 'Não foi possível iniciar o provedor',
          detail: { code: 'PROVIDER_START_FAILED' },
        })
      }
    }
  }
  private async superviseProvider() {
    while (!this.stopped.signal.aborted && this.provider.waitForExit) {
      await this.provider.waitForExit()
      if (this.stopped.signal.aborted) return
      // The adapter completes its active turn on exit; do not turn a provider crash into user cancellation.
      await this.turns.idle()
      await this.provider.dispose()
      try {
        this.tools.invalidate()
        this.provider = await this.connectProvider()
        this.turns.setProvider(this.provider)
      } catch {
        if (!this.stopped.signal.aborted) throw new Error('Provider supervision failed')
      }
    }
  }
  async run() {
    await this.initialize()
    let backoff = 1000
    while (!this.stopped.signal.aborted) {
      try {
        const stream = await openControlTransport(this.options.controlPath)
        if (this.stopped.signal.aborted) {
          stream.destroy()
          break
        }
        this.session = new ControlSession(stream, this.journal, this.handlers())
        await this.session.start({
          version: this.options.version,
          capabilities: ['provider.codex', 'tools.files', ...this.capabilities],
          bootId: this.options.bootId,
        })
        const started = Date.now()
        await this.session.done
        if (Date.now() - started > 30_000) backoff = 1000
      } catch {
        this.session?.close()
      }
      this.secrets.clear()
      await this.pause(backoff)
      backoff = Math.min(10_000, backoff * 2)
    }
  }
  async close() {
    this.stopped.abort()
    clearInterval(this.accountTimer)
    this.session?.close()
    this.secrets.clear()
    await this.turns?.close()
    await this.provider?.dispose()
    await this.monitor
    await this.bridge?.close()
    await this.desktop?.close()
    await this.proxy.close()
    this.egress.close()
  }
}
