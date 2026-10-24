import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, View } from 'react-native'
import { BotCompactError, type BotAction, type BotCompactIssue } from '../../fleet/controller'
import { filesLevel, filesShare } from '../../fleet/files'
import { formatCost, formatTokens } from '../../fleet/format'
import { useFleet, useFleetController } from '../../fleet/react'
import { botStatusLine, statusLineText } from '../../fleet/selectors'
import { setupSummary } from '../../fleet/setup'
import type { FleetState } from '../../fleet/state'
import { useBotSelections } from '../../fleet/use-selections'
import { useI18n } from '../../i18n'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { BotAvatar } from '../../ui/Avatar'
import { confirm } from '../../ui/confirm'
import { FilesMeter } from '../../ui/files/FilesMeter'
import { useBotFiles } from '../../ui/files/use-bot-files'
import { Icon } from '../../ui/icons'
import { Button } from '../../ui/primitives/Button'
import { Cell } from '../../ui/primitives/Cell'
import { Group } from '../../ui/primitives/Group'
import { AppText } from '../../ui/primitives/Text'
import { openBotScreen, useScreenAccess } from '../../ui/screen/screen-access'
import { RoutineList } from '../../ui/sheets/RoutineList'
import { SheetScreen } from '../../ui/SheetScreen'

const ACTIONS: Record<FleetBot['status'], BotAction[]> = {
  offline: ['start'],
  working: ['cancel', 'pause'],
  paused: ['resume', 'restart'],
  idle: ['pause', 'restart'],
  waiting: ['pause', 'restart'],
  setup: ['pause', 'restart'],
  human: ['restart'],
  starting: [],
}
const ACTION_LABEL = {
  start: 'details.start',
  cancel: 'details.stopTurn',
  pause: 'details.pause',
  resume: 'details.resume',
  restart: 'details.restart',
  stop: 'details.stopTurn',
} as const

