import { DesktopChatExecutor, DesktopModelCatalog } from './desktop-executor'
import { ProjectChatWorker } from './project-chat-worker'
import { DesktopProjectChatClient } from './project-chat-client'
import { executorSettings, saveExecutorSettings } from './executor-settings'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'
import { HttpTransport } from '@maestrly/client-sdk'
import {
  RunnerEngine,
  RunnerJournal,
  WorkspaceManager,
  ContainerCommandRunner,
  inspectRepositories,
  type ApprovedRepository,
  type DeliveryArtifact,
  type ExecutionArtifact,
  type RunnerClaim,
  type RunnerServer,
} from '@maestrly/runner-core'
import type { EmbeddedRunnerView } from '../../shared/platform'
import { getWorkspace } from '../store'
import { secureGet, secureSet, secureRemove } from '../secure-store'
import { platformConnections } from './connection-service'
import { platformProjectBindings } from './project-bindings'

const boundedFetch:typeof fetch=(input,init)=>fetch(input,{...init,signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)})

interface MachineIdentity {
  organizationId: string
  mode: 'personal' | 'team'
  ownerUserId: string
  runnerId: string
  credential: string
}

class DesktopRunnerServer implements RunnerServer {
  private readonly transport: HttpTransport
  constructor(
    url: string,
    private readonly identity: MachineIdentity,
    private readonly repositories: ApprovedRepository[],
    private readonly catalog: DesktopModelCatalog
  ) {
    this.transport = new HttpTransport({ baseUrl: url,fetch:boundedFetch })
  }
  private headers() {
    return {
      authorization: `Runner ${this.identity.credential}`,
      'x-maestrly-organization-id': this.identity.organizationId,
      'x-maestrly-runner-id': this.identity.runnerId,
    }
  }
  async claim(): Promise<RunnerClaim | null> {
    const claim = await this.transport.request<RunnerClaim | null>('POST', '/api/v1/runners/claim', {
      body: {
        repositories: await inspectRepositories(this.repositories),
        automationCapabilities: await this.catalog.read(),
      },
      headers: this.headers(),
    })
    if (
      claim &&
      (claim.envelope.organizationId !== this.identity.organizationId ||
        (this.identity.mode === 'personal' &&
          (claim.envelope.snapshot.personalDevice?.deviceId !== this.identity.runnerId ||
            claim.envelope.snapshot.personalDevice?.ownerUserId !== this.identity.ownerUserId)) ||
        (this.identity.mode === 'team' && !!claim.envelope.snapshot.personalDevice))
    )
      throw new Error('This computer accepts only personal owner jobs in personal mode and shared jobs in team mode.')
    return claim
  }
  presence(online: boolean) {
    return this.transport.request<{ enabled: boolean }>(
      'POST',
      this.identity.mode === 'personal' ? '/api/v1/personal-devices/presence' : '/api/v1/runners/presence',
      {
        body: { online },
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      }
    )
  }
  renew(runId: string, leaseId: string) {
    return this.transport.request<{ leaseExpiresAt: string; cancellationRequested: boolean }>(
      'POST',
      `/api/v1/runners/runs/${runId}/lease`,
      { body: { leaseId }, headers: this.headers() }
    )
  }
  event(
    runId: string,
    leaseId: string,
    event: { eventId: string; type: string; data: Record<string, unknown> }
  ): Promise<void> {
    return this.transport.request('POST', `/api/v1/runners/runs/${runId}/events`, {
      body: { leaseId, ...event },
      headers: this.headers(),
    })
  }
  complete(runId: string, leaseId: string, completion: Record<string, unknown>): Promise<void> {
    return this.transport.request('POST', `/api/v1/runners/runs/${runId}/complete`, {
      body: { leaseId, completion },
      headers: this.headers(),
    })
  }
  uploadArtifact(runId: string, leaseId: string, artifact: ExecutionArtifact): Promise<DeliveryArtifact> {
    return this.transport.request('POST', `/api/v1/runners/runs/${runId}/artifacts`, {
      body: {
        leaseId,
        kind: artifact.kind,
        name: artifact.name,
        contentType: artifact.contentType,
        contentBase64: Buffer.from(artifact.bytes).toString('base64'),
      },
      headers: this.headers(),
    })
  }
  async reconcile(run: { runId: string; leaseId: string }): Promise<'active' | 'terminal' | 'unknown'> {
    try {
      const result = await this.transport.request<{ state: string }>(
        'GET',
        `/api/v1/runners/runs/${run.runId}/status?leaseId=${encodeURIComponent(run.leaseId)}`,
        { headers: this.headers() }
      )
      return ['claimed', 'running', 'cancelling'].includes(result.state) ? 'active' : 'terminal'
    } catch {
      return 'unknown'
    }
  }
}

