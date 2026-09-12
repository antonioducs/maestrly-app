import {
  DEFAULT_REASONING_EFFORTS,
  MAESTRLY_ULTRA_EFFORT,
  isMaestrlyUltraEffort,
  resolveUltraEffort,
  type ChatModelMeta,
} from './chat'
import type { SubagentProfileCandidate, SubagentProfileDiagnostic } from './subagent-profiles'

export interface SubagentProfileModelMetaResult {
  status: 'available' | 'unavailable'
  meta: ChatModelMeta | null
}

export interface SubagentProfileEffortValidation {
  sentEffort: string | null
  diagnostics: SubagentProfileDiagnostic[]
  valid: boolean
}

export interface SubagentProfileFastModeValidation {
  diagnostics: SubagentProfileDiagnostic[]
  valid: boolean
}

export function isRealSubagentProfileEffort(effort: string): boolean {
  const normalized = effort.trim().toLowerCase()
  return normalized.length > 0 && normalized !== 'off' && normalized !== MAESTRLY_ULTRA_EFFORT
}

function diagnostic(
  code: SubagentProfileDiagnostic['code'],
  message: string,
  severity: SubagentProfileDiagnostic['severity'] = 'warning'
): SubagentProfileDiagnostic {
  return { code, message, severity }
}

/** Shared Fast capability validation for profile editing, save-time inspection, and execution. */
export function validateSubagentProfileFastMode(
  candidate: SubagentProfileCandidate,
  metadata: SubagentProfileModelMetaResult
): SubagentProfileFastModeValidation {
  if (candidate.fastMode !== true) return { diagnostics: [], valid: true }
  if (metadata.status === 'unavailable' || metadata.meta == null) {
    return {
      valid: true,
      diagnostics: [
        diagnostic(
          'fast-mode-unverified',
          `Fast capability for model “${candidate.modelId}” could not be verified; Fast will still be attempted.`
        ),
      ],
    }
  }
  if (metadata.meta.fastModeCapability === true) return { diagnostics: [], valid: true }
  return {
    valid: false,
    diagnostics: [
      diagnostic('fast-mode-unsupported', `Model “${candidate.modelId}” does not support Fast mode.`, 'error'),
    ],
  }
}

/** Shared effort validation for profile editing, save-time inspection, and execution. */
export function validateSubagentProfileEffort(
  candidate: SubagentProfileCandidate,
  metadata: SubagentProfileModelMetaResult,
  synthesizedEffort = false
): SubagentProfileEffortValidation {
  if (candidate.effort === 'off') return { sentEffort: null, diagnostics: [], valid: true }

  if (metadata.status === 'unavailable' || metadata.meta?.reasoning === undefined) {
    return {
      sentEffort:
        candidate.effort === MAESTRLY_ULTRA_EFFORT
          ? resolveUltraEffort(metadata.meta?.reasoningEfforts ?? [])
          : candidate.effort,
      diagnostics: [
        diagnostic(
          'effort-unverified',
          `Effort “${candidate.effort}” could not be verified and will be sent as configured.`
        ),
      ],
      valid: true,
    }
  }

  if (metadata.meta.reasoning === false) {
    const unsupported = diagnostic(
      'invalid-effort',
      `Model “${candidate.modelId}” does not expose configurable reasoning efforts.`,
      synthesizedEffort ? 'warning' : 'error'
    )
    return { sentEffort: null, diagnostics: [unsupported], valid: synthesizedEffort }
  }

  const validEfforts = metadata.meta.reasoningEfforts?.length
    ? metadata.meta.reasoningEfforts
    : [...DEFAULT_REASONING_EFFORTS]
  const sentEffort = isMaestrlyUltraEffort(candidate.effort, validEfforts)
    ? resolveUltraEffort(validEfforts)
    : candidate.effort
  if (validEfforts.includes(sentEffort)) return { sentEffort, diagnostics: [], valid: true }

  if (synthesizedEffort) {
    return {
      sentEffort: null,
      valid: true,
      diagnostics: [
        diagnostic(
          'invalid-effort',
          `Inherited effort “${candidate.effort}” is not supported by “${candidate.modelId}”; no effort will be sent.`
        ),
      ],
    }
  }

  return {
    sentEffort: null,
    valid: false,
    diagnostics: [
      diagnostic('invalid-effort', `Effort “${candidate.effort}” is not supported by “${candidate.modelId}”.`, 'error'),
    ],
  }
}
