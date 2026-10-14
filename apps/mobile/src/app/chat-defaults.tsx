import type { FleetSelectionOption, MobileChatDefaults } from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Switch, View } from 'react-native'
import { useChats, useChatsController } from '../chats/react'
import { chatEffortChoices, optionFor } from '../chats/selectors'
import type { ChatsState } from '../chats/state'
import { effortLabel } from '../fleet/format'
import { useI18n } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { shownError } from '../ui/conversation/CueCard'
import { Cell } from '../ui/primitives/Cell'
import { Group } from '../ui/primitives/Group'
import { Pills } from '../ui/primitives/Pills'
import { AppText } from '../ui/primitives/Text'
import { ModelList } from '../ui/sheets/ModelList'
import { SheetScreen } from '../ui/SheetScreen'

/** What new chats of the server start with: their model, its effort and Fast. Each chat can change its own. */
function Defaults() {
  const { palette } = useTheme()
  const { t } = useI18n()
  const chats = useChatsController()
  const { active } = useServers()
  const online = useChats(useCallback((state: ChatsState) => state.bridge === 'open', []))
  const models = useChats(useCallback((state: ChatsState) => state.models, []))
  const [defaults, setDefaults] = useState<MobileChatDefaults | null>(null)
  const [page, setPage] = useState<'root' | 'model'>('root')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const server = active?.name ?? ''

  useEffect(() => {
    if (!online) return
    void chats.defaults().then(setDefaults, (cause) => setError(shownError(cause, t('outbox.error.generic'))))
    void chats.loadModels(true).catch(() => {})
  }, [chats, online, t])

  async function save(args: Parameters<typeof chats.setDefaults>[0]) {
    setSaving(true)
    setError(null)
    try {
      setDefaults(await chats.setDefaults(args))
      return true
    } catch (cause) {
      setError(shownError(cause, t('outbox.error.generic')))
      return false
    } finally {
      setSaving(false)
    }
  }

  const option = optionFor(models?.options ?? [], defaults?.selection ?? null)
  const errorLine = error ? (
    <AppText
      accessibilityRole="alert"
      style={{ marginTop: 10, marginHorizontal: 6, fontSize: 13, color: palette.brick }}
    >
      {error}
    </AppText>
  ) : null

  if (page === 'model')
    return (
      <SheetScreen
        title={t('setup.model')}
        onDone={() => router.back()}
        back={{ label: t('chat.defaults.title'), onPress: () => setPage('root') }}
      >
        {errorLine}
        <ModelList
          options={models?.options ?? []}
          current={defaults?.selection ?? null}
          disabled={saving || !online}
          defaultChoice={null}
          foot={t('chat.setup.modelsFoot', { server })}
          ultra
          onPick={(picked: FleetSelectionOption | null) => {
            if (!picked || !defaults) return
            const keep = defaults.reasoning === 'off' || chatEffortChoices(picked).includes(defaults.reasoning)
            void save({
              selection: { providerId: picked.providerId, modelId: picked.modelId },
              ...(keep ? {} : { reasoning: 'off' }),
              ...(defaults.fastMode && !picked.fastMode ? { fastMode: false } : {}),
            }).then((ok) => ok && setPage('root'))
          }}
        />
      </SheetScreen>
    )

  const efforts = chatEffortChoices(option)
  return (
    <SheetScreen title={t('chat.defaults.title')} onDone={() => router.back()}>
      <AppText variant="sub" tone="muted" style={{ marginTop: 6, marginHorizontal: 6, fontSize: 13.5, lineHeight: 20 }}>
        {t('chat.defaults.note', { server })}
      </AppText>
      {errorLine}
      {!defaults ? (
        <View style={{ paddingVertical: 32, alignItems: 'center' }}>
          {online ? (
            <ActivityIndicator color={palette.muted} />
          ) : (
            <AppText tone="muted">{t('chat.setup.offline')}</AppText>
          )}
        </View>
      ) : (
        <>
          <Group label={t('setup.model')}>
            <Cell
              icon="sparkles"
              label={option?.modelLabel ?? defaults.selection?.modelId ?? t('chat.setup.default')}
              sub={option?.providerLabel ?? null}
              chevron
              disabled={!online}
              onPress={() => setPage('model')}
            />
            {option?.fastMode ? (
              <Cell
                icon="zap"
                label={t('setup.fast')}
                sub={t('setup.fastDesc')}
                trailing={
                  <Switch
                    accessibilityLabel={t('setup.fast')}
                    value={defaults.fastMode}
                    disabled={saving || !online}
                    onValueChange={(fastMode) => void save({ fastMode })}
                    trackColor={{ true: palette.brass, false: palette.lineStrong }}
                  />
                }
              />
            ) : null}
          </Group>
          <Group label={t('setup.effort')}>
            {efforts.length ? (
              <Pills
                label={t('setup.effort')}
                value={defaults.reasoning}
                disabled={saving || !online}
                options={efforts.map((effort) => ({
                  value: effort,
                  label: effort === 'off' ? t('setup.effortDefault') : effortLabel(effort, t),
                }))}
                onChange={(reasoning) => void save({ reasoning })}
              />
            ) : (
              <AppText variant="sub" tone="muted" style={{ padding: 14 }}>
                {t('setup.noEfforts', { model: option?.modelLabel ?? t('chat.setup.default') })}
              </AppText>
            )}
          </Group>
        </>
      )}
    </SheetScreen>
  )
}

export default function ChatDefaults() {
  const { chats } = useServers()
  return chats ? <Defaults /> : null
}
