import { FLEET_NOTE_MAX, type FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { useState } from 'react'
import { TextInput, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { openBotScreen, useScreenAccess } from '../screen/screen-access'
import { CardError, CueCard, ResolvedLine, useConversation, useResolver } from './CueCard'

/**
 * A bot's request for help. Where the phone can open the bot's screen, that is the way to help: the owner gives the
 * screen back with a note, which resolves the request; marking it resolved without the screen stays one tap away.
 */
export function HelpCard({ item }: { item: Extract<FleetTranscriptItem, { kind: 'help' }> }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { name, bot, online } = useConversation()
  const { busy, error, run, disabled } = useResolver(item)
  const [note, setNote] = useState('')
  const access = useScreenAccess(item.state === 'pending' ? bot : null)
  const [resolving, setResolving] = useState(false)

  if (item.state === 'resolved')
    return (
      <ResolvedLine
        icon="check"
        tone="ok"
        text={item.note ? t('help.resolvedNote', { note: item.note }) : t('help.resolved')}
      />
    )
  const resolveForm = (
    <>
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
        variant={access ? 'secondary' : 'primary'}
        disabled={disabled}
        busy={busy}
        onPress={() => void run({ kind: 'help', note: note.trim() || null }, t('announce.resolved'))}
      />
    </>
  )
  return (
    <CueCard>
      <AppText accessibilityRole="header" style={{ fontSize: 17, lineHeight: 22, fontWeight: '600', marginBottom: 6 }}>
        {t('help.title', { name })}
      </AppText>
      <AppText style={{ fontSize: 15, lineHeight: 21, marginBottom: 12 }}>{item.reason}</AppText>
      {access && bot ? (
        <View style={{ gap: 8 }}>
          {access.owned ? (
            <>
              <AppText variant="sub" tone="muted">
                {t('help.screen.yours', { name })}
              </AppText>
              <Button
                label={t('help.screen.back')}
                icon="laptop"
                disabled={!online}
                onPress={() => openBotScreen(bot.id)}
              />
              <Button
                label={t('help.screen.give')}
                variant="secondary"
                disabled={!online}
                onPress={() => openBotScreen(bot.id, { give: true })}
              />
            </>
          ) : (
            <>
              {access.other !== null ? (
                <AppText variant="sub" tone="muted">
                  {access.other ? t('help.screen.other', { device: access.other }) : t('help.screen.otherUnknown')}
                </AppText>
              ) : null}
              <Button
                label={t('help.screen.open', { name })}
                icon="laptop"
                disabled={!online}
                onPress={() => openBotScreen(bot.id)}
              />
              {resolving ? (
                <View style={{ marginTop: 4 }}>{resolveForm}</View>
              ) : (
                <Button
                  label={t('help.screen.without')}
                  variant="ghost"
                  disabled={disabled}
                  onPress={() => setResolving(true)}
                />
              )}
            </>
          )}
        </View>
      ) : (
        resolveForm
      )}
      <CardError text={error} />
    </CueCard>
  )
}
