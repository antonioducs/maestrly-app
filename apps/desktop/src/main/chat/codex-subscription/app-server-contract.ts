/**
 * Process contract Maestrly uses to start `codex app-server`. Shared by the subscription manager and the runtime
 * update validator so a candidate Codex release is exercised with exactly the production arguments.
 *
 * Feature gates resolved at process start. Cover ONLY LEGACY multi-agent (v1): for 5.6 models, remote catalog
 * `multi_agent_version` registers `spawn_agent`/`wait_agent` regardless of these flags or per-thread
 * `features.multi_agent*: false`. Do NOT rely on these as a gate; actual suppression comes from
 * `model_catalog_json` in process argv (see model-catalog-override.ts).
 */
export const CODEX_SUBSCRIPTION_APP_SERVER_ARGS = [
  'app-server',
  '--disable',
  'multi_agent',
  '--disable',
  'multi_agent_v2',
] as const

/** This provider is exclusively first-party ChatGPT; host-injected credentials/endpoints are not accepted. */
export const CODEX_SUBSCRIPTION_UNSET_ENV = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_AUTHAPI_BASE_URL',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
  'CODEX_APP_SERVER_LOGIN_ISSUER',
  // The provider database must live alongside isolated CODEX_HOME so logout/wipe are complete.
  'CODEX_SQLITE_HOME',
] as const

/** First-party provider: no inherited key, base URL, or development config may redirect the runtime. */
export const CODEX_SUBSCRIPTION_UNSET_ENV_PREFIXES = ['CODEX_', 'OPENAI_', 'AZURE_OPENAI_'] as const
