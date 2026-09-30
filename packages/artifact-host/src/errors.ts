export const ARTIFACT_ERROR_CODES = [
  'invalid_input',
  'invalid_path',
  'unsupported_type',
  'duplicate_path',
  'too_many_files',
  'file_too_large',
  'bundle_too_large',
  'missing_entry',
  'entry_not_html',
  'edit_not_found',
  'edit_ambiguous',
  'edit_binary',
  'not_found',
  'version_conflict',
  'version_limit',
  'quota_exceeded',
  'limit_reached',
  'port_in_use',
  'storage',
  'host_unavailable',
  'internal',
] as const

export type ArtifactErrorCode = (typeof ARTIFACT_ERROR_CODES)[number]
export type ArtifactErrorDetails = Record<string, string | number | boolean>

export interface SerializedArtifactError {
  code: ArtifactErrorCode
  message: string
  details?: ArtifactErrorDetails
}

export class ArtifactHostError extends Error {
  constructor(
    readonly code: ArtifactErrorCode,
    message: string,
    readonly details?: ArtifactErrorDetails
  ) {
    super(message)
    this.name = 'ArtifactHostError'
  }

  toJSON(): SerializedArtifactError {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) }
  }

  /** Rebuild an error that crossed a process boundary; anything malformed becomes `internal`. */
  static from(value: unknown): ArtifactHostError {
    const v = value as Partial<SerializedArtifactError> | null
    if (v && typeof v.message === 'string' && (ARTIFACT_ERROR_CODES as readonly string[]).includes(v.code as string))
      return new ArtifactHostError(v.code as ArtifactErrorCode, v.message, sanitizeDetails(v.details))
    return new ArtifactHostError('internal', 'Internal artifact host error')
  }
}

function sanitizeDetails(details: unknown): ArtifactErrorDetails | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const clean: ArtifactErrorDetails = {}
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') clean[key] = value
  }
  return clean
}
