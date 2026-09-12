import { chatDiag } from '../diag-log'

/** Diagnostic line for subscription failover — never include email/token. */
export function failoverDiag(kind: string, fields: Record<string, unknown>): void {
  chatDiag({ kind: `subscription-failover:${kind}`, ...fields })
}
