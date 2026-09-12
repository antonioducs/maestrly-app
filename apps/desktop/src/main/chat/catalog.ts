/**
 * BYOK chat providers — USER-DEFINED (empty by default). Users add
 * as many as needed (name + baseURL + key); OpenAI-compatible OR native Anthropic (`kind`). Persisted as
 * JSON in `app_settings` (`chat.providers`) with `{id,name,baseURL,kind?}` — API KEYS live encrypted in
 * secure-store by ID (see credentials.ts), never here. Models are NOT catalog entries: fetch them
 * dynamically from `GET {baseURL}/models` (see models.ts).
 *
 * Conceptually ported from opencode `catalog.ts`/`provider.ts`, without the fixed remote catalog — BYOK means
 * "bring your provider". PRESETS below only prefill the add form (shortcuts); they are not
 * saved until the user confirms.
 */
import { randomUUID } from 'node:crypto'
import { getAppSetting, setAppSetting, getAppFlag, setAppFlag } from '../store'
import {
  CHATGPT_WEB_PROVIDER_ID,
  effectiveProviderKind,
  isChatSubscriptionProviderKind,
  subscriptionAccountId,
  subscriptionBaseProviderId,
  withSubscriptionAccount,
  type ChatProviderKind,
  type ChatProviderPreset,
  type ChatSubscriptionAccount,
  type ChatSubscriptionProviderKind,
} from '../../shared/chat'

export { subscriptionAccountId, subscriptionBaseProviderId, withSubscriptionAccount }

export interface ChatProvider {
  id: string
  name: string
  baseURL: string
  /** API format: 'anthropic' (native) | 'openai' (compatible) | 'openai-responses' (Responses API). Absent = derive from host (defaultProviderKind). */
  kind?: ChatProviderKind
  /** App-managed virtual provider; never persisted in BYOK provider JSON. */
  builtin?: ChatSubscriptionProviderKind
  /** Additional account slot (multiple accounts); absent/null = default account. */
  accountId?: string | null
  /** User-defined label for an additional account. */
  accountLabel?: string
}

const PROVIDERS_KEY = 'chat.providers'
const KIND_VALUES: readonly ChatProviderKind[] = ['anthropic', 'openai', 'openai-responses']
/** Persist only recognized kinds; drop other values (derive from host). */
const isKnownKind = (v: unknown): v is ChatProviderKind => KIND_VALUES.includes(v as ChatProviderKind)

/** Official runtime virtual provider. Authentication lives in isolated CODEX_HOME, never BYOK secure-store. */
export const CODEX_SUBSCRIPTION_PROVIDER_ID = 'builtin_codex_subscription'
export const CODEX_SUBSCRIPTION_PROVIDER: ChatProvider = {
  id: CODEX_SUBSCRIPTION_PROVIDER_ID,
  name: 'Codex (ChatGPT)',
  baseURL: 'codex://chatgpt-subscription',
  kind: 'codex-subscription',
  builtin: 'codex-subscription',
}

export function isCodexSubscriptionProvider(providerId: string | null | undefined): boolean {
  return !!providerId && subscriptionBaseProviderId(providerId) === CODEX_SUBSCRIPTION_PROVIDER_ID
}

/** Official GitHub Copilot SDK/CLI runtime virtual provider. */
export const GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID = 'builtin_github_copilot_subscription'
export const GITHUB_COPILOT_SUBSCRIPTION_PROVIDER: ChatProvider = {
  id: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID,
  name: 'GitHub Copilot',
  baseURL: 'copilot://github-subscription',
  kind: 'github-copilot-subscription',
  builtin: 'github-copilot-subscription',
}

export function isGitHubCopilotSubscriptionProvider(providerId: string | null | undefined): boolean {
  return !!providerId && subscriptionBaseProviderId(providerId) === GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID
}

/** Claude Agent SDK virtual provider using the Claude Code authenticated subscription. */
export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = 'builtin_claude_subscription'
export const CLAUDE_SUBSCRIPTION_PROVIDER: ChatProvider = {
  id: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  name: 'Claude',
  baseURL: 'claude://subscription',
  kind: 'claude-subscription',
  builtin: 'claude-subscription',
}

export function isClaudeSubscriptionProvider(providerId: string | null | undefined): boolean {
  return !!providerId && subscriptionBaseProviderId(providerId) === CLAUDE_SUBSCRIPTION_PROVIDER_ID
}

