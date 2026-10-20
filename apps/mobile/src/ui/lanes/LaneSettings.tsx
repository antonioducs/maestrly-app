import {
  FLEET_PEER_THREAD_LIMITS,
  FLEET_ROUTINE_RUN_LIMITS,
  FLEET_ROUTINE_RUN_RETENTION_DAYS,
  type FleetBot,
  type FleetPeerThreadSettings,
  type FleetRoutineRunSettings,
} from '@maestrly/bot-fleet-protocol'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ScrollView, Switch, View } from 'react-native'
import { runSettingsOf, threadSettingsOf } from '../../fleet/lanes'
import { useFleetController } from '../../fleet/react'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Pills } from '../primitives/Pills'
import { Sheet } from '../primitives/Sheet'
import { AppText } from '../primitives/Text'

type Retention = FleetRoutineRunSettings['retentionDays']
const retentionValue = (days: Retention): string => (days === null ? 'never' : String(days))
const retentionOf = (value: string): Retention => (value === 'never' ? null : (Number(value) as 30 | 60 | 90))

function Field({ label, hint, children }: { label: string; hint?: string | null; children: ReactNode }) {
  return (
    <View style={{ marginTop: 16 }}>
      <AppText variant="label" style={{ marginHorizontal: 4 }}>
        {label}
      </AppText>
      {hint ? (
        <AppText variant="small" tone="muted" style={{ marginHorizontal: 4, marginTop: 2 }}>
          {hint}
        </AppText>
      ) : null}
      <View style={{ marginHorizontal: -12 }}>{children}</View>
    </View>
  )
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint?: string | null
  value: boolean
  onChange: (value: boolean) => void
}) {
  const { palette } = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, marginHorizontal: 4 }}>
      <View style={{ flex: 1 }}>
        <AppText variant="label">{label}</AppText>
        {hint ? (
          <AppText variant="small" tone="muted" style={{ marginTop: 2 }}>
            {hint}
          </AppText>
        ) : null}
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: palette.brass, false: palette.lineStrong }}
      />
    </View>
  )
}

/**
 * Settings saved as each one changes, shown at once and undone when the server refuses them. Read when the sheet
 * opens: an update of the bot while it is open (its status, its usage) must not undo a choice.
 */
function useSaved<T>(open: boolean, current: T, save: (next: T) => Promise<unknown>) {
  const [value, setValue] = useState(current)
  const [failed, setFailed] = useState(false)
  const latest = useRef(current)
  latest.current = current
  useEffect(() => {
    if (!open) return
    setValue(latest.current)
    setFailed(false)
  }, [open])
  const change = async (next: T) => {
    const previous = value
    setValue(next)
    setFailed(false)
    try {
      await save(next)
    } catch {
      setValue(previous)
      setFailed(true)
    }
  }
  return { value, failed, change }
}

function Failed({ shown }: { shown: boolean }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  if (!shown) return null
  return (
    <AppText
      accessibilityRole="alert"
      style={{ marginTop: 10, marginHorizontal: 4, fontSize: 13, color: palette.brick }}
    >
      {t('lanes.settingsFailed')}
    </AppText>
  )
}

/** How a bot keeps its routine runs' conversations, and which finished runs the owner hears about. */
export function RunSettingsSheet({ bot, open, onClose }: { bot: FleetBot; open: boolean; onClose: () => void }) {
  const { t, plural } = useI18n()
  const controller = useFleetController()
  const { value, failed, change } = useSaved(open, runSettingsOf(bot), (next) =>
    controller.saveRunSettings(bot.id, next)
  )
  return (
    <Sheet open={open} title={t('runs.settings.title')} onClose={onClose}>
      <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 8 }}>
        <AppText variant="sub" tone="muted" style={{ marginHorizontal: 4 }}>
          {t('runs.settings.description', { name: bot.name })}
        </AppText>
        <Field label={t('runs.settings.retention')} hint={t('runs.settings.retentionHint')}>
          <Pills
            label={t('runs.settings.retention')}
            options={[...FLEET_ROUTINE_RUN_RETENTION_DAYS, null].map((days) => ({
              value: retentionValue(days),
              label: days === null ? t('lanes.never') : plural('lanes.days', days),
            }))}
            value={retentionValue(value.retentionDays)}
            onChange={(next) => void change({ ...value, retentionDays: retentionOf(next) })}
          />
        </Field>
        <Toggle
          label={t('runs.settings.cap', { count: FLEET_ROUTINE_RUN_LIMITS.keepPerRoutine })}
          hint={t('runs.settings.capHint')}
          value={value.capPerRoutine}
          onChange={(capPerRoutine) => void change({ ...value, capPerRoutine })}
        />
        <Toggle
          label={t('runs.settings.quiet')}
          hint={plural('runs.settings.quietHint', FLEET_ROUTINE_RUN_LIMITS.quietRetentionDays)}
          value={value.quietEarly}
          onChange={(quietEarly) => void change({ ...value, quietEarly })}
        />
        <Field label={t('runs.settings.notify')} hint={t('runs.settings.notifyHint', { name: bot.name })}>
          <Pills
            label={t('runs.settings.notify')}
            options={(['notable', 'all', 'none'] as const).map((notify) => ({
              value: notify,
              label: t(`runs.settings.notify.${notify}`),
            }))}
            value={value.notify}
            onChange={(notify) => void change({ ...value, notify })}
          />
        </Field>
        <AppText variant="small" tone="muted" style={{ marginHorizontal: 4 }}>
          {t('runs.settings.note', { name: bot.name })}
        </AppText>
        <Failed shown={failed} />
      </ScrollView>
    </Sheet>
  )
}

/** How a bot keeps its conversations with other bots, and when the bots stop to wait for the owner. */
export function ThreadSettingsSheet({ bot, open, onClose }: { bot: FleetBot; open: boolean; onClose: () => void }) {
  const { t, plural } = useI18n()
  const controller = useFleetController()
  const { value, failed, change } = useSaved<FleetPeerThreadSettings>(open, threadSettingsOf(bot), (next) =>
    controller.saveThreadSettings(bot.id, next)
  )
  return (
    <Sheet open={open} title={t('threads.settings.title')} onClose={onClose}>
      <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 8 }}>
        <AppText variant="sub" tone="muted" style={{ marginHorizontal: 4 }}>
          {t('threads.settings.description', { name: bot.name })}
        </AppText>
        <Field label={t('threads.settings.retention')} hint={t('threads.settings.retentionHint')}>
          <Pills
            label={t('threads.settings.retention')}
            options={[...FLEET_ROUTINE_RUN_RETENTION_DAYS, null].map((days) => ({
              value: retentionValue(days),
              label: days === null ? t('lanes.never') : plural('lanes.days', days),
            }))}
            value={retentionValue(value.retentionDays)}
            onChange={(next) => void change({ ...value, retentionDays: retentionOf(next) })}
          />
        </Field>
        <Field label={t('threads.settings.hops')} hint={t('threads.settings.hopsHint')}>
          <Pills
            label={t('threads.settings.hops')}
            options={FLEET_PEER_THREAD_LIMITS.hopLimits.map((limit) => ({
              value: String(limit),
              label: plural('threads.messages', limit),
            }))}
            value={String(value.hopLimit)}
            onChange={(next) => void change({ ...value, hopLimit: Number(next) as 4 | 8 | 16 })}
          />
        </Field>
        <AppText variant="small" tone="muted" style={{ marginHorizontal: 4 }}>
          {t('threads.settings.note', { name: bot.name })}
        </AppText>
        <Failed shown={failed} />
      </ScrollView>
    </Sheet>
  )
}
