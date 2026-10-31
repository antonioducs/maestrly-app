/**
 * Context-window overflow detection across providers, and the limit a provider reveals in its error text.
 * Throttling that mentions tokens ("too many tokens, please wait", tokens-per-minute 429s) is not an overflow:
 * compacting would not help, waiting does.
 */

const OVERFLOW_PATTERNS: readonly RegExp[] = [
  // Anthropic
  /\bprompt is too long\b/i,
  /\binput is too long for (?:the )?(?:requested|selected)? ?model\b/i,
  // OpenAI and compatible gateways
  /\bmaximum context length\b/i,
  /\bcontext[_ ]length[_ ]exceeded\b/i,
  /\bexceeds? (?:the |this )?(?:model'?s? )?(?:maximum )?context(?: window| length| size)\b/i,
  /\bexceeded (?:this )?model(?:'s)? context window\b/i,
  /\breduce the length of the messages\b/i,
  /\bmaximum prompt length\b/i,
  // Gemini / Vertex
  /\binput token count\b[^\n]{0,80}\bexceeds the maximum\b/i,
  // Bedrock
  /\b(?:number of )?input tokens? exceeds? (?:the )?maximum\b/i,
  /\binput is too long\b/i,
  // llama.cpp, Ollama, LM Studio
  /\bexceeds the available context size\b/i,
  /\bgreater than the context length\b/i,
  /\blonger than the model'?s context length\b/i,
  /\bprompt has \d+ tokens?, but the configured context size\b/i,
  /\bcontext length is only \d+\b/i,
  /\bcontext (?:size|window) (?:has been )?exceeded\b/i,
  // vLLM
  /\bmax_model_len\b/i,
  /\bmaximum model length\b/i,
  // Hugging Face TGI
  /\binputs`? tokens \+ `?max_new_tokens`? must be <=/i,
  // LiteLLM and others
  /\bcontext window exceeded\b/i,
  /\bmodel_context_window_exceeded\b/i,
  /\bexceeded model token limit\b/i,
  /\btoken limit exceeded\b/i,
  /\btoo many tokens\b/i,
  /\brequested input length \d+ exceeds\b/i,
]

const THROTTLE_EXCLUSIONS: readonly RegExp[] = [
  /\bthrottl/i,
  /\brate[_ -]?limit/i,
  /\btoo many requests\b/i,
  /\bplease wait\b/i,
  /\btokens? per (?:minute|min|day|hour)\b/i,
  /\b(?:TPM|TPD|RPM)\b/,
  // Cohere output cap: compaction cannot fix it.
  /\bmax_tokens must be less than\b/i,
]

const PAYLOAD_PATTERNS: readonly RegExp[] = [
  /\brequest entity too large\b/i,
  /\bpayload too large\b/i,
  /\brequest_too_large\b/i,
  /\brequest too large\b/i,
]

export function isContextOverflowText(text: string, status?: number | null): boolean {
  if (!text) return false
  if (status === 429) return false
  if (THROTTLE_EXCLUSIONS.some((pattern) => pattern.test(text))) return false
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))
}

export function isPayloadTooLargeText(text: string, status?: number | null): boolean {
  return status === 413 || PAYLOAD_PATTERNS.some((pattern) => pattern.test(text))
}

const NUMBER = '(\\d[\\d,_]*\\d|\\d)'
const MIN_WINDOW = 1_024
const MAX_WINDOW = 10_000_000

const LIMIT_PATTERNS: readonly RegExp[] = [
  new RegExp(`maximum context length (?:is|of)?\\s*\\(?${NUMBER}`, 'i'),
  new RegExp(`context (?:length|size|window)(?: limit)? (?:is |of )?(?:only )?\\(?${NUMBER}`, 'i'),
  new RegExp(`configured context size (?:is )?${NUMBER}`, 'i'),
  new RegExp(`max_model_len\\W{0,6}${NUMBER}`, 'i'),
  new RegExp(`maximum model length (?:is )?${NUMBER}`, 'i'),
  new RegExp(`maximum (?:number of tokens allowed|input length|prompt length)(?: is| of)?\\s*\\(?${NUMBER}`, 'i'),
  new RegExp(`${NUMBER}\\s*(?:tokens?\\s*)?maximum\\b`, 'i'),
  new RegExp(`supports? up to ${NUMBER}`, 'i'),
  new RegExp(`must be <=\\s*${NUMBER}`, 'i'),
  new RegExp(`limit of ${NUMBER}\\s*tokens`, 'i'),
  new RegExp(`"n_ctx"\\s*:\\s*${NUMBER}`, 'i'),
]

const OBSERVED_PATTERNS: readonly RegExp[] = [
  new RegExp(`resulted in ${NUMBER} tokens`, 'i'),
  new RegExp(`${NUMBER} tokens?\\s*>\\s*\\d`, 'i'),
  new RegExp(`you requested ${NUMBER} tokens`, 'i'),
  new RegExp(`input token count\\W{0,4}${NUMBER}`, 'i'),
  new RegExp(`prompt has ${NUMBER} tokens`, 'i'),
  new RegExp(`"n_prompt_tokens"\\s*:\\s*${NUMBER}`, 'i'),
  new RegExp(`input \\(${NUMBER} tokens\\)`, 'i'),
  new RegExp(`(?:requested )?input length ${NUMBER} exceeds`, 'i'),
  new RegExp(`request \\(${NUMBER} tokens\\)`, 'i'),
]

function toTokens(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number(raw.replace(/[,_]/g, ''))
  return Number.isInteger(value) && value >= MIN_WINDOW && value <= MAX_WINDOW ? value : undefined
}

function firstMatch(text: string, patterns: readonly RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const value = toTokens(pattern.exec(text)?.[1])
    if (value !== undefined) return value
  }
  return undefined
}

export interface ContextLimitHint {
  /** The context window the provider says the model has. */
  limit?: number
  /** How many tokens the rejected request held, by the provider's count. */
  observed?: number
}

/** Limit and request size a provider names in an overflow error; empty when it names neither. */
export function parseContextLimitFromError(text: string): ContextLimitHint {
  if (!text) return {}
  // A message only about output tokens does not describe the context window.
  if (/\bmax(?:imum)?[_ ]?(?:output|completion)[_ ]?tokens\b/i.test(text) && !/\bcontext\b/i.test(text)) return {}
  const limit = firstMatch(text, LIMIT_PATTERNS)
  const observed = firstMatch(text, OBSERVED_PATTERNS)
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(observed !== undefined && observed !== limit ? { observed } : {}),
  }
}
