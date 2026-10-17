import type { RemoteOs } from '../../../../shared/remote-bridge'
import type { ChatSubscriptionAuthStatus } from '../../../../shared/chat'

/** Anthropic's setup guide: every install method, per system. */
export const CLAUDE_CODE_SETUP_DOCS_URL = 'https://code.claude.com/docs/en/setup'

export type ClaudeCodeSetupNeed = 'install' | 'update'

/** What the Claude subscription needs before it can sign in, if the host's Claude Code is missing or too old. */
export function claudeCodeSetupNeed(status: ChatSubscriptionAuthStatus | null): ClaudeCodeSetupNeed | null {
  if (status?.state !== 'unavailable') return null
  if (status.errorCode === 'claude-code-not-installed') return 'install'
  if (status.errorCode === 'claude-code-incompatible') return 'update'
  return null
}

/** The official command for the host's system, as the setup guide gives it; updating uses Claude Code itself. */
export function claudeCodeSetupCommand(need: ClaudeCodeSetupNeed, os: RemoteOs): string {
  if (need === 'update') return 'claude update'
  return os === 'win' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash'
}
