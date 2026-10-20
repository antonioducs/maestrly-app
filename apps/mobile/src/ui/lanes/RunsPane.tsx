import {
  FLEET_ROUTINE_RUN_LIMITS,
  fleetLaneTurn,
  type FleetBot,
  type FleetRoutineRun,
} from '@maestrly/bot-fleet-protocol'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native'
import { formatDay, formatTime } from '../../fleet/format'
import {
  dayKind,
  expiresInDays,
  runDays,
  runRoutines,
  runSettingsOf,
  runState,
  runSummary,
  unseenRuns,
  type RunListEntry,
} from '../../fleet/lanes'
import { useFleet, useFleetController } from '../../fleet/react'
import { emptyRuns, type FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'
import { RunSettingsSheet } from './LaneSettings'
import { ChipRow, EmptyLane, ListHead, LoadFailed, MediaCounts, runLook, StateMark, Tag } from './parts'

type Row =
  | { kind: 'head'; key: string; text: string }
  | { kind: 'run'; key: string; run: FleetRoutineRun; nested?: boolean }
  | { kind: 'quiet'; key: string; entry: Extract<RunListEntry, { kind: 'quiet' }>; open: boolean }

/** What a run did, in one or two lines: its report, or what it is doing now. */
function useRunSummary(bot: FleetBot, run: FleetRoutineRun): string | null {
  const { t } = useI18n()
  const state = runState(run, bot)
  // The run's own turn's tool; from a gateway that predates turns, the bot's one activity is the run's.
  const turn = fleetLaneTurn({ turns: bot.turns ?? null, runningRun: bot.runningRun }, run.id)
  const activity = bot.turns ? (turn?.tool ?? null) : bot.activity?.kind === 'tool' ? bot.activity.tool : null
  if (state === 'running') return activity ? t('runs.summary.running', { activity }) : t('runs.summary.runningStart')
  if (state === 'queued') return t('runs.summary.queued')
  if (state === 'deleted') return [t('runs.summary.deleted'), runSummary(run)].filter(Boolean).join(' ')
  if (state === 'cancelled') return t('runs.summary.cancelled')
  return runSummary(run)
}

/** One run in the history: its state, routine, time, what it did, and what its conversation holds. */
export function RunRow({
  bot,
  run,
  fresh,
  nested,
  onOpen,
}: {
  bot: FleetBot
  run: FleetRoutineRun
  fresh: boolean
  nested?: boolean
  onOpen: () => void
}) {
  const { palette } = useTheme()
  const { t, plural, locale } = useI18n()
  const state = runState(run, bot)
  const look = runLook(state, palette)
  const title = run.routineTitle || t('lanes.routine')
  const time = formatTime(run.deliveredAt, locale)
  const summary = useRunSummary(bot, run)
  const expires = expiresInDays(run, Date.now())
  const expiring = expires !== null && expires <= 7 && !run.quiet && state !== 'deleted'
  const stateText = t(`runs.state.${state}`)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, stateText, time, summary, fresh ? t('lanes.new') : null].filter(Boolean).join(', ')}
      onPress={onOpen}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        marginLeft: nested ? 18 : 0,
        paddingVertical: 11,
        paddingHorizontal: 12,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: fresh ? palette.brass : palette.line,
        backgroundColor: pressed ? palette.surface : palette.raised,
      })}
    >
      <StateMark look={look} size={28} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <AppText
            numberOfLines={1}
            style={{
              flex: 1,
              fontFamily: fonts.bodySemi,
              fontSize: 14.5,
              lineHeight: 19,
              color: state === 'deleted' ? palette.muted : palette.ink,
            }}
          >
            {title}
          </AppText>
          <AppText variant="mono" tone="muted" style={{ fontSize: 11.5 }}>
            {time}
          </AppText>
        </View>
        {summary ? (
          <AppText
            numberOfLines={2}
            variant="sub"
            style={{ color: state === 'running' ? palette.brass : state === 'deleted' ? palette.muted : palette.ink }}
          >
            {summary}
          </AppText>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 }}>
          <Tag text={stateText} color={look.color} background={look.background} />
          {run.trigger === 'manual' ? <Tag text={t('runs.meta.manual')} /> : null}
          {run.adjustments ? <Tag text={plural('runs.meta.adjustments', run.adjustments)} /> : null}
          {run.pinned ? <Tag text={t('runs.meta.kept')} color={palette.brass} background={palette.brassSoft} /> : null}
          {expiring ? (
            <Tag
              text={expires === 0 ? t('runs.meta.expiresToday') : plural('runs.meta.expires', expires)}
              color={palette.cueInk}
              background={palette.cueSoft}
            />
          ) : null}
          <MediaCounts media={run.media} />
        </View>
      </View>
      {fresh ? (
        <View
          aria-hidden
          style={{ width: 8, height: 8, marginTop: 6, borderRadius: 4, backgroundColor: palette.brass }}
        />
      ) : null}
    </Pressable>
  )
}