function ContextMeter({ bot }: { bot: FleetBot }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const usage = bot.usage
  const used = usage?.contextUsedTokens ?? null
  const window = usage?.contextWindowTokens ?? null
  if (used === null) return <Cell icon="gauge" label={t('details.context')} value={t('details.noUsage')} />
  const share = window ? Math.min(1, used / window) : null
  const parts = [
    window ? t('details.tokens', { used: formatTokens(used), window: formatTokens(window) }) : formatTokens(used),
    usage?.costUsd != null ? t('details.cost', { cost: formatCost(usage.costUsd) }) : null,
    usage?.contextQuality === 'estimated' ? t('details.estimated') : null,
  ].filter(Boolean)
  return (
    <View
      accessible
      accessibilityLabel={`${t('details.context')}: ${share !== null ? t('details.contextLabel', { percent: Math.round(share * 100) }) : ''} ${parts.join(', ')}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 14 }}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          backgroundColor: palette.surface,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="gauge" size={18} color={palette.ink} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText>{t('details.context')}</AppText>
        {share !== null ? (
          <View
            style={{ height: 6, marginTop: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: palette.surface }}
          >
            <View
              style={{
                width: `${Math.max(2, share * 100)}%`,
                height: 6,
                borderRadius: 3,
                backgroundColor: palette.brass,
              }}
            />
          </View>
        ) : null}
        <AppText variant="sub" tone="muted" style={{ marginTop: 4 }}>
          {parts.join(' · ')}
        </AppText>
      </View>
    </View>
  )
}

/** Below this, a summary would not free enough context to be worth a turn of the compaction model. */
const COMPACT_MIN_TOKENS = 20_000
const selectOnline = (state: FleetState) => state.connection === 'open'

/** Compacting the bot's conversation now, and preparing its background summary again after a failure. */
function Compaction({ bot }: { bot: FleetBot }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const controller = useFleetController()
  const online = useFleet(selectOnline)
  const [busy, setBusy] = useState<'compact' | 'retry' | null>(null)
  const [issue, setIssue] = useState<BotCompactIssue | null>(null)
  const compacting = bot.activity?.kind === 'compacting'
  const configured = bot.compactionState?.configured !== false
  const running = bot.status === 'idle' || bot.status === 'waiting'
  const used = bot.usage?.contextUsedTokens ?? 0
  const can = online && configured && running && !compacting && used >= COMPACT_MIN_TOKENS
  const sub = compacting
    ? t('chat.setup.compacting')
    : !configured
      ? t('details.compactNoModel')
      : !online
        ? t('chat.setup.compactOffline')
        : bot.status === 'working' || bot.status === 'starting'
          ? t('chat.setup.compactWorking')
          : !running
            ? t('details.compactStopped')
            : used < COMPACT_MIN_TOKENS
              ? t('chat.setup.compactSmall')
              : t('chat.setup.compactSub')
  const failed = bot.compactionState?.background.status === 'failed'

  async function run(kind: 'compact' | 'retry') {
    setBusy(kind)
    setIssue(null)
    try {
      if (kind === 'compact') {
        await controller.compact(bot.id)
        AccessibilityInfo.announceForAccessibility(t('chat.setup.compacting'))
      } else await controller.retryBackgroundCompaction(bot.id)
    } catch (error) {
      setIssue(error instanceof BotCompactError ? error.issue : 'failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Cell
        icon="compress"
        label={t('chat.setup.compact')}
        sub={sub}
        disabled={!can || busy !== null}
        trailing={busy === 'compact' || compacting ? <ActivityIndicator size="small" color={palette.muted} /> : null}
        onPress={() => void run('compact')}
      />
      {failed && configured ? (
        <Cell
          icon="restart"
          label={t('details.compactRetry')}
          sub={t('details.compactRetrySub')}
          disabled={!online || busy !== null}
          trailing={busy === 'retry' ? <ActivityIndicator size="small" color={palette.muted} /> : null}
          onPress={() => void run('retry')}
        />
      ) : null}
      {issue ? (
        <AppText
          accessibilityRole="alert"
          style={{ marginHorizontal: 14, marginBottom: 10, fontSize: 13, color: palette.brick }}
        >
          {t(`details.compactError.${issue}`)}
        </AppText>
      ) : null}
    </>
  )
}

function Details({ bot }: { bot: FleetBot }) {
  const { palette } = useTheme()
  const text = useI18n()
  const { t } = text
  const controller = useFleetController()
  const environment = useFleet(
    useCallback(
      (state: FleetState) => state.environments.find((item) => item.id === bot.environmentId)?.name ?? null,
      [bot.environmentId]
    )
  )
  const { option } = useBotSelections(bot)
  const files = useBotFiles(bot)
  const screen = useScreenAccess(bot)
  const [busy, setBusy] = useState<BotAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const line = botStatusLine(bot, text)

  async function act(action: BotAction) {
    if (action === 'restart') {
      const sure = await confirm({
        title: t('details.restartTitle', { name: bot.name }),
        message: t('details.restartBody'),
        confirmLabel: t('details.restart'),
        cancelLabel: t('common.cancel'),
      })
      if (!sure) return
    }
    setBusy(action)
    setError(null)
    try {
      await controller.action(bot.id, action)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('outbox.error.generic'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SheetScreen title={bot.name} onDone={() => router.back()}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 8, paddingHorizontal: 4 }}>
        <BotAvatar bot={bot} size={72} />
        <View style={{ flex: 1 }}>
          {bot.role ? (
            <AppText variant="sub" tone="muted" style={{ fontSize: 14 }}>
              {bot.role}
            </AppText>
          ) : null}
          <AppText
            accessibilityLiveRegion="polite"
            variant={line.tone === 'mono' ? 'mono' : 'sub'}
            tone={line.tone === 'cue' ? 'cue' : 'muted'}
            style={line.tone === 'cue' ? { fontFamily: fonts.bodySemi, marginTop: 4 } : { marginTop: 4 }}
          >
            {statusLineText(bot, line)}
          </AppText>
        </View>
      </View>
      {ACTIONS[bot.status].length ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
          {ACTIONS[bot.status].map((action) => (
            <Button
              key={action}
              label={t(ACTION_LABEL[action])}
              variant={action === 'start' || action === 'resume' ? 'primary' : 'secondary'}
              icon={
                action === 'start' || action === 'resume'
                  ? 'play'
                  : action === 'restart'
                    ? 'restart'
                    : action === 'pause'
                      ? 'pause'
                      : 'stop'
              }
              busy={busy === action}
              disabled={busy !== null}
              onPress={() => void act(action)}
              style={{ flex: 1 }}
            />
          ))}
        </View>
      ) : null}
      {error ? (
        <AppText
          accessibilityRole="alert"
          style={{ marginTop: 8, marginHorizontal: 4, fontSize: 13, color: palette.brick }}
        >
          {error}
        </AppText>
      ) : null}
      {screen ? (
        <Group>
          <Cell
            icon="laptop"
            label={t('details.screen')}
            value={
              screen.owned
                ? t('details.screenYours')
                : screen.other !== null
                  ? screen.other || t('details.screenOther')
                  : null
            }
            chevron
            onPress={() => openBotScreen(bot.id)}
          />
        </Group>
      ) : null}
      <Group label={t('details.setup')}>
        <Cell
          icon="sparkles"
          label={t('details.model')}
          value={setupSummary(bot, option, t)}
          trailing={bot.selection?.fastMode ? <Icon name="zap-fill" size={14} color={palette.brass} /> : null}
          chevron
          onPress={() => router.push({ pathname: '/bot-setup/[id]', params: { id: bot.id, page: 'model' } })}
        />
        <Cell
          icon="shield"
          label={t('details.permissions')}
          trailing={
            <AppText style={{ fontSize: 15, color: bot.ceiling === 'full' ? palette.brick : palette.muted }}>
              {t(`ceiling.${bot.ceiling}.label`)}
            </AppText>
          }
          chevron
          onPress={() => router.push({ pathname: '/bot-setup/[id]', params: { id: bot.id } })}
        />
        <ContextMeter bot={bot} />
        <Compaction bot={bot} />
        {environment ? <Cell icon="server" label={t('details.environment')} value={environment} /> : null}
      </Group>
      {files.supported ? (
        <Group
          label={t('details.filesGroup')}
          foot={
            filesLevel(files.usage) === 'full' ? (
              <AppText variant="small" style={{ color: palette.brick, marginTop: 7, marginHorizontal: 6 }}>
                {t('details.filesFull', { name: bot.name })}
              </AppText>
            ) : filesLevel(files.usage) === 'near' && files.usage ? (
              <AppText variant="small" style={{ color: palette.cueInk, marginTop: 7, marginHorizontal: 6 }}>
                {t('details.filesNear', { percent: Math.floor(filesShare(files.usage) * 100) })}
              </AppText>
            ) : undefined
          }
        >
          <FilesMeter bot={bot} usage={files.usage} />
        </Group>
      ) : null}
      <RoutineList bot={bot} />
    </SheetScreen>
  )
}

export default function BotDetails() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { controller } = useServers()
  if (!controller) return null
  return <BotDetailsFor id={String(id)} />
}

function BotDetailsFor({ id }: { id: string }) {
  const bot = useFleet(useCallback((state: FleetState) => state.bots.find((item) => item.id === id) ?? null, [id]))
  return bot ? <Details bot={bot} /> : null
}
