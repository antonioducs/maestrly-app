/**
 * Sanitizes credentials that may appear in xAI OAuth / API error strings before they reach
 * persistence, IPC, or the renderer.
 */
export function redactGrokErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|id_token|device_code|code|code_verifier|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(
      /\b((?:access_token|refresh_token|id_token|device_code|code_verifier)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]'
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
}

/** Converts unknown runtime failures to a safe user/persistence-facing string. */
export function grokSubscriptionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  return redactGrokErrorMessage(message)
}