/** A routine's runs of one day that found nothing new, as one line that opens to show them. */
function QuietRow({
  entry,
  open,
  onToggle,
}: {
  entry: Extract<RunListEntry, { kind: 'quiet' }>
  open: boolean
  onToggle: () => void
}) {
  const { palette } = useTheme()
  const { t, plural, locale } = useI18n()
  const times = entry.runs.map((run) => run.deliveredAt).sort()
  const span = `${formatTime(times[0], locale)}–${formatTime(times.at(-1) ?? times[0], locale)}`
  const title = entry.title || t('lanes.routine')
  return (
    <Pressable
      accessibilityRole="button"
      aria-expanded={open}
      accessibilityLabel={`${title}, ${plural('runs.quiet', entry.runs.length)}, ${span}`}
      onPress={onToggle}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: palette.lineStrong,
        backgroundColor: pressed ? palette.surface : 'transparent',
      })}
    >
      <Icon name="moon" size={16} color={palette.muted} />
      <AppText numberOfLines={1} variant="sub" tone="muted" style={{ flex: 1 }}>
        <AppText variant="sub" style={{ fontFamily: fonts.bodySemi, color: palette.ink }}>
          {plural('runs.quiet', entry.runs.length)}
        </AppText>
        {` · ${title} · ${span}`}
      </AppText>
      <AppText variant="small" style={{ color: palette.brass, fontFamily: fonts.bodySemi }}>
        {open ? t('runs.quietHide') : t('runs.quietShow')}
      </AppText>
    </Pressable>
  )
}

/**
 * A bot's routine runs, each in a conversation of its own: its history by day, newest first, the runs of a routine
 * that found nothing new folded, and a filter by routine. Opening a run shows its whole conversation.
 */
