import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { View } from 'react-native'
import { useI18n } from '../../i18n'
import { AppText } from '../primitives/Text'

type SystemItem = Extract<FleetTranscriptItem, { kind: 'system' | 'compaction' | 'peer_out' }>

/** A quiet centered line for what happened around the conversation: pauses, restarts, compactions, messages out. */
export function SystemLine({ item }: { item: SystemItem }) {
  const { t } = useI18n()
  const text =
    item.kind === 'compaction'
      ? t('system.compaction')
      : item.kind === 'peer_out'
        ? t('system.peerOut', { name: item.to.name })
        : t(`system.${item.code}`)
  const detail = item.kind === 'peer_out' ? item.text : item.kind === 'system' ? item.text : null
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
