/**
 * Removes credentials that may be echoed by the official Copilot runtime, OAuth endpoints or the SDK.
 * Keep this function at the provider boundary so no runtime error reaches persistence/UI unsanitized.
 */
export function redactGitHubCopilotErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[opsur]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|device_code|token|code)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b((?:COPILOT_SDK_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)=)[^\s,;]+/gi, '$1[REDACTED]')
}

/** Converts unknown runtime failures to a safe user/persistence-facing string. */
export function githubCopilotErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  return redactGitHubCopilotErrorMessage(message)
}
