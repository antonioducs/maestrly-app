import type { FleetBot, FleetFileSettings, FleetPublishedFile } from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Pressable, ScrollView, Switch, TextInput, View } from 'react-native'
import { DEMO_SERVER } from '../../demo/demo-source'
import {
  FILE_CATEGORIES,
  FILES_PAGE,
  fileCategory,
  filesLevel,
  formatSpace,
  scopedFiles,
  visibleFiles,
  type FileCategory,
  type FileSort,
  type FilesScope,
} from '../../fleet/files'
import { useFleetController } from '../../fleet/react'
import { useI18n } from '../../i18n'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { confirm } from '../confirm'
import { botFileAccess, FileIssue, forgetCachedBotFile, shareBotFile } from '../conversation/bot-file-fetch'
import { fileRevealKey, revealFile } from '../conversation/file-reveal'
import { Icon } from '../icons'
import { openLaneScreen } from '../lanes/LaneView'
import { Button } from '../primitives/Button'
import { Cell } from '../primitives/Cell'
import { Group } from '../primitives/Group'
import { Segmented } from '../primitives/Segmented'
import { SwipeToDelete } from '../primitives/SwipeToDelete'
import { AppText } from '../primitives/Text'
import { SheetScreen } from '../SheetScreen'
import { useNow } from '../useNow'
import { FileActionsSheet, QuotaSheet, SortSheet } from './FileSheets'
import { FileRow } from './FileRow'
import { UsageCard } from './UsageCard'
import { useBotFiles } from './use-bot-files'

const GIB = 1024 ** 3
/** How long the sheets take to close before the conversation under them takes over. */
const AFTER_DISMISS_MS = 350
const NOTICE_MS = 4200

type Issue = { text: string; muted?: boolean }

/**
 * What a bot shared, with the space it takes: search, types, order and "Show more" over its files, their actions,
 * swiping a file away, selecting several, and the space and cleanup of the bot's files.
 */
