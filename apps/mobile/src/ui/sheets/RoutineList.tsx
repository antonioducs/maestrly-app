import type { FleetBot, FleetRoutine } from '@maestrly/bot-fleet-protocol'
import { useEffect, useState } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import { formatSchedule } from '../../fleet/format'
import { useFleetController } from '../../fleet/react'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Button } from '../primitives/Button'
import { Group } from '../primitives/Group'
import { AppText } from '../primitives/Text'

/** A bot's routines, each with when it runs and a way to run it now; editing them stays on the computer. */
export function RoutineList({ bot }: { bot: FleetBot }) {
  const { palette } = useTheme()
  const text = useI18n()
  const { t, locale } = text
  const controller = useFleetController()
  const [routines, setRoutines] = useState<FleetRoutine[] | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    controller.source
      .call('botRoutinesList', { params: { id: bot.id } })
      .then((response) => alive && setRoutines(response.routines))
      .catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [controller, bot.id])

  async function runNow(routine: FleetRoutine) {
    setRunning(routine.id)
    try {
      const updated = await controller.source.call('botRoutineRun', { params: { id: bot.id, rid: routine.id } })
      setRoutines((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? null)
      AccessibilityInfo.announceForAccessibility(t('details.routineStarted', { title: routine.title }))
    } catch {
      setError(true)
    } finally {
      setRunning(null)
    }
  }

  return (
    <Group label={t('details.routines')} foot={t('details.routinesFoot')}>
      {routines === null ? (
        <AppText variant="sub" tone="muted" style={{ padding: 14 }}>
          {error ? t('outbox.error.generic') : t('common.loading')}
        </AppText>
      ) : routines.length === 0 ? (
        <AppText variant="sub" tone="muted" style={{ padding: 14 }}>
          {t('details.noRoutines')}
        </AppText>
      ) : (
        routines.map((routine) => (
          <View key={routine.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 14 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText numberOfLines={1}>{routine.title}</AppText>
              <AppText variant="sub" tone="muted" numberOfLines={1}>
                {formatSchedule(routine.schedule, text, locale)}
              </AppText>
            </View>
            {routine.enabled ? null : (
              <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: palette.surface }}>
                <AppText variant="small" tone="muted">
                  {t('details.routineOff')}
                </AppText>
              </View>
            )}
            <Button
              label={t('details.runNow')}
              accessibilityLabel={`${t('details.runNow')}: ${routine.title}`}
              size="sm"
              variant="secondary"
              busy={running === routine.id}
              disabled={running !== null}
              onPress={() => void runNow(routine)}
            />
          </View>
        ))
      )}
    </Group>
  )
}
