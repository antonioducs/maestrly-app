export type CodexRequestId = string | number

export interface CodexClientInfo {
  name: string
  title: string | null
  version: string
}

export interface CodexInitializeCapabilities {
  experimentalApi?: boolean
  requestAttestation?: boolean
  mcpServerOpenaiFormElicitation?: boolean
  optOutNotificationMethods?: readonly string[] | null
}

export interface CodexInitializeParams {
  clientInfo: CodexClientInfo
  capabilities?: CodexInitializeCapabilities | null
}

export interface CodexInitializeResponse {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
  capabilities?: {
    requestUserInputAsync?: boolean
    turnSteer?: boolean
    turnSettingsUpdate?: boolean
    [key: string]: unknown
  } | null
}

export type CodexPlanType =
  | 'free'
  | 'go'
  | 'plus'
  | 'pro'
  | 'prolite'
  | 'team'
  | 'self_serve_business_usage_based'
  | 'business'
  | 'enterprise_cbp_usage_based'
  | 'enterprise'
  | 'edu'
  | 'unknown'

export type CodexAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: CodexPlanType }
  | { type: 'amazonBedrock'; credentialSource: unknown }

export interface CodexAccountReadParams {
  refreshToken?: boolean
}

export interface CodexAccountReadResponse {
  account: CodexAccount | null
  requiresOpenaiAuth: boolean
}

export interface CodexAccountRateLimitWindow {
  usedPercent?: number | null
  windowDurationMins?: number | null
  resetsAt?: number | null // epoch ms if parseable
  [key: string]: unknown
}

export interface CodexAccountRateLimits {
  primary?: CodexAccountRateLimitWindow | null
  secondary?: CodexAccountRateLimitWindow | null
  credits?: unknown
  rateLimitReachedType?: string | null
  limitReached?: boolean | string | null
  [key: string]: unknown
}

/** Response/notification envelope used by the current app-server account/rateLimits/* contract. */
export interface CodexAccountRateLimitsEnvelope {
  rateLimits?: CodexAccountRateLimits | null
  rateLimitsByLimitId?: Readonly<Record<string, CodexAccountRateLimits | null>> | null
  [key: string]: unknown
}

export interface CodexAccountRateLimitsReadParams {
  // empty / future fields ok
  [key: string]: unknown
}

export type CodexAccountRateLimitsReadResponse = CodexAccountRateLimits | CodexAccountRateLimitsEnvelope
export type CodexAccountRateLimitsUpdatedNotification = CodexAccountRateLimits | CodexAccountRateLimitsEnvelope

export type CodexAccountLoginStartParams =
  | { type: 'apiKey'; apiKey: string }
  | {
      type: 'chatgpt'
      codexStreamlinedLogin?: boolean
      useHostedLoginSuccessPage?: boolean
      appBrand?: 'codex' | 'chatgpt' | null
    }
  | { type: 'chatgptDeviceCode' }
  | {
      type: 'chatgptAuthTokens'
      accessToken: string
      chatgptAccountId: string
      chatgptPlanType?: string | null
    }

export type CodexAccountLoginStartResponse =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: 'chatgptDeviceCode'; loginId: string; verificationUrl: string; userCode: string }
  | { type: 'chatgptAuthTokens' }

export interface CodexAccountLoginCompletedNotification {
  loginId: string | null
  success: boolean
  error: string | null
}

export type CodexApprovalPolicy =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | {
      granular: {
        sandbox_approval: boolean
        rules: boolean
        skill_approval: boolean
        request_permissions: boolean
        mcp_elicitations: boolean
      }
    }

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexPersonality = 'none' | 'friendly' | 'pragmatic'
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none'

/** Per-turn v2 policy. Keep the base thread read-only to avoid trusting/loading local project config. */
export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

