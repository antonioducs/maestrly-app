import { selectionPatch, type FleetBot, type FleetCeiling, type FleetPatchBotRequest } from '@maestrly/bot-fleet-protocol'
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Switch, View } from 'react-native'
import { effortLabel } from '../../fleet/format'
import { useFleet, useFleetController } from '../../fleet/react'
import { effortChoices } from '../../fleet/setup'
import type { FleetState } from '../../fleet/state'
import { useBotSelections } from '../../fleet/use-selections'
import { useI18n } from '../../i18n'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { confirm } from '../../ui/confirm'
import { Icon } from '../../ui/icons'
import { Cell } from '../../ui/primitives/Cell'
import { Group } from '../../ui/primitives/Group'
import { Pills } from '../../ui/primitives/Pills'
import { AppText } from '../../ui/primitives/Text'
import { ModelList } from '../../ui/sheets/ModelList'
import { SheetScreen } from '../../ui/SheetScreen'

const CEILINGS: FleetCeiling[] = ['ask', 'auto', 'full']

function Setup({ bot, initialPage }: { bot: FleetBot; initialPage: 'root' | 'model' }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const controller = useFleetController()
  const { options, option, reload } = useBotSelections(bot)
  const [page, setPage] = useState(initialPage)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save(key: string, patch: FleetPatchBotRequest) {
    setSaving(key)
    setError(null)
    try {
      await controller.patchBot(bot.id, patch)
      void reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('outbox.error.generic'))
    } finally {
      setSaving(null)
    }
  }

  async function setCeiling(ceiling: FleetCeiling) {
    if (ceiling === bot.ceiling) return
    if (ceiling === 'full') {
      const sure = await confirm({
        title: t('setup.fullTitle', { name: bot.name }),
        message: t('setup.fullBody'),
        confirmLabel: t('setup.fullConfirm'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      })
      if (!sure) return
    }
    await save('ceiling', { ceiling })
    AccessibilityInfo.announceForAccessibility(t(`ceiling.${ceiling}.label`))
  }

  const errorLine = error ? (
    <AppText accessibilityRole="alert" style={{ marginTop: 10, marginHorizontal: 6, fontSize: 13, color: palette.brick }}>
      {error}
    </AppText>
  ) : null

  if (page === 'model')
    return (
      <SheetScreen
        title={t('setup.model')}
        onDone={() => router.back()}
        back={{ label: t('setup.title', { name: bot.name }), onPress: () => setPage('root') }}
      >
        {errorLine}
        <ModelList
          botName={bot.name}
          options={options}
          current={bot.selection}
          disabled={saving !== null}
          onPick={(picked) =>
            void save('model', { selection: selectionPatch(bot.selection, { model: picked }) }).then(() => setPage('root'))
          }
        />
      </SheetScreen>
    )

  const efforts = option ? effortChoices(option) : []
  return (
    <SheetScreen title={t('setup.title', { name: bot.name })} onDone={() => router.back()}>
      <AppText variant="sub" tone="muted" style={{ marginTop: 6, marginHorizontal: 6, fontSize: 13.5, lineHeight: 20 }}>
        {bot.status === 'working' ? t('setup.noteWorking', { name: bot.name }) : t('setup.note', { name: bot.name })}
      </AppText>
      {errorLine}
      <Group label={t('setup.model')}>
        <Cell
          icon="sparkles"
          label={bot.selection ? (option?.modelLabel ?? bot.selection.modelId) : t('setup.botDefault')}
          sub={bot.selection ? option?.providerLabel : t('setup.botDefaultSub')}
          trailing={saving === 'model' ? <ActivityIndicator size="small" color={palette.muted} /> : null}
          chevron
          onPress={() => setPage('model')}
        />
        {option?.fastMode && bot.selection ? (
          <Cell
            icon="zap"
            label={t('setup.fast')}
            sub={t('setup.fastDesc')}
            trailing={
              <Switch
                accessibilityLabel={t('setup.fast')}
                value={bot.selection.fastMode}
                disabled={saving !== null}
                onValueChange={(fastMode) => void save('fast', { selection: selectionPatch(bot.selection, { fastMode }) })}
                trackColor={{ true: palette.brass, false: palette.lineStrong }}
              />
            }
          />
        ) : null}
      </Group>
      {option && bot.selection ? (
        <Group label={t('setup.effort')}>
          {efforts.length ? (
            <Pills
              label={t('setup.effort')}
              value={bot.selection.reasoning ?? null}
              disabled={saving !== null}
              options={efforts.map((effort) => ({
                value: effort,
                label: effort === null ? t('setup.effortDefault') : effortLabel(effort, t),
              }))}
              onChange={(reasoning) => void save('effort', { selection: selectionPatch(bot.selection, { reasoning }) })}
            />
          ) : (
            <AppText variant="sub" tone="muted" style={{ padding: 14 }}>
              {t('setup.noEfforts', { model: option.modelLabel })}
            </AppText>
          )}
        </Group>
      ) : null}
      <Group label={t('setup.permissions')}>
        {CEILINGS.map((ceiling) => (
          <Cell
            key={ceiling}
            label={t(`ceiling.${ceiling}.label`)}
            sub={t(`ceiling.${ceiling}.desc`)}
            tone={ceiling === 'full' ? 'brick' : 'ink'}
            role="radio"
            checked={bot.ceiling === ceiling}
            disabled={saving !== null}
            leading={
              <View style={{ width: 22, alignItems: 'center' }}>
                {saving === 'ceiling' && bot.ceiling !== ceiling ? null : (
                  <Icon name={ceiling === 'full' ? 'shield' : ceiling === 'auto' ? 'sparkles' : 'hand'} size={18} color={ceiling === 'full' ? palette.brick : palette.muted} />
                )}
              </View>
            }
            onPress={() => void setCeiling(ceiling)}
          />
        ))}
      </Group>
      {saving === 'ceiling' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, marginHorizontal: 6 }}>
          <ActivityIndicator size="small" color={palette.muted} />
          <AppText variant="small" tone="muted">
            {t('setup.saving')}
          </AppText>
        </View>
      ) : null}
    </SheetScreen>
  )
}

export default function BotSetup() {
  const { id, page } = useLocalSearchParams<{ id: string; page?: string }>()
  const { controller } = useServers()
  if (!controller) return null
  return <SetupFor id={String(id)} page={page === 'model' ? 'model' : 'root'} />
}

function SetupFor({ id, page }: { id: string; page: 'root' | 'model' }) {
  const bot = useFleet(useCallback((state: FleetState) => state.bots.find((item) => item.id === id) ?? null, [id]))
  return bot ? <Setup bot={bot} initialPage={page} /> : null
}
