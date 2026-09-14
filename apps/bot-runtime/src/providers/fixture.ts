import { randomUUID } from 'node:crypto'
import type { AuthStatus, ModelCatalogEntry, TurnSnapshot } from '@maestrly/host-protocol'
import { FileService } from '../files/service.js'
import type { ProviderAdapter, TurnHooks, TurnOutcome } from './provider.js'
export class FixtureProvider implements ProviderAdapter {
  private account: AuthStatus = { state: 'disconnected', provider: 'codex' }
  private timer?: NodeJS.Timeout
  constructor(
    private workspace: string,
    private autoLoginMs = Number(process.env.MAESTRLY_BOT_FIXTURE_AUTOLOGIN_MS ?? 50)
  ) {}
  async inspect() {
    return { version: 'fixture-1', capabilities: ['provider.codex', 'tools.files'] }
  }
  async models(): Promise<ModelCatalogEntry[]> {
    return [
      {
        id: 'fixture-small',
        displayName: 'Fixture Small',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        recommended: true,
      },
      { id: 'fixture-large', displayName: 'Fixture Large', efforts: ['low', 'medium', 'high'], recommended: false },
    ]
  }
  auth = {
    status: async () => this.account,
    startDevice: async (): Promise<AuthStatus> => {
      clearTimeout(this.timer)
      this.account = {
        state: 'connecting',
        provider: 'codex',
        method: 'device',
        pending: {
          loginId: 'fixture-login',
          verificationUrl: 'https://auth.openai.com/device',
          userCode: 'ABCD-EFGH',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      }
      this.timer = setTimeout(() => {
        this.account = {
          state: 'connected',
          provider: 'codex',
          method: 'device',
          account: { email: 'fixture@example.test', plan: 'fixture' },
        }
      }, this.autoLoginMs)
      return this.account
    },
    startApiKey: async (_apiKey: string): Promise<AuthStatus> => {
      clearTimeout(this.timer)
      this.account = { state: 'connected', provider: 'codex', method: 'apiKey' }
      return this.account
    },
    cancel: async (loginId: string) => {
      if (this.account.pending?.loginId === loginId) {
        clearTimeout(this.timer)
        this.account = { state: 'disconnected', provider: 'codex' }
      }
    },
    logout: async () => {
      clearTimeout(this.timer)
      this.account = { state: 'disconnected', provider: 'codex' }
    },
  }
  async startTurn(snapshot: TurnSnapshot, hooks: TurnHooks, signal: AbortSignal): Promise<TurnOutcome> {
    const providerThreadId = `fixture-thread-${snapshot.conversationId}`
    const providerTurnId = `fixture-turn-${snapshot.turnId}`
    const files = new FileService(this.workspace)
    const write = async (path: string, content: string) => {
      signal.throwIfAborted()
      return files.write({
        transferId: randomUUID(),
        path,
        offset: 0,
        dataBase64: Buffer.from(content).toString('base64'),
        final: true,
        overwrite: true,
      })
    }
    signal.throwIfAborted()
    hooks.emit({
      kind: 'turn.status',
      summary: 'O bot começou a trabalhar',
      detail: { status: 'running', providerThreadId, providerTurnId },
    })
    let message = `Fixture reply to: ${snapshot.message}`
    if (snapshot.message.includes('#approve')) {
      const decision = await hooks.requestApproval({
        actionId: randomUUID(),
        title: 'Executar um comando',
        reason: 'Criar um arquivo de teste',
        consequence: 'Cria approved.txt no espaço de trabalho',
        parameters: { command: 'touch approved.txt' },
      })
      if (decision === 'approve') await write('approved.txt', '')
    }
    if (snapshot.message.includes('#ask'))
      message += ` ${await hooks.askQuestion({ actionId: randomUUID(), title: 'Uma pergunta', question: 'Qual é a resposta?' })}`
    if (snapshot.message.includes('#slow'))
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve()
        const finish = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, 60_000)
        signal.addEventListener('abort', finish, { once: true })
      })
    if (signal.aborted) return { status: 'cancelled', providerThreadId, providerTurnId }
    if (snapshot.message.includes('#fail'))
      return {
        status: 'failed',
        error: { code: 'FIXTURE_FAILURE', message: 'Requested fixture failure' },
        providerThreadId,
        providerTurnId,
      }
    const filename = snapshot.message.match(/#write:([^\s]+)/)?.[1]
    if (filename) {
      await write(filename, 'hello from fixture')
      const info = await files.stat({ path: filename })
      hooks.emit({
        kind: 'file.produced',
        summary: 'Arquivo criado',
        detail: { path: filename, name: filename.split('/').at(-1), size: info.size, digest: info.digest },
      })
    }
    for (let i = 0; i < message.length; i += 8)
      hooks.emit({ kind: 'assistant.delta', summary: 'Escrevendo…', detail: { text: message.slice(i, i + 8) } })
    hooks.emit({ kind: 'assistant.message', summary: 'O bot respondeu', detail: { content: message } })
    return { status: 'succeeded', providerThreadId, providerTurnId }
  }
  async cancelTurn(_turnId: string) {}
  async dispose() {
    clearTimeout(this.timer)
  }
}