/** Native runtime preset. Sticky across turns, so the client must also send the reset to `default`. */
export interface CodexCollaborationMode {
  mode: 'plan' | 'default'
  settings: {
    model: string
    reasoning_effort: string | null
    /** `null` requests the app-server's built-in instructions for the selected preset. */
    developer_instructions: string | null
  }
}

export interface CodexThread {
  id: string
  [key: string]: unknown
}

export interface CodexTurn {
  id: string
  [key: string]: unknown
}

export interface CodexThreadStartParams {
  model?: string | null
  modelProvider?: string | null
  serviceTier?: string | null
  cwd?: string | null
  approvalPolicy?: CodexApprovalPolicy | null
  sandbox?: CodexSandboxMode | null
  config?: Readonly<Record<string, unknown>> | null
  serviceName?: string | null
  baseInstructions?: string | null
  developerInstructions?: string | null
  personality?: CodexPersonality | null
  ephemeral?: boolean | null
}

export interface CodexThreadStartResponse {
  thread: CodexThread
  model: string
  modelProvider: string
  serviceTier: string | null
  cwd: string
  [key: string]: unknown
}

export interface CodexThreadResumeParams {
  threadId: string
  model?: string | null
  modelProvider?: string | null
  serviceTier?: string | null
  cwd?: string | null
  approvalPolicy?: CodexApprovalPolicy | null
  sandbox?: CodexSandboxMode | null
  config?: Readonly<Record<string, unknown>> | null
  baseInstructions?: string | null
  developerInstructions?: string | null
  personality?: CodexPersonality | null
}

export type CodexThreadResumeResponse = CodexThreadStartResponse

/** Official hard-delete: removes the thread and descendants; app-server responds with `{}`. */
export interface CodexThreadDeleteParams {
  threadId: string
}

export type CodexThreadDeleteResponse = Record<string, never>

export interface CodexTextElement {
  byteRange: { start: number; end: number }
  placeholder: string | null
}

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: readonly CodexTextElement[] }
  | { type: 'image'; url: string; detail?: 'auto' | 'low' | 'high' | 'original' }
  | { type: 'localImage'; path: string; detail?: 'auto' | 'low' | 'high' | 'original' }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }

export function codexTextInput(text: string): CodexUserInput {
  return { type: 'text', text, text_elements: [] }
}

export interface CodexTurnStartParams {
  threadId: string
  clientUserMessageId?: string | null
  input: readonly CodexUserInput[]
  cwd?: string | null
  approvalPolicy?: CodexApprovalPolicy | null
  sandboxPolicy?: CodexSandboxPolicy | null
  model?: string | null
  serviceTier?: string | null
  effort?: string | null
  summary?: CodexReasoningSummary | null
  personality?: CodexPersonality | null
  outputSchema?: unknown
  collaborationMode?: CodexCollaborationMode | null
}

export interface CodexTurnStartResponse {
  turn: CodexTurn
}

export interface CodexTurnInterruptParams {
  threadId: string
  turnId: string
}

export interface CodexTurnSteerParams {
  threadId: string
  expectedTurnId: string
  input: readonly CodexUserInput[]
  clientUserMessageId: string
}

/** A successful RPC means the input was queued; it does not claim the model has consumed it. */
export interface CodexTurnSteerResponse {
  turnId?: string
  accepted?: boolean
  [key: string]: unknown
}

export interface CodexTurnSettingsUpdateParams {
  threadId: string
  expectedTurnId: string
  model?: string | null
  effort?: string | null
}

export type CodexTurnSettingsUpdateResponse =
  | { applied: true; [key: string]: unknown }
  | { applied: false; targetUnavailable: true; [key: string]: unknown }

export type CodexEmptyResponse = Record<string, never>

export interface CodexNotification<TParams = unknown> {
  method: string
  params: TParams
}

export interface CodexServerRequest<TParams = unknown> {
  id: CodexRequestId
  method: string
  params: TParams
}

export interface CodexRpcErrorBody {
  code: number
  message: string
  data?: unknown
}
