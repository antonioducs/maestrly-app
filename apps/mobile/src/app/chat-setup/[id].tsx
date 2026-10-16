import type {
  FleetSelectionOption,
  MobileChatMode,
  MobileChatSetup,
  MobileChatSetupPatch,
  MobileConversation,
  MobilePermMode,
} from '@maestrly/bot-fleet-protocol'
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Switch, TextInput, View } from 'react-native'
import { useChats, useChatsController } from '../../chats/react'
import { chatEffortChoices, optionFor, parseTokenCount } from '../../chats/selectors'
import { allConversations, type ChatsState } from '../../chats/state'
import { effortLabel, formatTokens } from '../../fleet/format'
import { useI18n } from '../../i18n'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { MODE_ICON } from '../../ui/chat/ChatSetupPill'
import { confirm } from '../../ui/confirm'
import { shownError } from '../../ui/conversation/CueCard'
import { Icon, type IconName } from '../../ui/icons'
import { Button } from '../../ui/primitives/Button'
import { Cell } from '../../ui/primitives/Cell'
import { Group } from '../../ui/primitives/Group'
import { Pills } from '../../ui/primitives/Pills'
import { Segmented } from '../../ui/primitives/Segmented'
import { AppText } from '../../ui/primitives/Text'
import { ModelList } from '../../ui/sheets/ModelList'
import { SheetScreen } from '../../ui/SheetScreen'

type Page = 'root' | 'model' | 'skills' | 'mcp' | 'limit' | 'rename'
const MODES: MobileChatMode[] = ['agent', 'design', 'plan', 'ask']
const PERMS: { id: MobilePermMode; icon: IconName }[] = [
  { id: 'ask', icon: 'hand' },
  { id: 'auto', icon: 'terminal' },
  { id: 'full', icon: 'shield' },
]
const ULTRA = new Set(['ultra', 'maestrly-ultra'])

function SwitchCell({
  icon,
  label,
  sub,
  value,
  disabled,
  onChange,
}: {
  icon?: IconName
  label: string
  sub?: string
  value: boolean
  disabled: boolean
  onChange: (value: boolean) => void
}) {
  const { palette } = useTheme()
  return (
    <Cell
      icon={icon}
      label={label}
      sub={sub}
      trailing={
        <Switch
          accessibilityLabel={label}
          value={value}
          disabled={disabled}
          onValueChange={onChange}
          trackColor={{ true: palette.brass, false: palette.lineStrong }}
        />
      }
    />
  )
}

