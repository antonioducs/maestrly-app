import type { ChatErrorCode } from '../../../shared/chat'
import { AcpProcessExitedError, AcpRpcError } from '../acp/client'
import { ACP_AUTH_REQUIRED_CODE } from '../acp/protocol'

export class AntigravityAuthRequiredError extends Error {
  constructor(message = 'Google AI sign-in is missing or expired. Sign in again in Settings > Providers.') {
    super(message)
    this.name = 'AntigravityAuthRequiredError'
  }
}

export class AntigravityAccountChangedError extends Error {
  constructor(message = 'The Google AI account changed during this request. Send the message again.') {
    super(message)
    this.name = 'AntigravityAccountChangedError'
  }
}

export class AntigravityModelUnavailableError extends Error {
  constructor(modelId: string) {
    super(`The Google AI model "${modelId}" is not available for this account. Choose another model.`)
    this.name = 'AntigravityModelUnavailableError'
  }
}

export class AntigravityToolsUnavailableError extends Error {
  constructor(
    message = "Google Antigravity could not connect to Maestrly's tools. Send the message again; if it keeps failing, restart Maestrly."
  ) {
    super(message)
    this.name = 'AntigravityToolsUnavailableError'
  }
}

export class AntigravityRuntimeStoppedError extends Error {
  constructor(message = 'The Google Antigravity ACP server stopped unexpectedly. Send the message again.') {
    super(message)
    this.name = 'AntigravityRuntimeStoppedError'
  }
}

const QUOTA_PATTERN = /RESOURCE_EXHAUSTED|quota|rate.?limit|usage limit/i
const QUOTA_MESSAGE =
  'Google AI usage limit reached for this model. Wait for the limit to reset or choose another model.'

/** OAuth access/refresh tokens and client secrets must never reach chat transcripts or logs. */
export function redactAntigravityCredentials(text: string): string {
  return text
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/1\/\/[A-Za-z0-9._-]{10,}/g, '[redacted]')
    .replace(/GOCSPX-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/("?(?:refresh_token|access_token|client_secret|id_token)"?\s*[:=]\s*)"?[^",\s}]+"?/gi, '$1[redacted]')
}

export function isAntigravityAuthRequired(error: unknown): boolean {
  return (
    error instanceof AntigravityAuthRequiredError ||
    (error instanceof AcpRpcError && error.code === ACP_AUTH_REQUIRED_CODE)
  )
}

export function isAntigravityQuotaError(error: unknown): boolean {
  return error instanceof Error && QUOTA_PATTERN.test(error.message)
}

export function antigravityErrorMessage(error: unknown): { message: string; code?: ChatErrorCode } {
  if (isAntigravityAuthRequired(error)) return { message: new AntigravityAuthRequiredError().message }
  if (error instanceof AcpProcessExitedError) return { message: new AntigravityRuntimeStoppedError().message }
  if (isAntigravityQuotaError(error)) return { message: QUOTA_MESSAGE }
  if (error instanceof Error && error.message.trim()) return { message: redactAntigravityCredentials(error.message) }
  if (typeof error === 'string' && error.trim()) return { message: redactAntigravityCredentials(error) }
  return { message: 'Google Antigravity failed unexpectedly.' }
}