/** Grok/xAI subscription virtual provider via OAuth (OpenAI-compatible API). */
export const GROK_SUBSCRIPTION_PROVIDER_ID = 'builtin_grok_subscription'
export const GROK_SUBSCRIPTION_PROVIDER: ChatProvider = {
  id: GROK_SUBSCRIPTION_PROVIDER_ID,
  name: 'Grok',
  baseURL: 'https://api.x.ai/v1',
  kind: 'grok-subscription',
  builtin: 'grok-subscription',
}

export function isGrokSubscriptionProvider(providerId: string | null | undefined): boolean {
  return !!providerId && subscriptionBaseProviderId(providerId) === GROK_SUBSCRIPTION_PROVIDER_ID
}

export function isSubscriptionProvider(providerId: string | null | undefined): boolean {
  return (
    isCodexSubscriptionProvider(providerId) ||
    isGitHubCopilotSubscriptionProvider(providerId) ||
    isClaudeSubscriptionProvider(providerId) ||
    isGrokSubscriptionProvider(providerId)
  )
}

/** Experimental companion integration; retain the ID for configuration, credentials, and migration. */
export { CHATGPT_WEB_PROVIDER_ID }
/** Experimental integration flag (manual setup, opt-in). */
const CHATGPT_WEB_FLAG = 'chat.chatgptWeb'

export function isChatGptWebProvider(providerId: string | null | undefined): boolean {
  return providerId === CHATGPT_WEB_PROVIDER_ID
}

export function isChatGptWebEnabled(): boolean {
  return getAppFlag(CHATGPT_WEB_FLAG, false)
}

export function setChatGptWebEnabled(enabled: boolean): void {
  setAppFlag(CHATGPT_WEB_FLAG, enabled)
}

/** App-managed providers: users can never edit/remove them. */
export function isManagedProvider(providerId: string | null | undefined): boolean {
  return isSubscriptionProvider(providerId) || isChatGptWebProvider(providerId)
}

// ----------------------------------------------------------------------------
// ADDITIONAL subscription-provider accounts. The legacy default account is not in this
// list: it is the base provider (`builtin_*`, no suffix) — old conversations/defaults remain
// valid without migration. Each additional account derives providerId `builtin_*@acc_<uuid>`.
// ----------------------------------------------------------------------------

const SUBSCRIPTION_ACCOUNTS_KEY = 'chat.subscriptionAccounts'

const SUBSCRIPTION_BASE_PROVIDERS: Record<ChatSubscriptionProviderKind, ChatProvider> = {
  'codex-subscription': CODEX_SUBSCRIPTION_PROVIDER,
  'github-copilot-subscription': GITHUB_COPILOT_SUBSCRIPTION_PROVIDER,
  'claude-subscription': CLAUDE_SUBSCRIPTION_PROVIDER,
  'grok-subscription': GROK_SUBSCRIPTION_PROVIDER,
}

/** Persisted additional accounts (creation order). */
export function listSubscriptionAccounts(): ChatSubscriptionAccount[] {
  const raw = getAppSetting(SUBSCRIPTION_ACCOUNTS_KEY)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter(
        (a) =>
          a && typeof a.id === 'string' && a.id && isChatSubscriptionProviderKind(a.kind) && typeof a.label === 'string'
      )
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        createdAt: typeof a.createdAt === 'number' ? a.createdAt : 0,
      }))
  } catch {
    return []
  }
}

function saveSubscriptionAccounts(list: ChatSubscriptionAccount[]): void {
  setAppSetting(SUBSCRIPTION_ACCOUNTS_KEY, JSON.stringify(list))
}

export function getSubscriptionAccount(accountId: string): ChatSubscriptionAccount | undefined {
  return listSubscriptionAccounts().find((a) => a.id === accountId)
}

/** Creates an additional account slot. Service initiates login using its derived providerId. */
export function addSubscriptionAccount(kind: ChatSubscriptionProviderKind, label: string): ChatSubscriptionAccount {
  if (!isChatSubscriptionProviderKind(kind)) throw new Error('Unknown subscription provider kind.')
  const normalized = label.trim()
  if (!normalized) throw new Error('Enter an account label.')
  // Filesystem-safe ID: suffix for account directories/secure-store keys.
  const account: ChatSubscriptionAccount = {
    id: 'acc_' + randomUUID(),
    kind,
    label: normalized,
    createdAt: Date.now(),
  }
  saveSubscriptionAccounts([...listSubscriptionAccounts(), account])
  return account
}