export function RunsPane({ bot, onOpen }: { bot: FleetBot; onOpen: (run: FleetRoutineRun) => void }) {
  const { palette } = useTheme()
  const { t, plural, locale } = useI18n()
  const controller = useFleetController()
  const runsState = useFleet(useCallback((state: FleetState) => state.runs[bot.id] ?? emptyRuns, [bot.id]))
  const seenIds = useFleet(useCallback((state: FleetState) => state.seen.runs[bot.id] ?? null, [bot.id]))
  const [filter, setFilter] = useState<string | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [settings, setSettings] = useState(false)
  useEffect(() => controller.ensureRuns(bot.id), [controller, bot.id])

  const routines = useMemo(() => runRoutines(runsState.runs), [runsState.runs])
  const shown = useMemo(
    () => (filter ? runsState.runs.filter((run) => run.routineId === filter) : runsState.runs),
    [filter, runsState.runs]
  )
  const fresh = useMemo(
    () => new Set(seenIds ? unseenRuns(runsState.runs, new Set(seenIds), bot).map((run) => run.id) : []),
    [bot, runsState.runs, seenIds]
  )
  const rows = useMemo<Row[]>(() => {
    const now = Date.now()
    return runDays(shown, bot).flatMap((day) => {
      const kind = dayKind(day.day, now)
      const head: Row = {
        kind: 'head',
        key: `head:${day.key}`,
        text:
          kind === 'today'
            ? t('lanes.today')
            : kind === 'yesterday'
              ? t('lanes.yesterday')
              : formatDay(day.day, locale),
      }
      return [
        head,
        ...day.entries.flatMap((entry): Row[] =>
          entry.kind === 'run'
            ? [{ kind: 'run', key: entry.run.id, run: entry.run }]
            : [
                { kind: 'quiet', key: entry.key, entry, open: open.has(entry.key) },
                ...(open.has(entry.key)
                  ? entry.runs.map((run): Row => ({ kind: 'run', key: run.id, run, nested: true }))
                  : []),
              ]
        ),
      ]
    })
  }, [shown, bot, open, t, locale])
  const runSettings = runSettingsOf(bot)
  const retention =
    runSettings.retentionDays === null
      ? t('runs.retentionNever')
      : t('runs.retentionDays', { count: runSettings.retentionDays })

  const settingsButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('runs.settings.title')}
      accessibilityHint={retention}
      onPress={() => setSettings(true)}
      hitSlop={6}
      style={({ pressed }) => ({
        minHeight: 32,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: pressed ? palette.surface : palette.raised,
      })}
    >
      <Icon name="clock" size={14} color={palette.muted} />
      <AppText variant="small" tone="muted" style={{ fontSize: 12.5 }}>
        {retention}
      </AppText>
    </Pressable>
  )

  let body: ReactNode
  if (runsState.failed && !runsState.runs.length)
    body = <LoadFailed text={t('runs.loadFailed')} onRetry={() => void controller.reloadRuns(bot.id)} />
  else if (!runsState.loaded)
    body = (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={palette.muted} accessibilityLabel={t('common.loading')} />
      </View>
    )
  else if (!runsState.runs.length)
    body = <EmptyLane icon="history" title={t('runs.empty.title')} body={t('runs.empty.body', { name: bot.name })} />
  else
    body = (
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 8 }}
        renderItem={({ item: row }) =>
          row.kind === 'head' ? (
            <ListHead text={row.text} />
          ) : row.kind === 'quiet' ? (
            <QuietRow
              entry={row.entry}
              open={row.open}
              onToggle={() =>
                setOpen((current) => {
                  const next = new Set(current)
                  if (!next.delete(row.key)) next.add(row.key)
                  return next
                })
              }
            />
          ) : (
            <RunRow
              bot={bot}
              run={row.run}
              fresh={fresh.has(row.run.id)}
              nested={row.nested}
              onOpen={() => onOpen(row.run)}
            />
          )
        }
        onEndReached={() => controller.loadOlderRuns(bot.id)}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          <View style={{ paddingTop: 10, gap: 10, alignItems: 'center' }}>
            {runsState.loading ? <ActivityIndicator color={palette.muted} /> : null}
            <AppText variant="small" tone="faint" style={{ textAlign: 'center', paddingHorizontal: 12 }}>
              {[
                t('runs.footer', { name: bot.name }),
                runSettings.quietEarly ? plural('runs.footerQuiet', FLEET_ROUTINE_RUN_LIMITS.quietRetentionDays) : null,
              ]
                .filter(Boolean)
                .join(' ')}
            </AppText>
          </View>
        }
      />
    )

  return (
    <View style={{ flex: 1 }}>
      {runsState.loaded && runsState.runs.length ? (
        routines.length > 1 ? (
          <ChipRow
            label={t('runs.filters')}
            options={[
              { value: null, label: t('runs.all'), count: runsState.runs.length },
              ...routines.map((routine) => ({
                value: routine.id,
                label: routine.title || t('lanes.routine'),
                count: routine.count,
              })),
            ]}
            value={filter}
            onChange={setFilter}
            trailing={settingsButton}
          />
        ) : (
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              paddingHorizontal: 8,
              paddingVertical: 6,
              borderBottomWidth: 1,
              borderBottomColor: palette.line,
            }}
          >
            {settingsButton}
          </View>
        )
      ) : null}
      {body}
      <RunSettingsSheet bot={bot} open={settings} onClose={() => setSettings(false)} />
    </View>
  )
}
