/**
 * FINAL Maestrly Chat turn status derived from stream signals. PURE module (no store/Electron)
 * for testability — centralized after a regression classified cut streams as 'ready'.
 *
 * Rules:
 *  - abort (user stopped) → 'idle' (NOT 'ready').
 *  - Error OR mid-stream cut (finishReason 'interrupted', continuation exhausted) → 'error':
 *    red + sound so callers do not mistake incomplete work for a ready result.
 *  - Normal case → 'ready'.
 */
export type TurnStatus = 'idle' | 'error' | 'ready'

export interface TurnSignals {
  /** The user aborted the turn (controller.signal.aborted). */
  aborted: boolean
  /** The stream emitted an 'error' event (provider/tool failure). */
  hadError: boolean
  /** The stream was cut and transparent continuation exhausted (finishReason 'interrupted'). */
  interrupted: boolean
}

export interface TurnCompletion {
  status: TurnStatus
  /** The dedicated plan alert already played; still transition to ready, without the generic sound. */
  silentReady: boolean
}

export function finalTurnStatus({ aborted, hadError, interrupted }: TurnSignals): TurnStatus {
  if (aborted) return 'idle'
  if (hadError || interrupted) return 'error'
  return 'ready'
}

export function finalTurnCompletion(signals: TurnSignals & { planSubmitted: boolean }): TurnCompletion {
  const status = finalTurnStatus(signals)
  return { status, silentReady: status === 'ready' && signals.planSubmitted }
}
