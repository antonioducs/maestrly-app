import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import type { Translate } from '../../i18n/translate'

export type SystemItem = Extract<FleetTranscriptItem, { kind: 'system' | 'compaction' | 'peer_out' }>

/**
 * What a system line says, and the detail under it. A message that opened a conversation with another bot
 * (`peer-conversations`) says so: that conversation goes on apart, and only the desktop app shows it.
 */
export function systemLineText(item: SystemItem, t: Translate): { text: string; detail: string | null } {
  if (item.kind === 'compaction') return { text: t('system.compaction'), detail: null }
  if (item.kind === 'peer_out')
    return {
      text: t(item.thread ? 'system.peerThread' : 'system.peerOut', { name: item.to.name }),
      detail: item.text,
    }
  return { text: t(`system.${item.code}`), detail: item.text ?? null }
}
