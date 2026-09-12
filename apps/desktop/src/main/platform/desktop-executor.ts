import { getGlobalMaestroConfig } from '../chat/maestro-config'
import { createHash, randomUUID } from 'node:crypto'
import type { ChatInventory, RunnerAutomationCapabilities } from '@maestrly/protocol'
import type { ExecutorAdapter, ExecutionContext, ExecutionHandle, ExecutionOutcome } from '@maestrly/runner-core'
import { insertConversation } from '../store'
import { broadcast } from '../window-ipc'
import { listChatRunnerCapabilities, startExecutorChatTurn, primeChatTurnSelection } from '../chat/service'
import { listChatMessages } from '../chat/chat-store'
import { listMcpServers } from '../chat/mcp'
import {
  AUTONOMOUS_INSTRUCTIONS,
  registerAutonomousConversation,
  withAutonomousPolicy,
  type AutonomousPolicy,
} from '../chat/autonomous'
import { recordDesktopExecution, type DesktopExecutionRecord, type DesktopExecutorSettings } from './executor-settings'
import type { PlatformProjectBinding } from '../../shared/platform'

interface LocalModel {
  providerId: string
  modelId: string
  reasoningEfforts: string[]
  fastMode: boolean
  providerLabel: string
  label: string
}
const modelKey = (providerId: string, modelId: string) =>
  createHash('sha256')
    .update(providerId + '\0' + modelId)
    .digest('hex')
    .slice(0, 40)
