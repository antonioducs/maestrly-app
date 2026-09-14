import { join } from 'node:path'
import { CodexAppServerClient } from '@maestrly/codex-client'
import { delegatedCredentialSchema, legacyCredentialSchema, modelCatalogEntrySchema,
  type AuthStatus, type DelegatedCredential, type LegacyCredential, type ModelCatalogEntry } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { verifyAsset } from '../assets.js'
import type { Asset } from '../assets/catalog.js'
import type { AccountProvider } from './provider.js'
import { privateDirectory, readPrivate, writePrivate } from './private-files.js'

export type AccountRuntime = { binary: Asset; version: string }
export class CodexAccountProvider implements AccountProvider {
  private client!: CodexAppServerClient
  private pending?: AuthStatus['pending']
  private unsubscribe: () => void = () => {}
  private constructor(private directory: string, private runtime: AccountRuntime) {}
  static async open(directory: string, runtime: AccountRuntime) {
    const provider = new CodexAccountProvider(directory, runtime)
    await privateDirectory(directory)
    await privateDirectory(join(directory, 'home'))
    await privateDirectory(join(directory, 'codex'))
    await provider.connect()
    return provider
  }
  private async connect() {
    const binaryPath = await verifyAsset(this.runtime.binary, true)
    this.client = await CodexAppServerClient.connect({
      binaryPath,
      binaryArgs: ['app-server', '-c', 'cli_auth_credentials_store="file"'],
      cwd: join(this.directory, 'home'),
      clientInfo: { name: 'maestrly_bot_accounts', title: 'Maestrly Bot Accounts', version: this.runtime.version },
      capabilities: { experimentalApi: false },
      minimalEnvironment: true,
      env: { HOME: join(this.directory, 'home'), CODEX_HOME: join(this.directory, 'codex'), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', RUST_LOG: 'off' },
      stderrBufferLimit: 0,
      serverRequestHandler: () => { throw new Error('Account service does not execute tools') },
    })
    this.unsubscribe = this.client.onNotification(notification => {
      if (notification.method === 'account/login/completed') {
        const value = notification.params as { loginId?: string } | undefined
        if (value?.loginId === this.pending?.loginId) this.pending = undefined
      }
    })
  }
  healthy() { return this.client.state === 'ready' }
  async status(): Promise<AuthStatus> {
    if (this.pending && Date.parse(this.pending.expiresAt) > Date.now()) return { state: 'connecting', provider: 'codex', method: 'device', pending: this.pending }
    this.pending = undefined
    const { account } = await this.client.readAccount({ refreshToken: false })
    if (!account) return { state: 'disconnected', provider: 'codex' }
    if (account.type === 'apiKey') return { state: 'connected', provider: 'codex', method: 'apiKey' }
    if (account.type === 'chatgpt') return { state: 'connected', provider: 'codex', method: 'device', account: { email: account.email?.slice(0, 200) ?? null, plan: account.planType?.slice(0, 60) ?? null } }
    return { state: 'incompatible', provider: 'codex', incompatibleReason: 'Esta conta não é compatível com o provedor configurado.' }
  }
  async startDevice() {
    if (this.pending) return this.status()
    const value = await this.client.startAccountLogin({ type: 'chatgptDeviceCode' })
    if (value.type !== 'chatgptDeviceCode' || !/^https:\/\/(?:auth\.openai\.com|chatgpt\.com)\//.test(value.verificationUrl))
      throw new HostError('AUTH_URL_UNTRUSTED', 'O provedor devolveu um endereço de login inesperado')
    this.pending = { loginId: value.loginId, verificationUrl: value.verificationUrl, userCode: value.userCode, expiresAt: new Date(Date.now() + 600_000).toISOString() }
    return this.status()
  }
  async startApiKey(apiKey: string) {
    await this.cancel()
    await this.client.startAccountLogin({ type: 'apiKey', apiKey })
    return this.status()
  }
  async cancel() {
    const loginId = this.pending?.loginId
    this.pending = undefined
    if (loginId) await this.client.cancelAccountLogin({ loginId })
    return this.status()
  }
  async logout() {
    await this.cancel()
    await this.client.logoutAccount()
    return this.status()
  }
  async models(): Promise<ModelCatalogEntry[]> {
    const { data } = await this.client.listModels()
    if (!Array.isArray(data) || data.length > 100) throw new HostError('ACCOUNT_PROTOCOL', 'O catálogo de modelos recebido é inválido')
    return data.flatMap(entry => {
      const model = entry as Record<string, any>
      const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map((value: any) => value.reasoningEffort) : []
      const parsed = modelCatalogEntrySchema.safeParse({ id: model.id ?? model.model, displayName: model.displayName ?? model.id,
        efforts: [...new Set(efforts)].filter(effort => ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(effort))),
        defaultEffort: model.defaultReasoningEffort, recommended: model.isDefault === true })
      return parsed.success ? [parsed.data] : []
    })
  }
  async credential(forceRefresh: boolean): Promise<DelegatedCredential> {
    let saved = await this.readCredential()
    if (saved.OPENAI_API_KEY) return delegatedCredentialSchema.parse({ type: 'apiKey', apiKey: saved.OPENAI_API_KEY })
    const expires = tokenExpiry(saved.tokens?.access_token)
    if (forceRefresh || expires < Date.now() + 120_000) {
      await this.client.readAccount({ refreshToken: true }, { timeoutMs: 8_000 })
      saved = await this.readCredential()
    }
    if (!saved.tokens?.account_id || tokenExpiry(saved.tokens.access_token) <= Date.now())
      throw new HostError('ACCOUNT_REQUIRED', 'Reconecte a conta em Contas para continuar')
    const status = await this.status()
    return delegatedCredentialSchema.parse({ type: 'chatgptAuthTokens', accessToken: saved.tokens.access_token,
      chatgptAccountId: saved.tokens.account_id, chatgptPlanType: status.account?.plan ?? null })
  }
  private async readCredential() { return legacyCredentialSchema.parse(JSON.parse(await readPrivate(join(this.directory, 'codex', 'auth.json')))) }
  async importCredential(credential: LegacyCredential) {
    const clean = legacyCredentialSchema.parse(credential)
    // A retry after a lost copy acknowledgement must keep a token already refreshed by this authority.
    const existing = await this.readCredential().catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (existing) {
      if (clean.OPENAI_API_KEY ? existing.OPENAI_API_KEY !== clean.OPENAI_API_KEY : !existing.tokens?.account_id || existing.tokens.account_id !== clean.tokens?.account_id)
        throw new HostError('ACCOUNT_MIGRATION_CONFLICT', 'Outra conta já ocupa o destino da migração')
      return
    }
    await this.close()
    await writePrivate(join(this.directory, 'codex', 'auth.json'), JSON.stringify(clean))
    await this.connect()
  }
  async close() { this.pending = undefined; this.unsubscribe(); await this.client.close() }
}
export function tokenExpiry(token?: string) {
  try {
    if (!token || token.length > 24 * 1024) return 0
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp
    return Number.isSafeInteger(exp) ? exp * 1000 : 0
  } catch { return 0 }
}