export function BotFilesScreen({ bot, from }: { bot: FleetBot; from?: 'conversation' }) {
  const { palette } = useTheme()
  const { t, plural, locale } = useI18n()
  const controller = useFleetController()
  const { active } = useServers()
  const { supported, state, usage } = useBotFiles(bot)
  const now = useNow(true, 60_000)
  const access = botFileAccess(controller, bot.id, active?.id === DEMO_SERVER.id)

  const [scope, setScope] = useState<FilesScope>(from === 'conversation' ? 'conversation' : 'bot')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<FileCategory | 'all'>('all')
  const [sort, setSort] = useState<FileSort>(from === 'conversation' ? 'size' : 'recent')
  const [shown, setShown] = useState(FILES_PAGE)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [swiped, setSwiped] = useState<string | null>(null)
  const [sheet, setSheet] = useState<null | { kind: 'actions'; fileId: string } | { kind: 'sort' } | { kind: 'quota' }>(
    null
  )
  // The file whose actions show, kept while their sheet closes.
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [issue, setIssue] = useState<Issue | null>(null)
  const [busy, setBusy] = useState(false)
  const [downloads, setDownloads] = useState<Record<string, number | null>>({})
  const [pendingCleanup, setPendingCleanup] = useState<boolean | null>(null)

  const files = state?.list?.files ?? []
  const scoped = useMemo(() => scopedFiles(files, scope), [files, scope])
  const list = useMemo(
    () => visibleFiles(files, { scope, query, category, sort }, locale),
    [files, scope, query, category, sort, locale]
  )
  const items = list.slice(0, shown)
  const visible = useMemo(() => new Set(list.map((file) => file.id)), [list])
  const filtering = scope !== 'bot' || category !== 'all' || query.trim() !== ''
  const chosen = files.filter((file) => selected.has(file.id))
  const chosenBytes = chosen.reduce((sum, file) => sum + file.byteSize, 0)

  useEffect(() => setShown(FILES_PAGE), [scope, query, category, sort])
  // Files deleted elsewhere leave the selection.
  useEffect(() => {
    setSelected((current) => {
      const kept = new Set([...current].filter((id) => files.some((file) => file.id === id)))
      return kept.size === current.size ? current : kept
    })
  }, [files])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const title = t('files.title')
  const done = () => router.back()
  if (!supported)
    return (
      <SheetScreen title={title} onDone={done}>
        <AppText tone="muted" style={{ marginTop: 12, marginHorizontal: 4 }}>
          {t('files.updateRequired')}
        </AppText>
      </SheetScreen>
    )
  if (!state?.loaded || !usage)
    return (
      <SheetScreen title={title} onDone={done}>
        {state?.failed ? (
          <View style={{ alignItems: 'center', gap: 10, paddingVertical: 32 }}>
            <AppText accessibilityRole="alert" tone="muted" style={{ textAlign: 'center' }}>
              {t('files.loadFailed')}
            </AppText>
            <Pressable accessibilityRole="button" onPress={() => void controller.reloadFiles(bot.id)} hitSlop={10}>
              <AppText style={{ color: palette.brass, fontFamily: fonts.bodySemi }}>{t('common.tryAgain')}</AppText>
            </Pressable>
          </View>
        ) : (
          <ActivityIndicator color={palette.muted} accessibilityLabel={t('common.loading')} style={{ marginTop: 32 }} />
        )}
      </SheetScreen>
    )

  const level = filesLevel(usage)
  const quotaGb = Math.min(20, Math.max(1, Math.round(usage.quotaBytes / GIB)))
  const others = files.filter((file) => file.origin.kind !== 'primary')
  const actionsFile = files.find((file) => file.id === actionsFor) ?? null

  const failure = (cause: unknown) => (cause instanceof Error ? cause.message : t('outbox.error.generic'))

  async function askDelete(ids: string[]) {
    const doomed = files.filter((file) => ids.includes(file.id))
    if (!doomed.length) return
    const size = formatSpace(
      doomed.reduce((sum, file) => sum + file.byteSize, 0),
      locale
    )
    const sure = await confirm({
      title:
        doomed.length === 1
          ? t('files.confirm.one', { name: doomed[0]!.name })
          : t('files.confirm.many', { count: doomed.length }),
      message: t('files.confirm.body', { size, name: bot.name }),
      confirmLabel: t('files.confirm.action'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    })
    if (!sure) return
    setBusy(true)
    setIssue(null)
    try {
      const result = await controller.deleteFiles(
        bot.id,
        doomed.map((file) => file.id)
      )
      for (const file of doomed) if (result.deleted.includes(file.id)) forgetCachedBotFile(access, file)
      setSelected(new Set())
      setSelecting(false)
      setSwiped(null)
      const freed = formatSpace(result.freedBytes, locale)
      const text =
        result.deleted.length === 1
          ? t('files.deletedOne', {
              name: doomed.find((file) => file.id === result.deleted[0])?.name ?? doomed[0]!.name,
              size: freed,
            })
          : t('files.deletedMany', { count: result.deleted.length, size: freed })
      setNotice(text)
      AccessibilityInfo.announceForAccessibility(text)
    } catch (cause) {
      setIssue({ text: t('files.deleteFailed', { message: failure(cause) }) })
    } finally {
      setBusy(false)
    }
  }

  /** Downloads each file in turn and hands it to the system's share menu. */
  async function download(targets: FleetPublishedFile[]) {
    setIssue(null)
    for (const file of targets) {
      setDownloads((current) => ({ ...current, [file.id]: null }))
      try {
        await shareBotFile(access, file, {
          onProgress: (share) => setDownloads((current) => ({ ...current, [file.id]: share })),
        })
      } catch (cause) {
        const kind = cause instanceof FileIssue ? cause.issue : 'offline'
        setIssue({ text: t(`botFiles.error.${kind}`), muted: kind === 'demo' })
        break
      } finally {
        setDownloads(({ [file.id]: _, ...rest }) => rest)
      }
    }
  }

  function showInConversation(file: FleetPublishedFile) {
    const origin = file.origin
    const serverId = controller.source.serverId
    if (origin.kind === 'primary') {
      revealFile(fileRevealKey(serverId, bot.id), file.id)
      router.dismissTo('/home')
      return
    }
    if ((origin.kind === 'routine' || origin.kind === 'thread') && !file.originGone) {
      const lane =
        origin.kind === 'routine'
          ? { kind: 'run' as const, id: origin.runId }
          : { kind: 'thread' as const, id: origin.threadId }
      revealFile(fileRevealKey(serverId, bot.id, lane.id), file.id)
      router.dismissTo('/home')
      // The lane opens over the bot's conversation once the sheets have closed.
      setTimeout(() => openLaneScreen(bot.id, lane), AFTER_DISMISS_MS)
    }
  }

  /** The order an alert asks for: the files that free the most first, or the oldest of the whole bot. */
  function sortFromAlert(next: FileSort, all?: boolean) {
    setSort(next)
    setQuery('')
    setCategory('all')
    if (all) setScope('bot')
  }

  async function saveSettings(settings: FleetFileSettings) {
    setIssue(null)
    try {
      await controller.saveFileSettings(bot.id, settings)
    } catch (cause) {
      setIssue({ text: t('files.limits.failed', { message: failure(cause) }) })
    }
  }

  function pressRow(file: FleetPublishedFile) {
    if (swiped) return setSwiped(null)
    if (selecting) {
      const next = new Set(selected)
      if (next.has(file.id)) next.delete(file.id)
      else next.add(file.id)
      setSelected(next)
      return
    }
    setActionsFor(file.id)
    setSheet({ kind: 'actions', fileId: file.id })
  }

  function toggleSelecting() {
    setSwiped(null)
    if (selecting) setSelected(new Set())
    setSelecting(!selecting)
  }

  const allShownSelected = items.length > 0 && items.every((file) => selected.has(file.id))
  const categories = FILE_CATEGORIES.filter((value) => scoped.some((file) => fileCategory(file) === value))

  const selectionBar = selecting ? (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 14,
        backgroundColor: palette.raised,
        borderWidth: 1,
        borderColor: palette.line,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }} accessibilityLiveRegion="polite">
        <AppText numberOfLines={1} style={{ fontFamily: fonts.bodySemi, fontSize: 15 }}>
          {chosen.length ? plural('files.selected', chosen.length) : t('files.selectHint')}
        </AppText>
        {chosen.length ? (
          <AppText variant="mono" tone="muted" style={{ fontSize: 12 }}>
            {formatSpace(chosenBytes, locale)}
          </AppText>
        ) : null}
      </View>
      <Button
        size="sm"
        variant="secondary"
        icon="arrow-down"
        label={t('files.download')}
        accessibilityLabel={t('files.downloadSelected')}
        disabled={!chosen.length || busy}
        onPress={() => void download(chosen)}
      />
      <Button
        size="sm"
        variant="danger"
        icon="trash"
        label={t('files.delete')}
        disabled={!chosen.length}
        busy={busy}
        onPress={() => void askDelete(chosen.map((file) => file.id))}
      />
    </View>
  ) : undefined

  const issueLine = issue ? (
    <AppText
      accessibilityRole="alert"
      variant="small"
      style={{ marginTop: 10, marginHorizontal: 6, color: issue.muted ? palette.muted : palette.brick }}
    >
      {issue.text}
    </AppText>
  ) : null

  const limits = (
    <Group label={t('files.limits.label')} foot={t('files.limits.foot', { max: usage.countMax })}>
      <Cell
        icon="folder"
        label={t('files.limits.quota')}
        value={`${quotaGb} GB`}
        chevron
        onPress={() => setSheet({ kind: 'quota' })}
      />
      <Cell
        icon="trash"
        label={t('files.limits.cleanup')}
        sub={t('files.limits.cleanupSub')}
        trailing={
          <Switch
            accessibilityLabel={t('files.limits.cleanup')}
            value={pendingCleanup ?? usage.deleteWithConversations}
            onValueChange={(value) => {
              setPendingCleanup(value)
              void saveSettings({ quotaGb, deleteWithConversations: value }).finally(() => setPendingCleanup(null))
            }}
            trackColor={{ true: palette.brass, false: palette.lineStrong }}
          />
        }
      />
    </Group>
  )

  const sheets = (
    <>
      <FileActionsSheet
        file={actionsFile}
        open={sheet?.kind === 'actions'}
        now={now}
        onClose={() => setSheet(null)}
        onDownload={(file) => void download([file])}
        onShow={showInConversation}
        onDelete={(file) => void askDelete([file.id])}
      />
      <SortSheet open={sheet?.kind === 'sort'} value={sort} onChange={setSort} onClose={() => setSheet(null)} />
      <QuotaSheet
        open={sheet?.kind === 'quota'}
        bot={bot}
        usage={usage}
        diskFreeBytes={state.list?.diskFreeBytes ?? null}
        onChoose={(gb) => void saveSettings({ quotaGb: gb, deleteWithConversations: usage.deleteWithConversations })}
        onClose={() => setSheet(null)}
      />
    </>
  )

  const card = (
    <UsageCard
      bot={bot}
      usage={usage}
      files={files}
      selected={selected}
      filtering={filtering}
      visible={visible}
      onSort={sortFromAlert}
    />
  )

  if (!files.length)
    return (
      <SheetScreen title={title} onDone={done}>
        <AppText variant="sub" tone="muted" style={{ marginHorizontal: 4 }}>
          {t('files.intro', { name: bot.name })}
        </AppText>
        {card}
        {issueLine}
        <View
          style={{
            marginTop: 18,
            paddingVertical: 34,
            paddingHorizontal: 20,
            borderRadius: 14,
            backgroundColor: palette.group,
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Icon name="folder" size={28} color={palette.muted} />
          <AppText style={{ marginTop: 6, fontFamily: fonts.bodySemi, fontSize: 17 }}>{t('files.empty.title')}</AppText>
          <AppText tone="muted" style={{ textAlign: 'center', fontSize: 14, lineHeight: 20 }}>
            {t('files.empty.body', { name: bot.name })}
          </AppText>
        </View>
        {limits}
        {sheets}
      </SheetScreen>
    )

  const chip = (value: FileCategory | 'all', label: string, count: number) => {
    const on = category === value
    return (
      <Pressable
        key={value}
        accessibilityRole="radio"
        aria-checked={on}
        accessibilityLabel={`${label}, ${count}`}
        onPress={() => setCategory(value)}
        style={{
          minHeight: 32,
          paddingHorizontal: 12,
          borderRadius: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          backgroundColor: on ? palette.ink : palette.surface,
        }}
      >
        <AppText variant="bodyMedium" style={{ fontSize: 13.5, color: on ? palette.canvas : palette.ink }}>
          {label}
        </AppText>
        <AppText
          variant="mono"
          style={{ fontSize: 11.5, color: on ? mix(palette.canvas, palette.ink, 0.65) : palette.muted }}
        >
          {count}
        </AppText>
      </Pressable>
    )
  }
  const textButton = (label: string, onPress: () => void, accessibilityLabel?: string, chevron = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        minHeight: 32,
        paddingHorizontal: 8,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: pressed ? palette.surface : 'transparent',
      })}
    >
      <AppText style={{ color: palette.brass, fontFamily: fonts.bodySemi, fontSize: 14 }}>{label}</AppText>
      {chevron ? <Icon name="chev-updown" size={15} color={palette.brass} /> : null}
    </Pressable>
  )
  const link = (label: string, onPress: () => void) => (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
      <AppText style={{ color: palette.brass, fontFamily: fonts.bodySemi, fontSize: 13.5 }}>{label}</AppText>
    </Pressable>
  )
  const rest = list.length - items.length
  const othersBytes = others.reduce((sum, file) => sum + file.byteSize, 0)

  return (
    <SheetScreen title={title} onDone={done} accessory={selectionBar}>
      <AppText variant="sub" tone="muted" style={{ marginHorizontal: 4 }}>
        {t('files.intro', { name: bot.name })}
      </AppText>
      {card}
      {issueLine}
      {notice ? (
        <View
          accessibilityRole="alert"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginTop: 12,
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderRadius: 12,
            backgroundColor: mix(palette.moss, palette.group, 0.12),
          }}
        >
          <Icon name="check" size={17} color={palette.moss} />
          <AppText style={{ flex: 1, fontSize: 13.5, lineHeight: 18 }}>{notice}</AppText>
        </View>
      ) : null}
      <View style={{ marginTop: 14 }}>
        <Segmented
          label={t('files.scope.label')}
          options={[
            {
              value: 'conversation' as const,
              label: t('files.scope.conversation'),
              count: scopedFiles(files, 'conversation').length,
            },
            { value: 'bot' as const, label: t('files.scope.bot'), count: files.length },
          ]}
          value={scope}
          onChange={setScope}
        />
      </View>
      {scope === 'conversation' && level !== 'ok' && others.length ? (
        <View style={{ marginTop: 8, marginHorizontal: 6, gap: 2 }}>
          <AppText variant="small" tone="muted" style={{ fontSize: 13, lineHeight: 18 }}>
            {plural('files.others', others.length, { size: formatSpace(othersBytes, locale) })}
          </AppText>
          <View style={{ alignSelf: 'flex-start' }}>{link(t('files.seeAll'), () => setScope('bot'))}</View>
        </View>
      ) : null}
      <View
        style={{
          marginTop: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: 40,
          paddingHorizontal: 10,
          borderRadius: 11,
          backgroundColor: palette.surface,
        }}
      >
        <Icon name="search" size={17} color={palette.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('files.search')}
          placeholderTextColor={palette.faint}
          accessibilityLabel={t('files.search')}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          style={{ flex: 1, minWidth: 0, height: 40, color: palette.ink, fontFamily: fonts.body, fontSize: 16 }}
        />
        {query ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('files.clearSearch')}
            onPress={() => setQuery('')}
            hitSlop={10}
            style={{
              width: 20,
              height: 20,
              borderRadius: 10,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: palette.faint,
            }}
          >
            <Icon name="x" size={12} color={palette.sheet} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('files.category.label')}
        style={{ marginTop: 10, marginHorizontal: -16 }}
        contentContainerStyle={{ gap: 6, paddingHorizontal: 16 }}
      >
        {chip('all', t('files.category.all'), scoped.length)}
        {categories.map((value) =>
          chip(value, t(`files.category.${value}`), scoped.filter((file) => fileCategory(file) === value).length)
        )}
      </ScrollView>
      <View
        style={{
          marginTop: 16,
          marginBottom: 7,
          marginLeft: 6,
          marginRight: 2,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <AppText variant="label" tone="muted" style={{ flex: 1 }}>
          {list.length === scoped.length
            ? plural('files.total', list.length)
            : t('files.shownOf', { shown: list.length, total: scoped.length })}
        </AppText>
        {selecting
          ? textButton(allShownSelected ? t('files.selectNone') : t('files.selectAll'), () => {
              const next = new Set(selected)
              for (const file of items) {
                if (allShownSelected) next.delete(file.id)
                else next.add(file.id)
              }
              setSelected(next)
            })
          : textButton(
              t(`files.sortShort.${sort}`),
              () => setSheet({ kind: 'sort' }),
              `${t('files.sort.label')}: ${t(`files.sort.${sort}`)}`,
              true
            )}
        {textButton(selecting ? t('files.selectCancel') : t('files.select'), toggleSelecting)}
      </View>
      <Group>
        {items.map((file) => (
          <SwipeToDelete
            key={file.id}
            open={swiped === file.id}
            onOpenChange={(open) => setSwiped(open ? file.id : null)}
            label={t('files.deleteNamed', { name: file.name })}
            short={t('files.delete')}
            disabled={selecting}
            onDelete={() => void askDelete([file.id])}
          >
            <FileRow
              file={file}
              selecting={selecting}
              selected={selected.has(file.id)}
              progress={file.id in downloads ? downloads[file.id] : undefined}
              onPress={() => pressRow(file)}
              onLongPress={() => {
                setSwiped(null)
                setSelecting(true)
                setSelected(new Set([file.id]))
              }}
              onDelete={() => void askDelete([file.id])}
              locale={locale}
              now={now}
            />
          </SwipeToDelete>
        ))}
        {rest > 0 ? (
          <Cell
            center
            tone="brass"
            label={t('files.more', { count: Math.min(FILES_PAGE, rest) })}
            onPress={() => setShown((value) => value + FILES_PAGE)}
          />
        ) : null}
        {items.length === 0 ? (
          <View style={{ alignItems: 'center', gap: 6, paddingVertical: 22, paddingHorizontal: 14 }}>
            <AppText tone="muted" style={{ fontSize: 14, textAlign: 'center' }}>
              {scoped.length ? t('files.noMatch') : t('files.emptyConversation')}
            </AppText>
            {scoped.length
              ? link(t('files.clearFilters'), () => {
                  setQuery('')
                  setCategory('all')
                })
              : link(t('files.seeAll'), () => setScope('bot'))}
          </View>
        ) : null}
      </Group>
      {limits}
      {sheets}
    </SheetScreen>
  )
}
