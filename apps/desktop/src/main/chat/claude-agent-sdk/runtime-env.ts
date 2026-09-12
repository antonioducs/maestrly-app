const CLAUDE_RUNTIME_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'TERM',
  'COLORTERM',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CODE_GIT_BASH_PATH',
] as const

export const CLAUDE_SUBSCRIPTION_RUNTIME_FLAGS = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
  CLAUDE_AGENT_SDK_CLIENT_APP: 'maestrly/0.0.1',
} as const

/**
 * The Agent SDK replaces the subprocess environment when `env` is supplied.
 * Build it from a small operational allowlist so ambient provider credentials
 * and endpoints cannot silently switch a Claude subscription to API billing.
 */
export function claudeSubscriptionRuntimeEnvironment(
  configDirectory: string,
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of CLAUDE_RUNTIME_ENV_ALLOWLIST) {
    const value = source[name]
    if (typeof value === 'string' && value) environment[name] = value
  }
  return {
    ...environment,
    ...CLAUDE_SUBSCRIPTION_RUNTIME_FLAGS,
    CLAUDE_CONFIG_DIR: configDirectory,
  }
}
