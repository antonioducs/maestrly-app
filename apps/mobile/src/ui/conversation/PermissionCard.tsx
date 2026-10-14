import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { CardError, CueCard, ResolvedLine, useConversation, useResolver } from './CueCard'

const SHELL = new Set(['bash', 'shell', 'exec_command'])

export function PermissionCard({ item }: { item: Extract<FleetTranscriptItem, { kind: 'permission' }> }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { bot, name } = useConversation()
  const { busy, error, run, disabled } = useResolver(item)

  if (item.state !== 'pending')
    return item.state === 'approved' ? (
      <ResolvedLine icon="check" tone="ok" text={t('perm.approved')} />
    ) : item.state === 'denied' ? (
      <ResolvedLine icon="x" tone="denied" text={t('perm.denied')} />
    ) : (
      <ResolvedLine icon="clock" tone="muted" text={t('perm.expired')} />
    )

  const command = item.tool && SHELL.has(item.tool.name) ? item.tool.target : null
  return (
    <CueCard>
      <AppText accessibilityRole="header" style={{ fontSize: 17, lineHeight: 22, fontWeight: '600', marginBottom: 10 }}>
        {command === null ? item.title : bot ? t('perm.titleCommand', { name }) : t('perm.titleCommandChat')}
      </AppText>
      {item.tool?.target ? (
        <View
          style={{
            marginBottom: 8,
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderRadius: 10,
            backgroundColor: palette.codeBg,
          }}
        >
          <AppText style={{ fontFamily: fonts.mono, fontSize: 13, lineHeight: 18, color: palette.codeInk }}>
            {command !== null ? <AppText style={{ color: '#d4b273', fontFamily: fonts.mono }}>$ </AppText> : null}
            {item.tool.target}
          </AppText>
        </View>
      ) : null}
      {item.detail ? (
        <AppText variant="sub" tone="muted" style={{ fontSize: 14, lineHeight: 20, marginBottom: 12 }}>
          {item.detail}
        </AppText>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          label={t('perm.allowOnce')}
          style={{ flex: 1 }}
          disabled={disabled}
          busy={busy}
          onPress={() => void run({ kind: 'permission', reply: 'once' }, t('announce.allowed'))}
        />
        <Button
          label={t('perm.alwaysAllow')}
          variant="secondary"
          style={{ flex: 1 }}
          disabled={disabled}
          onPress={() => void run({ kind: 'permission', reply: 'always' }, t('announce.allowed'))}
        />
      </View>
      <Button
        label={t('perm.deny')}
        variant="danger"
        disabled={disabled}
        onPress={() => void run({ kind: 'permission', reply: 'reject' }, t('announce.denied'))}
        style={{ marginTop: 4 }}
      />
      <CardError text={error} />
    </CueCard>
  )
}