/** Returns false for empty labels or nonexistent accounts — UI must distinguish success from no-op. */
export function renameSubscriptionAccount(accountId: string, label: string): boolean {
  const normalized = label.trim()
  if (!normalized) return false
  const list = listSubscriptionAccounts()
  const idx = list.findIndex((a) => a.id === accountId)
  if (idx < 0) return false
  list[idx] = { ...list[idx], label: normalized }
  saveSubscriptionAccounts(list)
  return true
}

/** Removes only the SLOT. Service owns account home/credential/thread cleanup. */
export function removeSubscriptionAccount(accountId: string): void {
  saveSubscriptionAccounts(listSubscriptionAccounts().filter((a) => a.id !== accountId))
}

/** Effective subscription-account providerId (null = default account, base ID). */
export function subscriptionProviderIdFor(kind: ChatSubscriptionProviderKind, accountId: string | null): string {
  return withSubscriptionAccount(SUBSCRIPTION_BASE_PROVIDERS[kind].id, accountId)
}

function providerForSubscriptionAccount(account: ChatSubscriptionAccount): ChatProvider {
  const base = SUBSCRIPTION_BASE_PROVIDERS[account.kind]
  return {
    ...base,
    id: withSubscriptionAccount(base.id, account.id),
    name: `${base.name} — ${account.label}`,
    accountId: account.id,
    accountLabel: account.label,
  }
}

/** Resolves subscription providerId (base or parameterized) → ChatProvider; undefined if account is absent. */
function getSubscriptionProvider(id: string): ChatProvider | undefined {
  const base = Object.values(SUBSCRIPTION_BASE_PROVIDERS).find(
    (provider) => provider.id === subscriptionBaseProviderId(id)
  )
  if (!base) return undefined
  const accountId = subscriptionAccountId(id)
  if (!accountId) return base
  const account = getSubscriptionAccount(accountId)
  return account && account.kind === base.builtin ? providerForSubscriptionAccount(account) : undefined
}

// One-time migration: OpenAI providers saved BEFORE 'openai-responses' used explicit
// kind:'openai' (the form always writes kind), so the new host default alone does not affect them.
// Repoint api.openai.com + kind:'openai' → 'openai-responses'. Runtime also forces Responses API
// by host, covering legacy providers edited after this flag was written.
const KIND_MIGRATED_FLAG = 'chat.providersKindMigrated'
function migrateProviderKinds(): void {
  if (getAppFlag(KIND_MIGRATED_FLAG, false)) return
  const raw = getAppSetting(PROVIDERS_KEY)
  if (raw) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        let changed = false
        for (const p of arr) {
          if (p && p.kind === 'openai' && typeof p.baseURL === 'string' && hostOf(p.baseURL) === 'api.openai.com') {
            p.kind = 'openai-responses'
            changed = true
          }
        }
        if (changed) setAppSetting(PROVIDERS_KEY, JSON.stringify(arr))
      }
    } catch {
      /* Invalid JSON → nothing to migrate. */
    }
  }
  setAppFlag(KIND_MIGRATED_FLAG, true)
}

function hostOf(baseURL: string): string | null {
  try {
    return new URL(baseURL).host
  } catch {
    return null
  }
}

