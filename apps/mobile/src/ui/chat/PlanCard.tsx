import type { MobilePlan } from '@maestrly/bot-fleet-protocol'
import { useState } from 'react'
import { AccessibilityInfo, Pressable, TextInput, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { AssistantMarkdown } from '../conversation/AssistantMarkdown'
import { CardError, CueCard, shownError, useConversation } from '../conversation/CueCard'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'

const LONG = 900

/** A plan the agent wrote in Plan mode: approve it to build it, ask for changes, or discard it. */
export function PlanCard({
  plan,
  onDecide,
}: {
  plan: MobilePlan
  onDecide: (action: 'approve' | 'revise' | 'discard', feedback?: string) => Promise<unknown>
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { online, focusComposer } = useConversation()
  const [expanded, setExpanded] = useState(plan.text.length <= LONG)
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function decide(action: 'approve' | 'revise' | 'discard') {
    setBusy(action)
    setError(null)
    try {
      await onDecide(action, action === 'revise' ? feedback.trim() || undefined : undefined)
      AccessibilityInfo.announceForAccessibility(t(`plan.announce.${action}`))
      if (action !== 'approve') focusComposer()
    } catch (cause) {
      setError(shownError(cause, t('outbox.error.generic')))
    } finally {
      setBusy(null)
    }
  }

  return (
    <CueCard>
      <AppText accessibilityRole="header" style={{ fontSize: 17, lineHeight: 22, fontWeight: '600', marginBottom: 8 }}>
        {plan.title || t('plan.title')}
      </AppText>
      <View style={{ maxHeight: expanded ? undefined : 220, overflow: 'hidden' }}>
        <AssistantMarkdown text={plan.text} streaming={false} />
      </View>
      {plan.text.length > LONG ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded((value) => !value)}
          hitSlop={8}
          style={{ paddingVertical: 8 }}
        >
          <AppText style={{ fontFamily: fonts.bodySemi, fontSize: 14, color: palette.cueInk }}>
            {expanded ? t('plan.collapse') : t('plan.expand')}
          </AppText>
        </Pressable>
      ) : null}
      {revising ? (
        <View style={{ marginTop: 10, gap: 8 }}>
          <TextInput
            value={feedback}
            onChangeText={setFeedback}
            multiline
            autoFocus
            maxLength={10_000}
            placeholder={t('plan.feedback')}
            placeholderTextColor={palette.faint}
            accessibilityLabel={t('plan.feedback')}
            style={{
              minHeight: 72,
              maxHeight: 160,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: palette.line,
              backgroundColor: palette.raised,
              color: palette.ink,
              fontFamily: fonts.body,
              fontSize: 15,
              textAlignVertical: 'top',
            }}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              label={t('plan.sendFeedback')}
              style={{ flex: 1 }}
              busy={busy === 'revise'}
              disabled={!online || busy !== null}
              onPress={() => void decide('revise')}
            />
            <Button
              label={t('common.cancel')}
              variant="ghost"
              disabled={busy !== null}
              onPress={() => setRevising(false)}
            />
          </View>
        </View>
      ) : (
        <View style={{ marginTop: 10 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              label={t('plan.approve')}
              style={{ flex: 1 }}
              busy={busy === 'approve'}
              disabled={!online || busy !== null}
              onPress={() => void decide('approve')}
            />
            <Button
              label={t('plan.revise')}
              variant="secondary"
              style={{ flex: 1 }}
              disabled={!online || busy !== null}
              onPress={() => setRevising(true)}
            />
          </View>
          <Button
            label={t('plan.discard')}
            variant="ghost"
            busy={busy === 'discard'}
            disabled={!online || busy !== null}
            onPress={() => void decide('discard')}
            style={{ marginTop: 4 }}
          />
        </View>
      )}
      <CardError text={error} />
    </CueCard>
  )
}
