import { FLEET_NOTE_MAX, type FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { useState } from 'react'
import { TextInput } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { CardError, CueCard, ResolvedLine, useConversation, useResolver } from './CueCard'

export function HelpCard({ item }: { item: Extract<FleetTranscriptItem, { kind: 'help' }> }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { name } = useConversation()
  const { busy, error, run, disabled } = useResolver(item)
  const [note, setNote] = useState('')

  if (item.state === 'resolved')
    return (
      <ResolvedLine
        icon="check"
        tone="ok"
        text={item.note ? t('help.resolvedNote', { note: item.note }) : t('help.resolved')}
      />
    )
  return (
    <CueCard>
      <AppText accessibilityRole="header" style={{ fontSize: 17, lineHeight: 22, fontWeight: '600', marginBottom: 6 }}>
        {t('help.title', { name })}
      </AppText>
      <AppText style={{ fontSize: 15, lineHeight: 21, marginBottom: 12 }}>{item.reason}</AppText>
      <TextInput
        value={note}
        onChangeText={setNote}
        editable={!disabled}
        multiline
        maxLength={FLEET_NOTE_MAX}
        placeholder={t('help.note')}
        placeholderTextColor={palette.faint}
        accessibilityLabel={t('help.note')}
        style={{
          minHeight: 70,
          marginBottom: 10,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderWidth: 1,
          borderRadius: 12,
          borderColor: palette.line,
          backgroundColor: palette.raised,
          color: palette.ink,
          fontFamily: fonts.body,
          fontSize: 15,
          textAlignVertical: 'top',
        }}
      />
      <Button
        label={t('help.resolve')}
        disabled={disabled}
        busy={busy}
        onPress={() => void run({ kind: 'help', note: note.trim() || null }, t('announce.resolved'))}
      />
      <CardError text={error} />
    </CueCard>
  )
}
