import type { MobilePlan } from '@maestrly/bot-fleet-protocol'
import { useMemo, useState } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import {
  clearDraft,
  draftComments,
  draftEdited,
  planDecision,
  type PlanDecisionArgs,
  planExcerpt,
  planOutline,
} from '../../chats/plan-review'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { CardError, CueCard, useConversation } from '../conversation/CueCard'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { planErrorText, usePlanDraft } from './usePlanDraft'

const SHOWN_STEPS = 4

export function PlanBadge({ label, tone }: { label: string; tone: 'brass' | 'moss' }) {
  const { palette } = useTheme()
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: tone === 'brass' ? palette.brassSoft : palette.surface,
      }}
    >
      <AppText variant="small" style={{ fontFamily: fonts.bodySemi, color: palette[tone] }}>
        {label}
      </AppText>
    </View>
  )
}

/**
 * A plan the agent wrote in Plan mode, as the chat shows it: its steps at a glance, never the whole plan. The plan
 * opens in its own sheet to read, comment on and decide; a plan that needs nothing more can be approved from here.
 */
export function PlanCard({
  plan,
  draftKey,
  onOpen,
  onDecide,
}: {
  plan: MobilePlan
  draftKey: string
  onOpen: () => void
  onDecide: (decision: PlanDecisionArgs) => Promise<unknown>
}) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const { online } = useConversation()
  const [draft] = usePlanDraft(draftKey, plan)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const steps = useMemo(() => planOutline(plan.text), [plan.text])
  const excerpt = useMemo(() => (steps.length ? '' : planExcerpt(plan.text)), [plan.text, steps.length])
  const comments = draftComments(draft).length
  const edited = draftEdited(plan, draft)

  async function approve() {
    setBusy(true)
    setError(null)
    try {
      // An edit made in the sheet goes with the approval; only hosts that take edits let the sheet make one.
      await onDecide(planDecision(plan, draft, 'approve', { full: edited }))
      clearDraft(draftKey)
      AccessibilityInfo.announceForAccessibility(t('plan.announce.approve'))
    } catch (cause) {
      setError(planErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <CueCard>
      <AppText accessibilityRole="header" style={{ fontSize: 17, lineHeight: 22, fontFamily: fonts.bodySemi }}>
        {plan.title || t('plan.title')}
      </AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <AppText variant="small" tone="muted">
          {[
            plan.version > 1 ? t('plan.version', { version: plan.version }) : null,
            steps.length ? plural('plan.steps', steps.length) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </AppText>
        {comments ? <PlanBadge tone="brass" label={plural('plan.comments', comments)} /> : null}
        {edited ? <PlanBadge tone="moss" label={t('plan.edited')} /> : null}
      </View>
      {steps.length ? (
        <View style={{ marginTop: 10, gap: 6 }}>
          {steps.slice(0, SHOWN_STEPS).map((step, index) => (
            <View key={`${index}:${step}`} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
              <View
                style={{
                  minWidth: 20,
                  height: 20,
                  marginTop: 1,
                  paddingHorizontal: 4,
                  borderRadius: 6,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: palette.raised,
                  borderWidth: 1,
                  borderColor: palette.line,
                }}
              >
                <AppText style={{ fontFamily: fonts.mono, fontSize: 11, lineHeight: 14, color: palette.brass }}>
                  {index + 1}
                </AppText>
              </View>
              <AppText numberOfLines={2} style={{ flex: 1, fontSize: 15, lineHeight: 21 }}>
                {step}
              </AppText>
            </View>
          ))}
          {steps.length > SHOWN_STEPS ? (
            <AppText variant="small" tone="muted" style={{ marginLeft: 29 }}>
              {plural('plan.moreSteps', steps.length - SHOWN_STEPS)}
            </AppText>
          ) : null}
        </View>
      ) : excerpt ? (
        <AppText numberOfLines={3} tone="muted" style={{ marginTop: 8, fontSize: 15, lineHeight: 21 }}>
          {excerpt}
        </AppText>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <Button label={t('plan.open')} icon="clipboard" style={{ flex: 1.4 }} onPress={onOpen} />
        <Button
          label={t('plan.approveShort')}
          accessibilityLabel={t('plan.approve')}
          variant="secondary"
          style={{ flex: 1 }}
          busy={busy}
          disabled={!online || busy}
          onPress={() => void approve()}
        />
      </View>
      <CardError text={error} />
    </CueCard>
  )
}
