import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

export function FleetSidebarPanel({
  serverConnected,
  onOpenBotSettings,
}: {
  serverConnected: boolean
  /** Opens Settings now; the fleet settings section can be selected here when it exists. */
  onOpenBotSettings: () => void
}) {
  const { t } = useTranslation('ui')
  return (
    <div className="px-4 py-6 text-center text-xs text-muted-foreground">
      <p className="font-medium text-foreground">
        {serverConnected ? t('sidebar.noBots') : t('sidebar.noServerConnected')}
      </p>
      {!serverConnected && (
        <>
          <p className="mt-2 leading-5">{t('sidebar.connectBotServer')}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={onOpenBotSettings}>
            {t('sidebar.openSettings')}
          </Button>
        </>
      )}
    </div>
  )
}
