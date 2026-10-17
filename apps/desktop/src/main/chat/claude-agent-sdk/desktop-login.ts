import { fleetLoginUrlAllowed } from '@maestrly/bot-fleet-protocol'
import { CLAUDE_LOGIN_CODE_MAX_LENGTH } from '../../../shared/chat'
import type { ClaudeSubscriptionLoginResult, ClaudeSubscriptionManager } from './manager'

/** A Claude sign-in started from the settings of this computer. */
export interface ClaudeDesktopLogin {
  /** The page to open in the browser; its loopback redirect completes the sign-in. Null when Claude Code opens it. */
  readonly authUrl: string | null
  /** The page that shows a code to paste, for when no browser opens or its redirect cannot reach Claude Code. */
  readonly manualUrl: string | null
  /** Forwards a pasted code to Claude Code; false when the code is malformed or this sign-in takes none. */
  submitCode(code: string): boolean
  readonly done: Promise<ClaudeSubscriptionLoginResult>
}

/** The pasted code as Claude Code reads it, or null when it is not a single line of printable ASCII. */
export function normalizeClaudeLoginCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim()
  // The code is written to Claude Code's stdin: a line break inside it would answer a prompt of its own.
  return code.length > 0 && code.length <= CLAUDE_LOGIN_CODE_MAX_LENGTH && /^[\x21-\x7e]+$/.test(code) ? code : null
}

/**
 * Starts the sign-in. On macOS and Linux Claude Code hands its URLs to Maestrly, which opens the browser itself and
 * offers the paste-a-code page: without a desktop session in its environment, Claude Code cannot open one and waits
 * forever. The capture relies on a POSIX `BROWSER` script, so Windows keeps Claude Code's own browser launch, which
 * does not depend on any session variable there.
 */
export async function startClaudeDesktopLogin(
  manager: Pick<ClaudeSubscriptionManager, 'login' | 'startInteractiveLogin'>,
  platform: NodeJS.Platform = process.platform
): Promise<ClaudeDesktopLogin> {
  if (platform === 'win32') {
    return { authUrl: null, manualUrl: null, submitCode: () => false, done: manager.login() }
  }
  const login = await manager.startInteractiveLogin()
  const authUrl = fleetLoginUrlAllowed('claude', login.autoUrl) ? login.autoUrl : null
  const manualUrl = fleetLoginUrlAllowed('claude', login.manualUrl) ? login.manualUrl : null
  if (!authUrl && !manualUrl) {
    login.cancel()
    await login.done.catch(() => undefined)
    throw new Error('Claude Code returned an unexpected sign-in address.')
  }
  return {
    authUrl,
    manualUrl,
    submitCode: (value) => {
      const code = normalizeClaudeLoginCode(value)
      if (!code || !manualUrl) return false
      login.submitCode(code)
      return true
    },
    done: login.done,
  }
}