export class EmbeddedRunnerHost {
  private engine: RunnerEngine | null = null
  private chatWorker:ProjectChatWorker|null=null
  private chatLoop:Promise<void>|null=null
  private server: DesktopRunnerServer | null = null
  private loop: Promise<void> | null = null
  private state: EmbeddedRunnerView = { state: 'stopped' }
  private stopping = false
  private revision = 0
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private memory = new Map<string, MachineIdentity>()
  status(): EmbeddedRunnerView {
    return { ...this.state }
  }
  async start(connectionId: string): Promise<EmbeddedRunnerView> {
    if (this.state.state === 'error') await this.stop()
    if (this.engine || this.state.state === 'starting') return this.status()
    let credentialKey: string | undefined
    const revision = ++this.revision
    this.state = { state: 'starting' }
    try {
      const settings = executorSettings()
      if (!settings.providerIds.length) throw new Error('Select provider accounts in the executor settings first.')
      const connection = platformConnections.list().find((c) => c.id === connectionId)
      const token = await platformConnections.authenticatedToken(connectionId)
      if (!connection || !token) throw new Error('Connect to the platform before enabling this executor.')
      const available = platformProjectBindings.list().filter((b) => b.connectionId === connectionId),
        organizationId = available.at(-1)?.organizationId
      if (!organizationId) throw new Error('Bind a project to a local workspace before enabling this executor.')
      const bindings = available.filter((b) => b.organizationId === organizationId),
        projectIds = [...new Set(bindings.map((b) => b.projectId))].sort()
      const repositories: ApprovedRepository[] = []
      for (const binding of bindings) {
        if (!binding.repositoryBindingId) continue
        const workspace = getWorkspace(binding.workspaceId)
        if (!workspace) throw new Error('The bound local workspace no longer exists.')
        const existing = repositories.find((r) => r.bindingId === binding.repositoryBindingId)
        if (existing && existing.localPath !== workspace.path)
          throw new Error('A repository binding must identify one local checkout on this runner.')
        if (!existing) repositories.push({ bindingId: binding.repositoryBindingId, localPath: workspace.path })
      }
      const manager = new WorkspaceManager({
        repositories,
        isolated: true,
        retainWorkspace: true,
        baseDirectory: path.join(app.getPath('userData'), 'executor-workspaces'),
      })
      if ((await manager.inventory()).some((r) => !r.available))
        throw new Error('The bound repository has no available committed branch. Check the local workspace.')
      const human = new HttpTransport({
        baseUrl: connection.url,
        fetch:boundedFetch,
        authentication: { headers: () => ({ authorization: `Bearer ${token}` }) },
      })
      const owner = await human.request<{ userId: string }>('GET', '/api/v1/me')
      const key = `platform.desktop-executor.${settings.mode}.${connection.id}.${owner.userId}.${organizationId}.${projectIds.join(',')}`
      credentialKey = key
      let identity = this.memory.get(key) ?? null
      try {
        const value = secureGet(key)
        if (value) identity = JSON.parse(value)
      } catch {
        /* Explicitly enroll when no protected identity exists. */
      }
      if (settings.mode === 'personal') {
        const enrolled = await human.request<{ runnerId: string; credential?: string; ownerUserId: string }>(
          'POST',
          '/api/v1/personal-devices',
          {
            body: {
              organizationId,
              projectIds,
              name: os.hostname(),
              ...(identity ? { deviceId: identity.runnerId } : {}),
            },
            idempotencyKey: crypto.randomUUID(),
          }
        )
        identity = {
          organizationId,
          runnerId: enrolled.runnerId,
          credential: enrolled.credential ?? identity?.credential ?? '',
          ownerUserId: owner.userId,
          mode: 'personal',
        }
      } else {
        // Validate the signed-in operator's project grants even when a machine credential is reused.
        const enrollment = await human.request<{ token: string }>('POST', '/api/v1/runner-enrollments', {
          body: { organizationId, projectIds },
          idempotencyKey: crypto.randomUUID(),
        })
        if (!identity) {
          const enrolled = await human.request<{ runnerId: string; credential: string }>(
            'POST',
            '/api/v1/runners/enroll',
            {
              body: {
                organizationId,
                token: enrollment.token,
                name: os.hostname() + ' · Maestrly',
                protocolVersion: '1.0',
                maxConcurrency: 1,
                capabilities: [{ name: 'executor:maestrly' }, { name: 'delivery:patch' }],
              },
            }
          )
          identity = { organizationId, ...enrolled, ownerUserId: owner.userId, mode: 'team' }
        }
      }
      if (!identity?.credential) throw new Error('Executor credential is missing.')
      if (!secureSet(key, JSON.stringify(identity))) this.memory.set(key, identity)
      const commands = new ContainerCommandRunner(
        process.env.MAESTRLY_COMMAND_IMAGE ?? 'maestrly/runner-executor:local'
      )
      const catalog = new DesktopModelCatalog(settings, () =>
        settings.allowCommands ? commands.available() : Promise.resolve(false)
      )
      if (!(await catalog.read()).models.length)
        throw new Error('No models are available from the selected accounts. Connect an account and refresh the list.')
      const server = new DesktopRunnerServer(connection.url, identity, repositories, catalog)
      if (revision !== this.revision) {
        await server.presence(false).catch(() => {})
        return this.status()
      }
      this.server = server
      const engine = new RunnerEngine(
        server,
        new Map([['maestrly', new DesktopChatExecutor(catalog, settings, bindings)]]),
        manager,
        new RunnerJournal(path.join(app.getPath('userData'), `platform-executor-${identity.runnerId}.json`)),
        { commandRunner: commands }
      )
      await engine.recover()
      if (revision !== this.revision) {
        await server.presence(false).catch(() => {})
        return this.status()
      }
      this.engine = engine
      this.stopping = false
      this.state = {
        state: 'running',
        deviceId: identity.runnerId,
        ownerUserId: identity.ownerUserId,
        mode: settings.mode,
      }
      saveExecutorSettings({ ...settings, connectionId })
      if(!settings.interactiveChat){
        await new DesktopProjectChatClient(connection.url,identity).inventory({capability:'chat:interactive:v1',enabled:false,workspaces:[],models:[],integrations:{memory:false,skills:false,mcp:false}}).catch(error=>{if((error as {status?:number}).status!==404)throw error})
      }
      if(settings.interactiveChat){
        const chatClient=new DesktopProjectChatClient(connection.url,identity)
        const chatWorker=new ProjectChatWorker(chatClient,catalog,settings,bindings,connection.instanceId??connection.url,connection.url)
        await chatClient.inventory(await chatWorker.inventory())
        this.chatWorker=chatWorker
        this.chatLoop=chatWorker.run().catch(error=>{this.state={state:'error',error:(error as Error).message};this.stopping=true;void engine.stop()})
      }
      this.heartbeat = setInterval(
        () =>
          void server
            .presence(true)
            .then((result) => {
              if (!result.enabled) void this.stop()
            })
            .catch((error) => {
              if ([401, 403].includes((error as { status: number }).status)) {
                this.state = { state: 'error', error: 'Executor access was revoked.' }
                this.stopping = true
                if (this.heartbeat) clearInterval(this.heartbeat)
                secureRemove(key)
                this.memory.delete(key)
                void engine.stop()
              }
            }),
        15000
      )
      this.loop = this.runLoop(engine)
    } catch (error) {
      if (credentialKey && [401, 403].includes((error as { status: number }).status)) {
        secureRemove(credentialKey)
        this.memory.delete(credentialKey)
      }
      await this.server?.presence(false).catch(() => {})
      this.server = null
      if (revision === this.revision) this.state = { state: 'error', error: (error as Error).message }
    }
    return this.status()
  }
  private async runLoop(engine: RunnerEngine) {
    try {
      while (!this.stopping) {
        try {
          await engine.runOnce()
        } catch (error) {
          const status = (error as { status?: number }).status
          if (!(error instanceof TypeError) && (error as Error).name!=='TimeoutError' && !(status && status >= 500)) throw error
        }
        if (!this.stopping) await new Promise((r) => setTimeout(r, 2000))
      }
    } catch (error) {
      this.state = { state: 'error', error: (error as Error).message }
      if (this.heartbeat) clearInterval(this.heartbeat)
      await this.server?.presence(false).catch(() => {})
    }
  }
  async stop() {
    this.revision++
    this.stopping = true
    this.chatWorker?.stop()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    const offline = this.server?.presence(false).catch(() => {})
    this.server = null
    await this.engine?.stop('Executor was stopped.')
    await this.loop
    await this.chatLoop
    this.chatWorker=null;this.chatLoop=null
    await offline
    this.engine = null
    this.loop = null
    this.state = { state: 'stopped' }
  }
}
export const embeddedRunnerHost = new EmbeddedRunnerHost()
