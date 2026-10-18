import { View } from 'react-native'
import { useI18n } from '../../i18n'
import { AppText } from '../primitives/Text'
import { systemLineText, type SystemItem } from './system-line'

/** A quiet centered line for what happened around the conversation: pauses, restarts, compactions, messages out. */
export function SystemLine({ item }: { item: SystemItem }) {
  const { t } = useI18n()
  const { text, detail } = systemLineText(item, t)
  return (
    <View style={{ alignItems: 'center', gap: 2 }}>
      <AppText variant="small" tone="faint" style={{ textAlign: 'center' }}>
        {text}
      </AppText>
      {detail ? (
        <AppText variant="small" tone="muted" numberOfLines={3} style={{ textAlign: 'center', maxWidth: '86%' }}>
          {detail}
        </AppText>
      ) : null}
    </View>
  )
}
