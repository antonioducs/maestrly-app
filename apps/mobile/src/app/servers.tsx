import { router } from 'expo-router'
import { useI18n } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { Cell } from '../ui/primitives/Cell'
import { Group } from '../ui/primitives/Group'
import { SheetScreen } from '../ui/SheetScreen'

export default function Servers() {
  const { t } = useI18n()
  const { servers, active, activate } = useServers()
  return (
    <SheetScreen title={t('servers.title')} onDone={() => router.back()}>
      <Group label={t('servers.title')} foot={t('servers.foot')}>
        {servers.map((server) => (
          <Cell
            key={server.id}
            icon="server"
            label={server.name}
            sub={server.origin.replace(/^https?:\/\//, '')}
            checked={server.id === active?.id}
            role="radio"
            accessibilityLabel={server.id === active?.id ? `${server.name}, ${t('servers.active')}` : server.name}
            onPress={() => void activate(server.id).then(() => router.back())}
          />
        ))}
      </Group>
      <Group>
        <Cell icon="plus" label={t('servers.add')} tone="brass" onPress={() => router.push('/scan')} />
      </Group>
    </SheetScreen>
  )
}
