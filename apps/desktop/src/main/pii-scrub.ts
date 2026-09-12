/**
 * Pure recursive PII redaction without Electron/store dependencies. Explicit paths/secrets make it
 * testable in Node. Redact absolute private paths, known literal secrets, and token patterns such as
 * Bearer, API keys, query parameters, or environment assignments. This provides additional protection
 * for structured diagnostic objects.
 */

/** Absolute path to redact and its replacement placeholder, such as the home directory. */
export interface PathRedaction {
  value: string
  placeholder: string
}

export interface ScrubOptions {
  /**
   * Private absolute paths mapped to placeholders: home, userData, appData, dumps, app root, and
   * conversation directories.
   */
  paths: PathRedaction[]
  /** segredos literais conhecidos (valores reais de env/token) → '***'. */
  secrets?: string[]
}

/** Mask token patterns without needing their literal values. */
export function redactTokens(s: string): string {
  return (
    s
      // Preserve HTTP(S) host/path while redacting userinfo credentials.
      .replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1***@')
      // Authorization: Bearer <token>
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
      // Query-string tokens, including VS Code tkn, access_token, and api_key.
      .replace(
        /([?&](?:token|tkn|access_token|api_key|key|auth|authorization|session|secret|password|pwd)=)[^&#\s"']+/gi,
        '$1***'
      )
      // chaves estilo sk-... (Anthropic sk-ant-…, OpenAI sk-…)
      .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, 'sk-***')
      // Sensitive environment/config assignments preserve the key while masking its value.
      .replace(/\b(ANTHROPIC_API_KEY|OPENAI_API_KEY)\b(["']?\s*[:=]\s*["']?)([^\s"',}]+)/g, '$1$2***')
      // Redact generic configuration token fields without needing to know their literal values.
      .replace(/\b(token)(["']?\s*[:=]\s*["']?)([A-Za-z0-9._-]{8,})/gi, '$1$2***')
  )
}

/** Build a redaction function, matching longer paths and secrets first. */
export function buildRedactor({ paths, secrets = [] }: ScrubOptions): (s: string) => string {
  // Redact specific nested paths before broader home-directory prefixes.
  const sortedPaths = paths.filter((p) => p.value).sort((a, b) => b.value.length - a.value.length)
  const sortedSecrets = secrets.filter((s) => s && s.length >= 8).sort((a, b) => b.length - a.length)
  return (input: string): string => {
    let out = input
    for (const { value, placeholder } of sortedPaths) out = out.split(value).join(placeholder)
    for (const secret of sortedSecrets) out = out.split(secret).join('***')
    return redactTokens(out)
  }
}

/** Recursively redact every string value while preserving object keys. */
export function deepRedact(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, redact))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepRedact(v, redact)
    return out
  }
  return value
}

/**
 * Pure generic object redaction using supplied paths/secrets. Recursive traversal covers nested
 * messages, exceptions, breadcrumbs, URLs, contexts, tags, and filenames without maintaining a fragile
 * field list.
 */
export function scrubEvent<T>(event: T, opts: ScrubOptions): T {
  const redact = buildRedactor(opts)
  return deepRedact(event, redact) as T
}