function Setup({ chat, setup, initialPage }: { chat: MobileConversation; setup: MobileChatSetup; initialPage: Page }) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const chats = useChatsController()
  const { active, setCurrent } = useServers()
  const models = useChats(useCallback((state: ChatsState) => state.models, []))
  const runtime = useChats(useCallback((state: ChatsState) => state.views[chat.id]?.runtime ?? null, [chat.id]))
  const online = useChats(useCallback((state: ChatsState) => state.bridge === 'open', []))
  const [page, setPage] = useState<Page>(initialPage)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limitText, setLimitText] = useState('')
  const [name, setName] = useState(chat.name)
  const options = models?.options ?? []
  const option = optionFor(options, setup.selection)
  const defaultOption = optionFor(options, models?.defaultSelection ?? null)
  const model = option ?? (setup.selection ? null : defaultOption)
  const maestro = setup.experience === 'maestro'
  const busy = saving !== null || !online
  const working = !!runtime?.streaming

  useEffect(() => {
    void chats.loadModels().catch(() => {})
  }, [chats])

  async function save(key: string, patch: MobileChatSetupPatch) {
    setSaving(key)
    setError(null)
    try {
      await chats.patchSetup(chat.id, patch)
      return true
    } catch (cause) {
      setError(shownError(cause, t('outbox.error.generic')))
      return false
    } finally {
      setSaving(null)
    }
  }

  /** A model change keeps the effort and Fast only where the new model has them, as the desktop does. */
  function pickModel(picked: FleetSelectionOption | null) {
    if (!picked) return
    const efforts = chatEffortChoices(picked)
    const patch: MobileChatSetupPatch = { selection: { providerId: picked.providerId, modelId: picked.modelId } }
    if (!ULTRA.has(setup.reasoning) && setup.reasoning !== 'off' && !efforts.includes(setup.reasoning))
      patch.reasoning = 'off'
    if (ULTRA.has(setup.reasoning) && efforts.length === 0) patch.reasoning = 'off'
    if (setup.fastMode && !picked.fastMode) patch.fastMode = false
    void save('model', patch).then((ok) => ok && setPage('root'))
  }

  async function setPerm(permMode: MobilePermMode) {
    if (permMode === setup.permMode) return
    if (permMode === 'full') {
      const sure = await confirm({
        title: t('chat.setup.fullTitle'),
        message: t('setup.fullBody'),
        confirmLabel: t('setup.fullConfirm'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      })
      if (!sure) return
    }
    if (await save('perm', { permMode })) AccessibilityInfo.announceForAccessibility(t(`ceiling.${permMode}.label`))
  }

  async function compact() {
    setSaving('compact')
    setError(null)
    try {
      await chats.compact(chat.id)
      AccessibilityInfo.announceForAccessibility(t('chat.setup.compacting'))
    } catch (cause) {
      setError(shownError(cause, t('outbox.error.generic')))
    } finally {
      setSaving(null)
    }
  }

  async function archive() {
    const sure = await confirm({
      title: t('chat.setup.archiveTitle', { name: chat.name }),
      message: t('chat.setup.archiveBody'),
      confirmLabel: t('chat.setup.archive'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    })
    if (!sure) return
    setSaving('archive')
    try {
      await chats.archive(chat.id)
      setCurrent(null)
      router.back()
    } catch (cause) {
      setError(shownError(cause, t('outbox.error.generic')))
      setSaving(null)
    }
  }

  const errorLine = error ? (
    <AppText
      accessibilityRole="alert"
      style={{ marginTop: 10, marginHorizontal: 6, fontSize: 13, color: palette.brick }}
    >
      {error}
    </AppText>
  ) : null
  const back = { label: t('chat.setup.title'), onPress: () => setPage('root') }

  if (page === 'model')
    return (
      <SheetScreen title={t('setup.model')} onDone={() => router.back()} back={back}>
        {errorLine}
        <ModelList
          options={options}
          current={setup.selection}
          disabled={busy}
          onPick={pickModel}
          defaultChoice={null}
          foot={t('chat.setup.modelsFoot', { server: active?.name ?? '' })}
          ultra
        />
      </SheetScreen>
    )

  if (page === 'skills') {
    const on = setup.skills.filter((skill) => skill.enabled).length
    return (
      <SheetScreen title={t('chat.setup.skills')} onDone={() => router.back()} back={back}>
        <AppText variant="sub" tone="muted" style={{ marginTop: 6, marginHorizontal: 6 }}>
          {t('chat.setup.skillsCount', { on, total: setup.skills.length })}
        </AppText>
        {errorLine}
        <Group foot={t('chat.setup.skillsFoot')}>
          {setup.skills.length === 0 ? (
            <AppText variant="sub" tone="muted" style={{ padding: 14 }}>
              {t('chat.setup.noSkills')}
            </AppText>
          ) : null}
          {setup.skills.map((skill) => (
            <SwitchCell
              key={skill.name}
              label={skill.name}
              sub={
                skill.override
                  ? t('chat.setup.changed')
                  : skill.enabled
                    ? t('chat.setup.onDefault')
                    : t('chat.setup.offDefault')
              }
              value={skill.enabled}
              disabled={busy}
              onChange={(value) =>
                void save(`skill:${skill.name}`, { skill: { name: skill.name, state: value ? 'on' : 'off' } })
              }
            />
          ))}
        </Group>
        {setup.skills.some((skill) => skill.override) ? (
          <Group>
            <Cell
              label={t('chat.setup.resetSkills')}
              tone="brass"
              disabled={busy}
              onPress={() => void save('skills', { skillsReset: true })}
            />
          </Group>
        ) : null}
      </SheetScreen>
    )
  }

  if (page === 'mcp')
    return (
      <SheetScreen title={t('chat.setup.mcp')} onDone={() => router.back()} back={back}>
        {errorLine}
        <Group
          foot={
            setup.mode === 'plan' || setup.mode === 'ask'
              ? t('chat.setup.mcpReadOnly', { mode: t(`chat.mode.${setup.mode}`) })
              : t('chat.setup.mcpFoot')
          }
        >
          {setup.mcp.length === 0 ? (
            <AppText variant="sub" tone="muted" style={{ padding: 14 }}>
              {t('chat.setup.noMcp')}
            </AppText>
          ) : null}
          {setup.mcp.map((server) => (
            <SwitchCell
              key={server.id}
              icon="plug"
              label={server.name}
              value={server.enabled}
              disabled={busy}
              onChange={(enabled) => void save(`mcp:${server.id}`, { mcp: { id: server.id, enabled } })}
            />
          ))}
        </Group>
      </SheetScreen>
    )

  if (page === 'limit' && setup.contextLimit) {
    const window = setup.contextLimit.window
    const presets = [null, 100_000, 200_000, 400_000].filter((value) => value === null || !window || value < window)
    const parsed = parseTokenCount(limitText)
    const valid = parsed !== null && parsed >= 20_000 && (!window || parsed <= window)
    return (
      <SheetScreen title={t('chat.setup.limit')} onDone={() => router.back()} back={back}>
        <AppText variant="sub" tone="muted" style={{ marginTop: 6, marginHorizontal: 6, lineHeight: 19 }}>
          {window ? t('chat.setup.limitNote', { window: formatTokens(window) }) : t('chat.setup.limitNoteNoWindow')}
        </AppText>
        {errorLine}
        <Group>
          {presets.map((value) => (
            <Cell
              key={String(value)}
              label={value ? formatTokens(value) : t('chat.setup.noLimit')}
              sub={
                value
                  ? t('chat.setup.compactsAt', { tokens: formatTokens(value * 0.9) })
                  : window
                    ? t('chat.setup.fullWindow', { window: formatTokens(window) })
                    : undefined
              }
              role="radio"
              checked={(setup.contextLimit?.limit ?? null) === value}
              disabled={busy}
              onPress={() => void save('limit', { contextLimit: value })}
            />
          ))}
        </Group>
        <Group label={t('chat.setup.customLimit')}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10 }}>
            <TextInput
              value={limitText}
              onChangeText={setLimitText}
              placeholder="150k"
              placeholderTextColor={palette.faint}
              accessibilityLabel={t('chat.setup.customLimit')}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                flex: 1,
                height: 44,
                paddingHorizontal: 12,
                borderRadius: 10,
                backgroundColor: palette.surface,
                color: palette.ink,
                fontFamily: fonts.body,
                fontSize: 16,
              }}
            />
            <Button
              label={t('chat.setup.set')}
              variant="secondary"
              disabled={!valid || busy}
              onPress={() => void save('limit', { contextLimit: parsed }).then((ok) => ok && setLimitText(''))}
            />
          </View>
        </Group>
        <AppText
          variant="small"
          tone={limitText && !valid ? 'cue' : 'muted'}
          style={{ marginTop: 8, marginHorizontal: 6 }}
        >
          {t('chat.setup.limitHelp', { max: window ? formatTokens(window) : '—' })}
        </AppText>
      </SheetScreen>
    )
  }

  if (page === 'rename')
    return (
      <SheetScreen title={t('chat.setup.rename')} onDone={() => router.back()} back={back}>
        {errorLine}
        <Group>
          <View style={{ padding: 10 }}>
            <TextInput
              value={name}
              onChangeText={setName}
              autoFocus
              maxLength={200}
              accessibilityLabel={t('chat.setup.name')}
              returnKeyType="done"
              style={{
                height: 44,
                paddingHorizontal: 12,
                borderRadius: 10,
                backgroundColor: palette.surface,
                color: palette.ink,
                fontFamily: fonts.body,
                fontSize: 16,
              }}
            />
          </View>
        </Group>
        <Button
          label={t('chat.setup.save')}
          disabled={!name.trim() || name.trim() === chat.name || busy}
          busy={saving === 'rename'}
          style={{ marginTop: 14 }}
          onPress={() => {
            setSaving('rename')
            setError(null)
            chats
              .rename(chat.id, name.trim())
              .then(() => setPage('root'))
              .catch((cause) => setError(shownError(cause, t('outbox.error.generic'))))
              .finally(() => setSaving(null))
          }}
        />
      </SheetScreen>
    )

  const efforts = chatEffortChoices(model)
  const ultraValue = setup.ultra === 'native' ? 'ultra' : 'maestrly-ultra'
  const context = runtime?.context ?? null
  const share = context?.windowTokens ? Math.min(1, context.usedTokens / context.windowTokens) : null
  const canCompact = online && !working && !runtime?.compacting && (context?.usedTokens ?? 0) >= 20_000
  const compactSub = runtime?.compacting
    ? t('chat.setup.compacting')
    : working
      ? t('chat.setup.compactWorking')
      : !online
        ? t('chat.setup.compactOffline')
        : (context?.usedTokens ?? 0) < 20_000
          ? t('chat.setup.compactSmall')
          : t('chat.setup.compactSub')
  const skillsOn = setup.skills.filter((skill) => skill.enabled).length
  // Accounts of a server (`<serverId>#<accountId>`) are listed with it but are not servers.
  const mcpOn = setup.mcp.filter((server) => server.enabled && !server.id.includes('#')).length

  return (
    <SheetScreen title={t('chat.setup.title')} onDone={() => router.back()}>
      <AppText variant="sub" tone="muted" style={{ marginTop: 6, marginHorizontal: 6, fontSize: 13.5, lineHeight: 20 }}>
        {working ? t('chat.setup.noteWorking') : t('chat.setup.note')}
      </AppText>
      {errorLine}
      <Group label={t('setup.model')}>
        <Cell
          icon="sparkles"
          label={
            model
              ? setup.selection
                ? model.modelLabel
                : t('chat.setup.defaultModel', { model: model.modelLabel })
              : (setup.selection?.modelId ?? t('chat.setup.default'))
          }
          sub={model?.providerLabel ?? null}
          trailing={saving === 'model' ? <ActivityIndicator size="small" color={palette.muted} /> : null}
          chevron
          disabled={!online}
          onPress={() => setPage('model')}
        />
        {model?.fastMode ? (
          <SwitchCell
            icon="zap"
            label={t('setup.fast')}
            sub={t('setup.fastDesc')}
            value={setup.fastMode}
            disabled={busy}
            onChange={(fastMode) => void save('fast', { fastMode })}
          />
        ) : null}
      </Group>
      <Group label={t('setup.effort')}>
        {efforts.length ? (
          <>
            <Pills
              label={t('setup.effort')}
              value={ULTRA.has(setup.reasoning) ? null : setup.reasoning}
              disabled={busy}
              options={efforts.map((effort) => ({
                value: effort as string | null,
                label: effort === 'off' ? t('setup.effortDefault') : effortLabel(effort, t),
              }))}
              onChange={(reasoning) => reasoning && void save('effort', { reasoning })}
            />
            <Cell
              icon="sparkles"
              label={setup.ultra === 'native' ? t('chat.setup.ultra') : t('chat.setup.maestrlyUltra')}
              sub={setup.ultra === 'native' ? t('chat.setup.ultraNative') : t('chat.setup.ultraMaestrly')}
              role="radio"
              checked={ULTRA.has(setup.reasoning)}
              disabled={busy}
              onPress={() => void save('effort', { reasoning: ultraValue })}
            />
          </>
        ) : (
          <AppText variant="sub" tone="muted" style={{ padding: 14 }}>
            {t('setup.noEfforts', { model: model?.modelLabel ?? t('chat.setup.default') })}
          </AppText>
        )}
      </Group>
      {maestro ? (
        <Group label={t('chat.setup.mode')}>
          <Cell
            icon="sparkles"
            label={t('chat.mode.maestro')}
            sub={t('chat.setup.maestroSub', { model: model?.modelLabel ?? '' })}
          />
        </Group>
      ) : (
        <Group label={t('chat.setup.mode')}>
          <View style={{ padding: 10, gap: 8 }}>
            <Segmented
              label={t('chat.setup.mode')}
              value={setup.mode}
              options={MODES.map((mode) => ({ value: mode, label: t(`chat.mode.${mode}`), icon: MODE_ICON[mode] }))}
              onChange={(mode) => !busy && void save('mode', { mode })}
            />
            <AppText variant="sub" tone="muted" style={{ marginHorizontal: 4 }}>
              {t(`chat.modeDesc.${setup.mode}`)}
            </AppText>
          </View>
        </Group>
      )}
      {maestro ? null : (
        <Group label={t('setup.permissions')}>
          {PERMS.map((perm) => (
            <Cell
              key={perm.id}
              label={t(`ceiling.${perm.id}.label`)}
              sub={t(`chat.perm.${perm.id}`)}
              tone={perm.id === 'full' ? 'brick' : 'ink'}
              role="radio"
              checked={setup.permMode === perm.id}
              disabled={busy}
              leading={
                <View style={{ width: 22, alignItems: 'center' }}>
                  <Icon name={perm.icon} size={18} color={perm.id === 'full' ? palette.brick : palette.muted} />
                </View>
              }
              onPress={() => void setPerm(perm.id)}
            />
          ))}
        </Group>
      )}
      <Group label={t('details.context')}>
        <View
          accessible
          accessibilityLabel={
            context
              ? `${t('details.context')}: ${share !== null ? t('details.contextLabel', { percent: Math.round(share * 100) }) : formatTokens(context.usedTokens)}`
              : `${t('details.context')}: ${t('details.noUsage')}`
          }
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
            <AppText>
              {context
                ? context.windowTokens
                  ? t('details.tokens', {
                      used: formatTokens(context.usedTokens),
                      window: formatTokens(context.windowTokens),
                    })
                  : formatTokens(context.usedTokens)
                : t('details.noUsage')}
            </AppText>
            {share !== null ? (
              <View
                style={{
                  height: 6,
                  marginTop: 6,
                  borderRadius: 3,
                  overflow: 'hidden',
                  backgroundColor: palette.surface,
                }}
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
            {context?.quality === 'estimated' ? (
              <AppText variant="small" tone="muted" style={{ marginTop: 4 }}>
                {t('details.estimated')}
              </AppText>
            ) : null}
          </View>
        </View>
        {setup.contextLimit?.editable ? (
          <Cell
            icon="settings"
            label={t('chat.setup.limit')}
            value={setup.contextLimit.limit ? formatTokens(setup.contextLimit.limit) : t('chat.setup.noLimit')}
            chevron
            disabled={!online}
            onPress={() => setPage('limit')}
          />
        ) : null}
        <Cell
          icon="compress"
          label={t('chat.setup.compact')}
          sub={compactSub}
          tone="brass"
          disabled={!canCompact || saving !== null}
          trailing={
            saving === 'compact' || runtime?.compacting ? (
              <ActivityIndicator size="small" color={palette.muted} />
            ) : null
          }
          onPress={() => void compact()}
        />
      </Group>
      <Group
        label={t('chat.setup.tools')}
        foot={
          !maestro && (setup.mode === 'plan' || setup.mode === 'ask')
            ? t('chat.setup.toolsReadOnly', { mode: t(`chat.mode.${setup.mode}`) })
            : undefined
        }
      >
        <Cell
          icon="skills"
          label={t('chat.setup.skills')}
          value={t('chat.setup.skillsValue', { on: skillsOn, total: setup.skills.length })}
          chevron
          onPress={() => setPage('skills')}
        />
        <Cell
          icon="plug"
          label={t('chat.setup.mcp')}
          value={plural('chat.setup.mcpValue', mcpOn)}
          chevron
          onPress={() => setPage('mcp')}
        />
        <SwitchCell
          icon="branch"
          label={t('chat.setup.subagents')}
          sub={setup.tools.subagents ? t('chat.setup.subagentsOn') : t('chat.setup.subagentsOff')}
          value={setup.tools.subagents}
          disabled={busy}
          onChange={(subagents) => void save('subagents', { tools: { subagents } })}
        />
        <SwitchCell
          icon="image"
          label={t('chat.setup.imageGen')}
          sub={t('chat.setup.imageGenSub')}
          value={setup.tools.imageGen}
          disabled={busy}
          onChange={(imageGen) => void save('imageGen', { tools: { imageGen } })}
        />
        <SwitchCell
          icon="terminal"
          label={t('chat.setup.appTools')}
          sub={t('chat.setup.appToolsSub')}
          value={setup.tools.app}
          disabled={busy}
          onChange={(app) => void save('app', { tools: { app } })}
        />
      </Group>
      <Group label={t('chat.setup.chat')}>
        <Cell
          icon="pencil"
          label={t('chat.setup.rename')}
          sub={chat.name}
          chevron
          disabled={!online}
          onPress={() => setPage('rename')}
        />
        {chat.workspaceName ? <Cell icon="folder" label={chat.workspaceName} sub={chat.branch} /> : null}
        <Cell label={t('chat.setup.archive')} tone="brick" disabled={busy} onPress={() => void archive()} />
      </Group>
    </SheetScreen>
  )
}

function SetupFor({ id, page }: { id: string; page: Page }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const chats = useChatsController()
  const chat = useChats(
    useCallback(
      (state: ChatsState) =>
        state.views[id]?.conversation ?? allConversations(state.lists).find((item) => item.id === id) ?? null,
      [id]
    )
  )
  const setup = useChats(useCallback((state: ChatsState) => state.setups[id] ?? null, [id]))
  const online = useChats(useCallback((state: ChatsState) => state.bridge === 'open', []))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!online) return
    setFailed(false)
    void chats.loadSetup(id).catch(() => setFailed(true))
  }, [chats, id, online])
  if (chat && setup) return <Setup chat={chat} setup={setup} initialPage={page} />
  return (
    <SheetScreen title={t('chat.setup.title')} onDone={() => router.back()}>
      <View style={{ paddingVertical: 32, alignItems: 'center', gap: 10 }}>
        {failed || !online ? (
          <AppText tone="muted" style={{ textAlign: 'center' }}>
            {online ? t('chat.loadFailed') : t('chat.setup.offline')}
          </AppText>
        ) : (
          <ActivityIndicator color={palette.muted} accessibilityLabel={t('common.loading')} />
        )}
      </View>
    </SheetScreen>
  )
}

export default function ChatSetup() {
  const { id, page } = useLocalSearchParams<{ id: string; page?: string }>()
  const { chats } = useServers()
  if (!chats) return null
  return <SetupFor id={String(id)} page={page === 'model' ? 'model' : 'root'} />
}
