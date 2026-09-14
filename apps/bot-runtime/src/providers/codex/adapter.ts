import { existsSync } from 'node:fs'
import { mkdir, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CodexAppServerClient,
  codexTextInput,
  type CodexAppServerConnectOptions,
  type CodexUserInput,
  type CodexNotification,
} from '@maestrly/codex-client'
import { modelCatalogEntrySchema, type ModelCatalogEntry, type TurnSnapshot } from '@maestrly/host-protocol'
import { FileService } from '../../files/service.js'
import type { ProviderAdapter, TurnHooks, TurnOutcome } from '../provider.js'
import { CodexAccount } from './account.js'
import { configuration } from './configuration.js'
import { notificationEvent, object, serverRequest } from './events.js'
export class CodexAdapter implements ProviderAdapter {
  readonly auth: CodexAccount
  private active?: { turnId: string; threadId?: string; providerTurnId?: string; hooks: TurnHooks }
  private threads = new Map<string, string>()
  private constructor(
    readonly client: CodexAppServerClient,
    private workspace: string,
    private state: string,
    delegated = false
  ) {
    this.auth = new CodexAccount(client, { home: join(state, 'codex'), state, delegated })
    client.setServerRequestHandler((request) => {
      if (request.method === 'account/chatgptAuthTokens/refresh') return this.auth.refreshDelegated(request.params)
      if (!this.active) throw new Error('No active turn')
      const params = object(request.params)
      if (
        (params.threadId && params.threadId !== this.active.threadId) ||
        (params.turnId && this.active.providerTurnId && params.turnId !== this.active.providerTurnId)
      )
        throw new Error('Stale provider request')
      return serverRequest(request, this.active.hooks)
    })
  }
  static async connect(options: {
    state: string
    workspace: string
    version: string
    binaryPath?: string
    binaryArgs?: string[]
  }) {
    const home = join(options.state, 'codex')
    await mkdir(home, { recursive: true, mode: 0o700 })
    await chmod(home, 0o700)
    await mkdir(options.workspace, { recursive: true })
    const proxy = `http://127.0.0.1:${process.env.MAESTRLY_BOT_PROXY_PORT ?? 3128}`
    const delegated = existsSync(join(options.state, 'account-delegated.json')) || (!!process.env.MAESTRLY_BOT_ID && !existsSync(join(home, 'auth.json')))
    const connection: CodexAppServerConnectOptions = {
      binaryPath: options.binaryPath ?? process.env.MAESTRLY_CODEX_BINARY ?? '/opt/maestrly-bot/codex/bin/codex',
      binaryArgs: options.binaryArgs ?? ['app-server', '-c', `cli_auth_credentials_store="${delegated ? 'ephemeral' : 'file'}"`],
      clientInfo: { name: 'maestrly_bot', title: 'Maestrly Bot', version: options.version },
      capabilities: { experimentalApi: true },
      cwd: options.workspace,
      minimalEnvironment: true,
      env: {
        HOME: join(options.workspace, '..'),
        ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
        CODEX_HOME: home,
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
        NO_PROXY: '127.0.0.1,localhost',
      },
      // minimalEnvironment starts empty; explicit env above wins after prefix removal.
      unsetEnvPrefixes: ['OPENAI_', 'CODEX_'],
    }
    return new CodexAdapter(await CodexAppServerClient.connect(connection), options.workspace, options.state, delegated)
  }
  async inspect() {
    if (this.client.state !== 'ready') throw new Error('Provider unavailable')
    return { version: this.client.initializeResult.userAgent, capabilities: ['provider.codex', 'tools.files'] }
  }
  async models(): Promise<ModelCatalogEntry[]> {
    const response = await this.client.listModels()
    const entries = response.data ?? response.models
    if (!Array.isArray(entries)) return []
    return entries.flatMap((entry) => {
      const model = object(entry)
      const supported = model.supportedReasoningEfforts ?? model.efforts
      const efforts = Array.isArray(supported)
        ? supported
            .map((e) => (typeof e === 'string' ? e : object(e).reasoningEffort))
            .filter((e) => ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(e)))
        : []
      const parsed = modelCatalogEntrySchema.safeParse({
        id: model.id ?? model.model,
        displayName: model.displayName ?? model.id ?? model.model,
        efforts: [...new Set(efforts)].slice(0, 5),
        defaultEffort: model.defaultReasoningEffort,
        recommended: model.isDefault === true,
      })
      return parsed.success ? [parsed.data] : []
    })
  }
  async startTurn(snapshot: TurnSnapshot, hooks: TurnHooks, signal: AbortSignal): Promise<TurnOutcome> {
    if (this.active) throw new Error('Provider already has an active turn')
    const active = {
      turnId: snapshot.turnId,
      hooks,
      threadId: undefined as string | undefined,
      providerTurnId: undefined as string | undefined,
    }
    this.active = active
    let finish!: (outcome: TurnOutcome) => void
    let usage: TurnOutcome['usage']
    let abortTimer: NodeJS.Timeout | undefined
    let settled = false
    const done = new Promise<TurnOutcome>((resolve) => {
      finish = (outcome) => {
        if (settled) return
        settled = true
        resolve({ ...outcome, usage, providerThreadId: active.threadId, providerTurnId: active.providerTurnId })
      }
    })
    const early: CodexNotification[] = []
    const consume = (notification: CodexNotification) => {
      const params = object(notification.params)
      if (!active.threadId || (params.threadId && params.threadId !== active.threadId)) return
      const turn = object(params.turn)
      const providerTurnId = params.turnId ?? turn.id
      if (active.providerTurnId && providerTurnId && providerTurnId !== active.providerTurnId) return
      const outcome = notificationEvent(notification, hooks)
      if (outcome?.usage) usage = outcome.usage
      if (outcome?.status) finish(outcome as TurnOutcome)
    }
    const unsubscribe = this.client.onNotification((notification) => {
      if (!active.providerTurnId) {
        if (early.length < 256) early.push(notification)
        else finish({ status: 'failed', error: { code: 'PROVIDER_PROTOCOL', message: 'Too many early notifications' } })
      } else consume(notification)
    })
    const abort = () => {
      abortTimer ??= setTimeout(() => {
        // No completion after interruption: stop the process tree, including a turn/start still awaiting its ID.
        void this.client.close().then(() => finish({ status: 'cancelled' }))
      }, 10_000)
      void this.cancelTurn(snapshot.turnId).catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    void this.client
      .waitForExit()
      .then(() =>
        finish({ status: 'interrupted', error: { code: 'PROVIDER_EXITED', message: 'Codex process exited' } })
      )
    try {
      signal.throwIfAborted()
      const existing = snapshot.providerThreadId ?? this.threads.get(snapshot.conversationId)
      if (existing) {
        // Codex 0.153.4 retains MCP processes/config for a loaded thread even
        // after resume or unsubscribe. Archive/unarchive unloads those processes
        // without deleting the thread, so each bridge gets this turn's scope.
        // Never substitute a new thread silently when this recovery fails.
        await this.client.request('thread/archive', { threadId: existing }, { signal })
        await this.client.request('thread/unarchive', { threadId: existing }, { signal })
        active.threadId = (
          await this.client.resumeThread(
            { threadId: existing, ...configuration(snapshot, this.workspace, false, this.state).thread },
            { signal }
          )
        ).thread.id
      }
      if (!active.threadId)
        active.threadId = (
          await this.client.startThread(configuration(snapshot, this.workspace, true, this.state).thread, { signal })
        ).thread.id
      this.threads.set(snapshot.conversationId, active.threadId)
      const input: CodexUserInput[] = [codexTextInput(snapshot.message)]
      const files = new FileService(this.workspace)
      for (const attachment of snapshot.attachments) {
        if (!/\.(png|jpe?g|webp|gif)$/i.test(attachment)) continue
        const path = await files.safePath(attachment)
        if ((await files.stat({ path: attachment })).kind !== 'file') throw new Error('Image must be a file')
        input.push({ type: 'localImage', path })
      }
      signal.throwIfAborted()
      // Do not abort the RPC itself: we need its turn ID to interrupt accepted work.
      const response = await this.client.startTurn({
        threadId: active.threadId,
        input,
        model: snapshot.model?.model,
        effort: snapshot.model?.effort,
        sandboxPolicy: configuration(snapshot, this.workspace, false, this.state).sandboxPolicy,
      })
      active.providerTurnId = response.turn.id
      hooks.emit({
        kind: 'turn.status',
        summary: 'O bot começou a trabalhar',
        detail: { status: 'running', providerThreadId: active.threadId, providerTurnId: active.providerTurnId },
      })
      for (const notification of early) consume(notification)
      early.length = 0
      if (signal.aborted) abort()
      const outcome = await done
      return { ...outcome, providerThreadId: active.threadId, providerTurnId: active.providerTurnId }
    } catch (error) {
      if (signal.aborted)
        return { status: 'cancelled', providerThreadId: active.threadId, providerTurnId: active.providerTurnId }
      throw error
    } finally {
      settled = true
      clearTimeout(abortTimer)
      signal.removeEventListener('abort', abort)
      unsubscribe()
      if (this.active === active) this.active = undefined
    }
  }
  async cancelTurn(turnId: string) {
    const active = this.active
    if (active?.turnId === turnId && active.threadId && active.providerTurnId)
      await this.client.interruptTurn(
        { threadId: active.threadId, turnId: active.providerTurnId },
        { timeoutMs: 10_000 }
      )
  }
  waitForExit() {
    return this.client.waitForExit()
  }
  async dispose() {
    this.auth.dispose()
    await this.client.close()
  }
}