export class DesktopModelCatalog {
  private models = new Map<string, LocalModel>()
  private at = 0
  private value: RunnerAutomationCapabilities = {
    version: 1,
    models: [],
    maestro: true,
    subagents: true,
    preCommands: false,
    issues: [],
  }
  constructor(
    private settings: DesktopExecutorSettings,
    private commandsAvailable: () => Promise<boolean>
  ) {}
  async read(): Promise<RunnerAutomationCapabilities> {
    if (Date.now() - this.at < 60000) return this.value
    const pairs = await listChatRunnerCapabilities(true)
    this.models = new Map(
      pairs
        .filter((p) => this.settings.providerIds.includes(p.providerId))
        .map((p) => [
          modelKey(p.providerId, p.modelId),
          {
            ...p,
            label:
              (p.providerId.includes('codex')
                ? 'Codex'
                : p.providerId.includes('claude')
                  ? 'Claude'
                  : p.providerId.includes('copilot')
                    ? 'Copilot'
                    : 'Maestrly') +
              ' · ' +
              p.modelId,
          },
        ])
    )
    this.value = {
      version: 1,
      models: [...this.models].map(([model, p]) => ({
        provider: 'maestrly',
        model,
        label: p.label,
        efforts: p.reasoningEfforts,
        fastMode: p.fastMode,
      })),
      maestro: true,
      subagents: true,
      preCommands: await this.commandsAvailable(),
      issues: this.models.size ? [] : ['Connect provider accounts and select them in the desktop executor settings.'],
    }
    this.at = Date.now()
    return this.value
  }
  async resolve(key: string) {
    await this.read()
    const model = this.models.get(key)
    if (!model) throw new Error('The selected desktop account or model is unavailable.')
    return model
  }
  async chatModels(): Promise<ChatInventory['models']> {
    await this.read()
    return [...this.models].map(([id, model]) => ({
      id,
      label: model.modelId,
      providerLabel: model.providerLabel,
      efforts: model.reasoningEfforts,
      fastMode: model.fastMode,
    }))
  }
}
function scrub(value: string): string {
  return value.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{20,})/g, '[redacted]')
}
export class DesktopChatExecutor implements ExecutorAdapter {
  readonly managesOrchestration = true
  constructor(
    private readonly catalog: DesktopModelCatalog,
    private readonly settings: DesktopExecutorSettings,
    private readonly bindings: PlatformProjectBinding[]
  ) {}
  async capabilities() {
    return { executor: 'maestrly', capabilities: [{ name: 'executor:maestrly', attributes: {} }] }
  }
  async start(context: ExecutionContext): Promise<ExecutionHandle> {
    const selection = await this.catalog.resolve(context.envelope.snapshot.model)
    const binding = this.bindings.find(
      (b) =>
        b.projectId === context.envelope.projectId &&
        b.organizationId === context.envelope.organizationId &&
        (!context.envelope.snapshot.repositoryBindingId ||
          b.repositoryBindingId === context.envelope.snapshot.repositoryBindingId)
    )
    if (!binding) throw new Error('This project is not bound to an approved local workspace.')
    const id = randomUUID(),
      now = Date.now(),
      snapshot = context.envelope.snapshot
    const conversation = {
      id,
      workspaceId: binding.workspaceId,
      name: snapshot.title,
      branch: context.environment.gitBaseCommit ?? 'executor',
      mode: 'local' as const,
      experience: snapshot.automation?.mode === 'maestro' ? ('maestro' as const) : ('standard' as const),
      cwd: context.environment.workspacePath,
      status: 'idle' as const,
      createdAt: now,
      archived: 0,
      pinnedAt: null,
      lastActivityAt: now,
      isMulti: 0,
      uiPrefs: {
        maestro: {
          config: { ...getGlobalMaestroConfig().config, strategy: snapshot.automation?.maestroStrategy ?? 'balanced' },
        },
        chat: {
          mode: 'agent' as const,
          permMode: 'ask' as const,
          tools: {
            app: this.settings.allowAppTools,
            mcpDisabled: this.settings.allowMcp ? [] : listMcpServers().map((s) => s.id),
            imageGen: false,
          },
          skillSelection: { kind: this.settings.skills ? ('all' as const) : ('none' as const) },
          subagentsEnabled: snapshot.automation?.subagentsEnabled ?? false,
        },
      },
    }
    insertConversation(conversation)
    primeChatTurnSelection(id, {
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoning: snapshot.effort,
      fastMode: snapshot.fastMode,
    })
    broadcast('conversation:open', { conversation, focus: false })
    const record: DesktopExecutionRecord = {
      runId: context.envelope.runId,
      cardId: context.envelope.cardId,
      title: snapshot.title,
      conversationId: id,
      workspacePath: conversation.cwd,
      state: 'running',
      startedAt: now,
    }
    recordDesktopExecution(record)
    const policy: AutonomousPolicy = {
      providerIds: this.settings.providerIds,
      cwd: conversation.cwd,
      allowCommands: this.settings.allowCommands,
      allowWeb: this.settings.allowWeb,
      allowAppTools: this.settings.allowAppTools,
      allowMcp: this.settings.allowMcp,
      allowPush: this.settings.allowPush,
    }
    const release = registerAutonomousConversation(id, policy)
    const abort = new AbortController()
    const onAbort = () => abort.abort(context.signal?.reason)
    context.signal?.addEventListener('abort', onAbort, { once: true })
    if (context.signal?.aborted) onAbort()
    const published = new Map<string, string>()
    let flushing: Promise<void> | null = null
    const messages = () =>
      listChatMessages(id)
        .filter((m) => !m.internal)
        .map((m) => ({
          id: m.id,
          role: m.role,
          createdAt: m.createdAt,
          text: scrub(
            m.parts
              .filter((p) => p.type === 'text')
              .map((p) => (p.type === 'text' ? p.text : ''))
              .join('\n')
              .replace(AUTONOMOUS_INSTRUCTIONS + '\n\n', '')
              .slice(0, 60000)
          ),
          tools: m.parts
            .filter((p) => p.type === 'tool')
            .map((p) => (p.type === 'tool' ? { name: p.toolName, state: p.state.status } : null)),
        }))
    const flush = ():Promise<void> => {
      if(flushing)return flushing
      flushing=(async()=>{
        for(const message of messages()) {
          const value=JSON.stringify(message)
          if(published.get(message.id)===value)continue
          await context.emit({type:'maestrly.message',data:message})
          published.set(message.id,value)
        }
      })().finally(()=>{flushing=null})
      return flushing
    }
    const transcript = () => {
      const bounded = []
      let bytes = 2
      for (const message of messages()) {
        bytes += Buffer.byteLength(JSON.stringify(message)) + 1
        if (bytes > (snapshot.maxLogBytes ?? 10485760)) break
        bounded.push(message)
      }
      return Buffer.from(JSON.stringify(bounded))
    }
    let handle: Awaited<ReturnType<typeof startExecutorChatTurn>>
    try {
    await context.emit({
      type: 'maestrly.conversation',
      data: { conversationId: id, title: snapshot.title, model: selection.label },
    })
      handle = await withAutonomousPolicy(policy, () =>
        startExecutorChatTurn({
          conversationId: id,
          prompt:
            AUTONOMOUS_INSTRUCTIONS +
            '\n\n' +
            (snapshot.renderedPrompt ?? snapshot.title + '\n' + snapshot.description),
          signal: abort.signal,
        })
      )
    } catch (error) {
      release()
      context.signal?.removeEventListener('abort', onAbort)
      recordDesktopExecution({ ...record, state: 'failed', summary: (error as Error).message })
      throw error
    }
    const timer = setInterval(() => void flush().catch(() => {}), 1000)
    const done = (async (): Promise<ExecutionOutcome> => {
      try {
        const result = await handle.done
        clearInterval(timer)
        await flushing
        await flush()
        const state =
          result.status === 'success'
            ? (policy.report?.state ?? 'failed')
            : result.status === 'cancelled'
              ? 'cancelled'
              : 'failed'
        const summary =
          result.status === 'success'
            ? policy.report?.summary || 'The agent finished without an execution report.'
            : result.status === 'error'
              ? result.error
              : 'Execution cancelled.'
        recordDesktopExecution({ ...record, state, summary })
        return {
          state,
          summary,
          ...(state === 'failed' ? { failure: summary } : {}),
          artifacts: [
            {
              kind: 'log',
              name: 'conversation.json',
              contentType: 'application/json',
              bytes: transcript(),
            },
          ],
        }
      } catch(error) {
        recordDesktopExecution({...record,state:'failed',summary:(error as Error).message})
        throw error
      } finally {
        clearInterval(timer)
        release()
        context.signal?.removeEventListener('abort', onAbort)
      }
    })()
    return {
      done,
      cancel: async () => {
        abort.abort()
        handle.cancel()
        await done
      },
    }
  }
}
