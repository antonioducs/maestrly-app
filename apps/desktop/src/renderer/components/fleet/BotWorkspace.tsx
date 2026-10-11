import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { BotWorkspaceLayout } from '@/lib/fleet/use-bot-workspace-layout'
import { SplitWorkspace } from './SplitWorkspace'

/** A bot's conversation beside its computer. */
export function BotWorkspace({
  botId,
  name,
  layout,
  conversation,
  computer,
}: {
  botId: string
  name: string
  layout: BotWorkspaceLayout
  conversation: ReactNode
  computer: ReactNode
}) {
  const { t } = useTranslation('fleet')
  return (
    <SplitWorkspace
      layout={layout}
      primary={conversation}
      secondary={computer}
      primaryId="fleet-workspace-conversation"
      labels={{
        primary: t('workspace.chatRegion', { name }),
        secondary: t('workspace.computerRegion', { name }),
        resize: t('workspace.resize'),
      }}
      attributes={{ 'data-bot-workspace': botId }}
    />
  )
}
