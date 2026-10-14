import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'

/** The model's reasoning, folded to one line until asked for. */
export function ReasoningBlock({ item }: { item: Extract<FleetTranscriptItem, { kind: 'reasoning' }> }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const label = item.streaming ? t('reasoning.live') : t('reasoning.collapsed')
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        aria-expanded={open}
        accessibilityLabel={label}
        onPress={() => setOpen((value) => !value)}
        hitSlop={{ top: 7, bottom: 7 }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 30 }}
      >
        <Icon name="brain" size={16} color={palette.muted} />
        <AppText variant="sub" tone="muted" style={{ fontSize: 14 }}>
          {label}
        </AppText>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon name="chev-right" size={14} color={palette.faint} />
        </View>
      </Pressable>
      {open ? (
        <View
          style={{ marginTop: 4, marginLeft: 6, paddingLeft: 13, borderLeftWidth: 1.5, borderLeftColor: palette.line }}
        >
          <AppText variant="sub" tone="muted" selectable style={{ fontSize: 14, lineHeight: 20 }}>
            {item.text}
            {item.truncated ? '…' : ''}
          </AppText>
        </View>
      ) : null}
    </View>
  )
}
