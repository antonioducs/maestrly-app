import { FLEET_PHONES_FEATURE, type FleetPushCategory } from '@maestrly/bot-fleet-protocol'
import { useState } from 'react'
import { AccessibilityInfo, Switch, View } from 'react-native'
import { DEMO_SERVER } from '../../demo/demo-source'
import { useI18n } from '../../i18n'
import { useNotifications } from '../../notifications/NotificationsProvider'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { shownError } from '../conversation/CueCard'
import { Button } from '../primitives/Button'
import { Cell } from '../primitives/Cell'
import { Group } from '../primitives/Group'

const CATEGORIES: FleetPushCategory[] = ['waiting', 'replies', 'routines', 'errors']

/** Whether this phone gets notifications, about what, and a test to check they arrive. */
export function NotificationSettings() {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { active } = useServers()
  const notifications = useNotifications()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const server = active?.name ?? ''
  const granted = notifications.permission === 'granted'
  const demo = active?.id === DEMO_SERVER.id
  const supported = demo || !!active?.features.includes(FLEET_PHONES_FEATURE)
  const result = active ? notifications.results[active.id] : undefined

  if (!notifications.available)
    return (
      <Group label={t('notifications.title')}>
        <Cell icon="bell-off" label={t('notifications.unavailable')} sub={t('notifications.unavailableSub')} />
      </Group>
    )

  // Why notifications do not arrive, when they do not.
  const problem = !granted
    ? null
    : notifications.problem === 'project'
      ? t('notifications.problem.project')
      : notifications.problem === 'device'
        ? t('notifications.problem.device')
        : notifications.problem === 'failed'
          ? t('notifications.problem.failed')
          : !supported
            ? t('notifications.problem.server', { server })
            : result === 'off'
              ? t('notifications.problem.off', { server })
              : result === 'failed'
                ? t('notifications.problem.register', { server })
                : null

  async function test() {
    if (!active) return
    setTesting(true)
    setTestResult(null)
    try {
      await notifications.sendTest(active.id)
      setTestResult(t('notifications.testSent'))
      AccessibilityInfo.announceForAccessibility(t('notifications.testSent'))
    } catch (cause) {
      setTestResult(shownError(cause, t('notifications.testFailed')))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Group label={t('notifications.title')} foot={problem ?? testResult ?? t('notifications.foot')}>
      {granted ? null : (
        <Cell
          icon="bell-off"
          label={t('notifications.off')}
          sub={notifications.permission === 'denied' ? t('notifications.denied') : t('notifications.offSub')}
          trailing={
            <Button
              label={
                notifications.permission === 'denied' ? t('notifications.openSettings') : t('notifications.turnOn')
              }
              size="sm"
              variant="secondary"
              onPress={() => void notifications.enable()}
            />
          }
        />
      )}
      {CATEGORIES.map((category) => (
        <Cell
          key={category}
          label={t(`notifications.category.${category}`)}
          sub={t(`notifications.categorySub.${category}`)}
          trailing={
            <Switch
              accessibilityLabel={t(`notifications.category.${category}`)}
              value={granted && notifications.preferences[category]}
              disabled={!granted}
              onValueChange={(value) => notifications.setPreference(category, value)}
              trackColor={{ true: palette.brass, false: palette.lineStrong }}
            />
          }
        />
      ))}
      <View>
        <Cell
          icon="bell"
          label={t('notifications.test')}
          tone="brass"
          disabled={!granted || testing || (!demo && (!supported || result !== 'registered'))}
          onPress={() => void test()}
        />
      </View>
    </Group>
  )
}
