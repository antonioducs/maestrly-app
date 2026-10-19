import { MobileBridgeError, type MobilePlan } from '@maestrly/bot-fleet-protocol'
import { useCallback, useSyncExternalStore } from 'react'
import { draftFor, type PlanDraft, setDraft, subscribeDrafts } from '../../chats/plan-review'
import type { MessageKey, Translate } from '../../i18n/translate'
import { shownError } from '../conversation/CueCard'

/** The person's draft on a chat's plan, shared by its card and its sheet. */
export function usePlanDraft(key: string, plan: MobilePlan): [PlanDraft, (draft: PlanDraft) => void] {
  const draft = useSyncExternalStore(subscribeDrafts, () => draftFor(key, plan))
  const update = useCallback((next: PlanDraft) => setDraft(key, plan, next), [key, plan])
  return [draft, update]
}

const ERRORS: Record<string, MessageKey> = {
  'review-active': 'plan.error.review',
  'plan-decision-stale': 'plan.error.stale',
  'plan-decision-in-progress': 'plan.error.busy',
  'project-required': 'plan.error.workspace',
  // A host that predates a decision's arguments refuses them, or the channel that offers them.
  invalid: 'plan.error.outdated',
  'unknown-channel': 'plan.error.outdated',
}

/** Why a decision did not go through, in words; the host's own reason when the app has none for it. */
export function planErrorText(cause: unknown, t: Translate): string {
  const key = cause instanceof MobileBridgeError ? ERRORS[cause.code] : undefined
  return key ? t(key) : shownError(cause, t('outbox.error.generic'))
}
