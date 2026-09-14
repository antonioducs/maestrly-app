import type { CodexAppServerClient } from '@maestrly/codex-client'
import { delegatedCredentialSchema, legacyCredentialSchema, type AuthStatus, type DelegatedCredential } from '@maestrly/host-protocol'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
export class CodexAccount {
  private current: AuthStatus = { state: 'disconnected', provider: 'codex' }
  private unsubscribe: () => void
  private credentialProvider?: (forceRefresh: boolean, credentialHash?: string) => Promise<DelegatedCredential>
  private delegatedAccountId?: string
  private credentialHash?: string
  constructor(private client: CodexAppServerClient, private options?: { home: string; state: string; delegated: boolean }) {
    this.unsubscribe = client.onNotification((notification) => {
      if (notification.method !== 'account/login/completed') return
      const params = notification.params as { loginId?: string; success?: boolean }
      if (!params || params.loginId !== this.current.pending?.loginId) return
      this.current = { state: 'disconnected', provider: 'codex' }
      if (params.success) void this.status().catch(() => {})
    })
  }
  status = async (): Promise<AuthStatus> => {
    if (this.current.state === 'connecting' || this.current.state === 'incompatible') return this.current
    const previous = this.current
    const { account } = await this.client.readAccount()
    // Polling may have begun before a device login returned its code. Do not
    // discard that newer login (or a completed logout) with a stale read.
    if (this.current !== previous) return this.current
    if (!account) this.current = { state: 'disconnected', provider: 'codex' }
    else if (account.type === 'apiKey') this.current = { state: 'connected', provider: 'codex', method: 'apiKey' }
    else if (account.type === 'chatgpt')
      this.current = {
        state: 'connected',
        provider: 'codex',
        method: 'device',
        account: { email: account.email?.slice(0, 200) ?? null, plan: account.planType?.slice(0, 60) ?? null },
      }
    else this.current = { state: 'incompatible', provider: 'codex', incompatibleReason: 'Unsupported account type' }
    return this.current
  }
  setCredentialProvider(provider: (forceRefresh: boolean, credentialHash?: string) => Promise<DelegatedCredential>) { this.credentialProvider = provider }
  useDelegated = async (input: DelegatedCredential): Promise<AuthStatus> => {
    const credential = delegatedCredentialSchema.parse(input)
    if (credential.type === 'apiKey' && !this.options?.delegated) throw Object.assign(new Error('Migrate the account before delegating an API key'), { code: 'ACCOUNT_MIGRATION_REQUIRED' })
    await this.client.startAccountLogin(credential)
    this.credentialHash = createHash('sha256').update(credential.type === 'apiKey' ? credential.apiKey : credential.accessToken).digest('hex')
    this.delegatedAccountId = credential.type === 'chatgptAuthTokens' ? credential.chatgptAccountId : undefined
    this.current = { state: 'disconnected', provider: 'codex' }
    return this.status()
  }
  async refreshDelegated(params: unknown) {
    const previousAccountId = params && typeof params === 'object' && 'previousAccountId' in params ? params.previousAccountId : undefined
    if (!this.credentialProvider || !this.delegatedAccountId || (previousAccountId && previousAccountId !== this.delegatedAccountId))
      throw new Error('Account refresh does not belong to this session')
    const value = delegatedCredentialSchema.parse(await this.credentialProvider(true, this.credentialHash))
    if (value.type !== 'chatgptAuthTokens' || value.chatgptAccountId !== this.delegatedAccountId) throw new Error('Account identity changed during refresh')
    this.credentialHash = createHash('sha256').update(value.accessToken).digest('hex')
    return { accessToken: value.accessToken, chatgptAccountId: value.chatgptAccountId, chatgptPlanType: value.chatgptPlanType ?? null }
  }
  async prepareDelegation() {
    if (!this.options || this.options.delegated) return
    try {
      await this.readLegacy()
      throw Object.assign(new Error('Migrate the connected legacy account first'), { code: 'ACCOUNT_MIGRATION_REQUIRED' })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const marker = join(this.options.state, 'account-delegated.json')
    const temporary = `${marker}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ digest: createHash('sha256').update('empty-account').digest('hex') })); await handle.sync() } finally { await handle.close() }
    await rename(temporary, marker)
    await syncDirectory(this.options.state)
    await this.client.close()
  }
  async exportLegacy() {
    if (!this.options || this.options.delegated) throw new Error('No legacy account to migrate')
    return this.readLegacy()
  }
  private async readLegacy() {
    if (!this.options) throw new Error('Account directory unavailable')
    const handle = await open(join(this.options.home, 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 96 * 1024) throw new Error('Invalid legacy credential file')
      const bytes = Buffer.alloc(96 * 1024 + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 96 * 1024) throw new Error('Invalid legacy credential size')
      const credential = legacyCredentialSchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')))
      return { credential, digest: createHash('sha256').update(JSON.stringify(credential)).digest('hex') }
    } finally { await handle.close() }
  }
  async commitMigration(digest: string) {
    if (!this.options) throw new Error('Account directory unavailable')
    const marker = join(this.options.state, 'account-delegated.json')
    const committed = await readFile(marker, 'utf8').then(value => JSON.parse(value), error => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (committed) {
      if (committed.digest !== digest) throw new Error('Another migration already owns the account')
      const retained = await this.readLegacy().catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })
      if (retained && retained.digest !== digest) throw new Error('The legacy credential changed after cutover')
      if (retained) { await unlink(join(this.options.home, 'auth.json')); await syncDirectory(this.options.home) }
      if (!this.options.delegated) await this.client.close()
      return
    }
    const exported = await this.exportLegacy()
    if (exported.digest !== digest) throw Object.assign(new Error('The legacy login changed during migration'), { code: 'ACCOUNT_MIGRATION_CHANGED' })
    const temporary = `${marker}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ digest })); await handle.sync() } finally { await handle.close() }
    await rename(temporary, marker)
    await syncDirectory(this.options.state)
    await unlink(join(this.options.home, 'auth.json'))
    await syncDirectory(this.options.home)
    // Provider supervision reopens with an ephemeral credential store; the desktop and files remain intact.
    await this.client.close()
  }
  startDevice = async (): Promise<AuthStatus> => {
    const result = await this.client.startAccountLogin({ type: 'chatgptDeviceCode' })
    if (
      result.type !== 'chatgptDeviceCode' ||
      !/^https:\/\/(auth\.openai\.com|chatgpt\.com)\//.test(result.verificationUrl)
    ) {
      this.current = {
        state: 'incompatible',
        provider: 'codex',
        incompatibleReason: 'Device login returned an untrusted verification URL or unsupported flow',
      }
      return this.current
    }
    this.current = {
      state: 'connecting',
      provider: 'codex',
      method: 'device',
      pending: {
        loginId: result.loginId,
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    }
    return this.current
  }
  startApiKey = async (apiKey: string): Promise<AuthStatus> => {
    await this.client.startAccountLogin({ type: 'apiKey', apiKey })
    this.current = { state: 'disconnected', provider: 'codex' }
    return this.status()
  }
  cancel = async (loginId: string) => {
    await this.client.cancelAccountLogin({ loginId })
    if (this.current.pending?.loginId === loginId) this.current = { state: 'disconnected', provider: 'codex' }
    return this.current
  }
  logout = async () => {
    this.delegatedAccountId = undefined
    await this.client.logoutAccount()
    this.current = { state: 'disconnected', provider: 'codex' }
    return this.current
  }
  dispose() {
    this.unsubscribe()
  }
}

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
}