/** Known shortcuts (only prefill name+URL in the add form). */
export const PROVIDER_PRESETS: ChatProviderPreset[] = [
  { name: 'Xiaomi MiMo', baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1', apiKeyUrl: 'https://xiaomimimo.com' },
  {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    kind: 'openai-responses',
  },
  { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiKeyUrl: 'https://openrouter.ai/keys' },
  { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKeyUrl: 'https://platform.deepseek.com/api_keys' },
  { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', apiKeyUrl: 'https://console.groq.com/keys' },
  {
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    kind: 'anthropic',
  },
  { name: 'Together', baseURL: 'https://api.together.xyz/v1', apiKeyUrl: 'https://api.together.xyz/settings/api-keys' },
  { name: 'Mistral', baseURL: 'https://api.mistral.ai/v1', apiKeyUrl: 'https://console.mistral.ai/api-keys' },
]

function normalizeBaseURL(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** Lists ONLY user-persisted BYOK providers. */
function listUserProviders(): ChatProvider[] {
  migrateProviderKinds()
  const raw = getAppSetting(PROVIDERS_KEY)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter(
        (p) =>
          p &&
          typeof p.id === 'string' &&
          typeof p.name === 'string' &&
          typeof p.baseURL === 'string' &&
          !isManagedProvider(p.id)
      )
      .map((p) => ({
        id: p.id,
        name: p.name,
        baseURL: p.baseURL,
        ...(isKnownKind(p.kind) ? { kind: p.kind } : {}),
      }))
  } catch {
    return []
  }
}

/** User-configured BYOK providers (legacy contract preserved). */
export function listProviders(): ChatProvider[] {
  return listUserProviders()
}

/** Displayed/selectable chat catalog: official providers (one entry per ACCOUNT) + BYOK providers. */
export function listAvailableChatProviders(): ChatProvider[] {
  const accounts = listSubscriptionAccounts()
  const withAccounts = (base: ChatProvider): ChatProvider[] => [
    base,
    ...accounts.filter((a) => a.kind === base.builtin).map(providerForSubscriptionAccount),
  ]
  return [
    ...withAccounts(CODEX_SUBSCRIPTION_PROVIDER),
    ...withAccounts(GITHUB_COPILOT_SUBSCRIPTION_PROVIDER),
    ...withAccounts(CLAUDE_SUBSCRIPTION_PROVIDER),
    ...withAccounts(GROK_SUBSCRIPTION_PROVIDER),
    ...listUserProviders(),
  ]
}

function saveProviders(list: ChatProvider[]): void {
  // Defense in depth: virtual providers must never leak into `chat.providers`.
  setAppSetting(PROVIDERS_KEY, JSON.stringify(list.filter((p) => !isManagedProvider(p.id))))
}

export function getProvider(id: string): ChatProvider | undefined {
  if (isSubscriptionProvider(id)) return getSubscriptionProvider(id)
  return listUserProviders().find((p) => p.id === id)
}

/**
 * EFFECTIVE provider API format: official OpenAI host always uses Responses API; elsewhere,
 * explicit `kind` or host default wins. Gateways remain configurable without letting
 * a conflicting legacy value route api.openai.com through another transport.
 */
export function getProviderKind(provider: ChatProvider | undefined): ChatProviderKind {
  if (!provider) return 'openai'
  return effectiveProviderKind(provider.baseURL, provider.kind)
}

/** Does the provider resolve to NATIVE Anthropic API (@ai-sdk/anthropic)? Used by provider/models/runner. */
export function isAnthropicProvider(providerId: string): boolean {
  return getProviderKind(getProvider(providerId)) === 'anthropic'
}

/** Does the provider resolve to OpenAI Responses API (@ai-sdk/openai, /v1/responses)? Used by provider/runner. */
export function isOpenAIResponsesProvider(providerId: string): boolean {
  return getProviderKind(getProvider(providerId)) === 'openai-responses'
}

/** Adds a provider (stable generated ID). Optional `kind` (absent = host-derived). Throws if invalid. */
export function addProvider(input: { name: string; baseURL: string; kind?: ChatProviderKind }): ChatProvider {
  const name = input.name?.trim()
  const baseURL = normalizeBaseURL(input.baseURL ?? '')
  if (!name) throw new Error('Enter a provider name.')
  if (!/^https?:\/\//i.test(baseURL))
    throw new Error('Enter a valid HTTP(S) baseURL (for example, https://api.example.com/v1).')
  if (isChatSubscriptionProviderKind(input.kind)) {
    throw new Error('This format is reserved for a built-in app provider.')
  }
  const provider: ChatProvider = {
    id: 'prov_' + randomUUID(),
    name,
    baseURL,
    ...(input.kind ? { kind: input.kind } : {}),
  }
  saveProviders([...listUserProviders(), provider])
  return provider
}

/** Updates provider name/baseURL/kind. */
export function updateProvider(id: string, patch: { name?: string; baseURL?: string; kind?: ChatProviderKind }): void {
  if (isManagedProvider(id)) return
  const list = listUserProviders()
  const idx = list.findIndex((p) => p.id === id)
  if (idx < 0) return
  const next = { ...list[idx] }
  if (patch.name != null) next.name = patch.name.trim() || next.name
  if (patch.baseURL != null) next.baseURL = normalizeBaseURL(patch.baseURL) || next.baseURL
  if (patch.kind != null && !isChatSubscriptionProviderKind(patch.kind)) next.kind = patch.kind
  list[idx] = next
  saveProviders(list)
}

/** Removes a provider from the list (service clears key + default). */
export function removeProvider(id: string): void {
  if (isManagedProvider(id)) return
  saveProviders(listUserProviders().filter((p) => p.id !== id))
}
