import {
  MobileBridgeError,
  type MobileSubscriptionUsageEntry,
  type MobileSubscriptionUsageWindow,
} from '@maestrly/bot-fleet-protocol'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { useChats, useChatsController } from '../chats/react'
import type { ChatsState } from '../chats/state'
import {
  groupUsageByProvider,
  usageAccountLabel,
  usageErrorLine,
  usagePercent,
  usageResetLine,
  usageTone,
  usageUpdatedLine,
  usageWindowLabel,
} from '../chats/subscription-usage'
import { useI18n } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { shownError } from '../ui/conversation/CueCard'
import { Button } from '../ui/primitives/Button'
import { Group } from '../ui/primitives/Group'
import { AppText } from '../ui/primitives/Text'
import { SheetScreen } from '../ui/SheetScreen'
import { useNow } from '../ui/useNow'

function UsageWindow({ window, now }: { window: MobileSubscriptionUsageWindow; now: number }) {
  const { palette } = useTheme()
  const { t, locale } = useI18n()
  const label = usageWindowLabel(window, t)
  const reset = usageResetLine(window.resetsAt, t, locale, now)
  const percent = usagePercent(window)
  const used = t('usage.percentUsed', { percent })
  const tone = usageTone(percent)
  const bar = tone === 'critical' ? palette.brick : tone === 'high' ? palette.cue : palette.moss
  const ink = tone === 'critical' ? palette.brick : tone === 'high' ? palette.cueInk : palette.muted
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={reset ? `${label}, ${reset}` : label}
      accessibilityValue={{ min: 0, max: 100, now: percent, text: used }}
      style={{ marginTop: 12 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
        <AppText variant="sub" style={{ flex: 1 }}>
          {label}
          {reset ? <AppText variant="sub" tone="muted">{` · ${reset}`}</AppText> : null}
        </AppText>
        <AppText variant="sub" style={{ color: ink, fontVariant: ['tabular-nums'] }}>
          {used}
        </AppText>
      </View>
      <View style={{ height: 4, borderRadius: 2, marginTop: 6, overflow: 'hidden', backgroundColor: palette.line }}>
        <View style={{ width: `${percent}%`, height: '100%', borderRadius: 2, backgroundColor: bar }} />
      </View>
    </View>
  )
}

function AccountUsage({ entry, now }: { entry: MobileSubscriptionUsageEntry; now: number }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  return (
    <View style={{ paddingVertical: 12, paddingHorizontal: 14 }}>
      <AppText variant="bodyMedium" numberOfLines={1}>
        {usageAccountLabel(entry, t)}
      </AppText>
      {entry.state === 'error' ? (
        <AppText variant="sub" style={{ marginTop: 4, color: palette.brick }}>
          {usageErrorLine(entry, t)}
        </AppText>
      ) : entry.windows.length === 0 ? (
        <AppText variant="sub" tone="muted" style={{ marginTop: 4 }}>
          {t('usage.noWindows')}
        </AppText>
      ) : (
        entry.windows.map((window) => <UsageWindow key={window.id} window={window} now={now} />)
      )}
    </View>
  )
}

/** The quota usage of the subscriptions connected on the server, read only, one block per account. */
function Usage() {
  const { palette } = useTheme()
  const { t } = useI18n()
  const chats = useChatsController()
  const { active } = useServers()
  const online = useChats(useCallback((state: ChatsState) => state.bridge === 'open', []))
  const [usage, setUsage] = useState<{ entries: MobileSubscriptionUsageEntry[]; readAt: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [outdated, setOutdated] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const latest = useRef(0)
  const now = useNow(usage !== null, 30_000)
  const server = active?.name ?? ''

  const load = useCallback(
    async (force: boolean) => {
      const request = ++latest.current
      setLoading(true)
      setFailure(null)
      try {
        const result = await chats.subscriptionUsage(force)
        if (request !== latest.current) return
        setUsage({ entries: result.entries, readAt: Date.now() })
        setOutdated(false)
      } catch (cause) {
        if (request !== latest.current) return
        if (cause instanceof MobileBridgeError && cause.code === 'unknown-channel') setOutdated(true)
        else setFailure(cause ?? new Error('failed'))
      } finally {
        if (request === latest.current) setLoading(false)
      }
    },
    [chats]
  )

  // Read again each time the sheet comes back into view, and when the host becomes reachable.
  useFocusEffect(
    useCallback(() => {
      if (online) void load(false)
    }, [online, load])
  )

  const groups = usage ? groupUsageByProvider(usage.entries) : []
  const notice = (text: string, alert = false) => (
    <View style={{ paddingVertical: 28, paddingHorizontal: 12, alignItems: 'center' }}>
      <AppText
        tone="muted"
        accessibilityRole={alert ? 'alert' : undefined}
        style={{ textAlign: 'center', fontSize: 14.5, lineHeight: 21 }}
      >
        {text}
      </AppText>
    </View>
  )

  return (
    <SheetScreen title={t('usage.title')} onDone={() => router.back()}>
      <AppText variant="sub" tone="muted" style={{ marginTop: 6, marginHorizontal: 6, fontSize: 13.5, lineHeight: 20 }}>
        {t('usage.note', { server })}
      </AppText>
      {outdated ? null : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, marginHorizontal: 4 }}>
          <AppText variant="small" tone="muted" style={{ flex: 1, marginLeft: 2 }}>
            {usage ? usageUpdatedLine(usage.readAt, t, now) : ''}
          </AppText>
          <Button
            label={t('usage.refresh')}
            accessibilityLabel={t('usage.refreshLabel')}
            icon="restart"
            variant="secondary"
            size="sm"
            busy={loading}
            disabled={!online}
            onPress={() => void load(true)}
          />
        </View>
      )}
      {failure ? (
        <AppText
          accessibilityRole="alert"
          style={{ marginTop: 10, marginHorizontal: 6, fontSize: 13, color: palette.brick }}
        >
          {shownError(failure, t('usage.loadFailed'))}
        </AppText>
      ) : null}
      {outdated ? (
        notice(t('usage.outdated', { server }), true)
      ) : !usage ? (
        online ? (
          loading ? (
            <View style={{ paddingVertical: 32, alignItems: 'center' }}>
              <ActivityIndicator color={palette.muted} accessibilityLabel={t('common.loading')} />
            </View>
          ) : null
        ) : (
          notice(t('usage.offline'))
        )
      ) : groups.length === 0 ? (
        notice(t('usage.empty', { server }))
      ) : (
        groups.map((group) => (
          <Group key={group.kind} label={group.label}>
            {group.entries.map((entry) => (
              <AccountUsage key={entry.providerId} entry={entry} now={now} />
            ))}
          </Group>
        ))
      )}
    </SheetScreen>
  )
}

export default function UsageScreen() {
  const { chats } = useServers()
  return chats ? <Usage /> : null
}
