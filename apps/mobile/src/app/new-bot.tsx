import {
  FLEET_ENVIRONMENT_LIMITS,
  FLEET_INSTRUCTIONS_MAX,
  FLEET_NAME_MAX,
  type FleetCeiling,
} from '@maestrly/bot-fleet-protocol'
import { router, useLocalSearchParams } from 'expo-router'
import { useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, TextInput, View } from 'react-native'
import {
  createBotIssue,
  environmentChoices,
  initialEnvironment,
  newBotRequest,
  type CreateBotIssue,
  type JoinAvailability,
  type NewBotProblem,
} from '../fleet/create-bot'
import { useFleet, useFleetController } from '../fleet/react'
import type { FleetState } from '../fleet/state'
import { useI18n, type MessageKey } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { fonts } from '../theme/tokens'
import { BotAvatar } from '../ui/Avatar'
import { confirm } from '../ui/confirm'
import { Icon } from '../ui/icons'
import { Button } from '../ui/primitives/Button'
import { Cell } from '../ui/primitives/Cell'
import { Group } from '../ui/primitives/Group'
import { AppText } from '../ui/primitives/Text'
import { SheetScreen } from '../ui/SheetScreen'

const CEILINGS: FleetCeiling[] = ['ask', 'auto', 'full']
const selectState = (state: FleetState) => state

const UNAVAILABLE: Record<Exclude<JoinAvailability, 'ready'>, MessageKey> = {
  full: 'newBot.environmentFull',
  stopped: 'newBot.environmentStopped',
  starting: 'newBot.environmentStarting',
  restart: 'newBot.environmentRestart',
}
const PROBLEMS: Record<NewBotProblem, MessageKey> = {
  name: 'newBot.nameRequired',
  environment: 'newBot.environmentRequired',
}
const ISSUES: Record<CreateBotIssue, MessageKey> = {
  offline: 'newBot.error.offline',
  gone: 'newBot.error.gone',
  cannotJoin: 'newBot.error.cannotJoin',
  outdated: 'newBot.error.outdated',
  invalid: 'newBot.error.invalid',
  failed: 'newBot.error.failed',
}

/** Creates a bot in one of the server's existing environments, opened from the menu's Bots tab. */
export default function NewBot() {
  const { environment } = useLocalSearchParams<{ environment?: string }>()
  const { controller } = useServers()
  if (!controller) return null
  return <NewBotForm preferred={environment ? String(environment) : null} />
}

function NewBotForm({ preferred }: { preferred: string | null }) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const { setCurrent } = useServers()
  const controller = useFleetController()
  const fleet = useFleet(selectState)
  const choices = useMemo(() => environmentChoices(fleet.environments), [fleet.environments])
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [ceiling, setCeiling] = useState<FleetCeiling>('auto')
  const [talksTo, setTalksTo] = useState<string[]>([])
  const [problem, setProblem] = useState<NewBotProblem | null>(null)
  const [issue, setIssue] = useState<CreateBotIssue | null>(null)
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<TextInput>(null)
  const online = fleet.connection === 'open'
  // Only an environment that can take the bot now stays chosen; one that filled up or stopped meanwhile does not.
  const wanted = picked ?? initialEnvironment(choices, preferred)
  const environmentId =
    choices.find((choice) => choice.environment.id === wanted && choice.availability === 'ready')?.environment.id ??
    null
  const environmentName = (id: string | null) => fleet.environments.find((item) => item.id === id)?.name ?? null

  // As in a bot's setup, full access is confirmed first.
  async function chooseCeiling(value: FleetCeiling) {
    if (value === 'full' && ceiling !== 'full') {
      const sure = await confirm({
        title: t('setup.fullTitle', { name: name.trim() || t('newBot.thisBot') }),
        message: t('setup.fullBody'),
        confirmLabel: t('setup.fullConfirm'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      })
      if (!sure) return
    }
    setCeiling(value)
  }

  async function submit() {
    if (busy) return
    const known = new Set(fleet.bots.map((bot) => bot.id))
    const result = newBotRequest({
      name,
      instructions,
      environmentId,
      ceiling,
      talksTo: talksTo.filter((id) => known.has(id)),
    })
    if (!result.ok) {
      setProblem(result.problem)
      AccessibilityInfo.announceForAccessibility(t(PROBLEMS[result.problem]))
      if (result.problem === 'name') nameInput.current?.focus()
      return
    }
    setProblem(null)
    setIssue(null)
    setBusy(true)
    try {
      const bot = await controller.createBot(result.request)
      AccessibilityInfo.announceForAccessibility(t('newBot.created', { name: bot.name }))
      setCurrent({ kind: 'bot', id: bot.id })
      router.back()
    } catch (cause) {
      const next = createBotIssue(cause)
      setIssue(next)
      AccessibilityInfo.announceForAccessibility(t(ISSUES[next]))
      setBusy(false)
    }
  }

  const field = (invalid: boolean) => ({
    placeholderTextColor: palette.faint,
    'aria-invalid': invalid,
    style: {
      minHeight: 44,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: invalid ? palette.brick : 'transparent',
      backgroundColor: palette.surface,
      color: palette.ink,
      fontFamily: fonts.body,
      fontSize: 16,
    },
  })
  const fieldError = (text: string) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7, marginHorizontal: 6 }}>
      <Icon name="alert" size={14} color={palette.brick} />
      <AppText variant="small" style={{ color: palette.brick }}>
        {text}
      </AppText>
    </View>
  )
  const peers = fleet.bots

  return (
    <SheetScreen title={t('newBot.title')} onDone={() => router.back()}>
      <AppText variant="sub" tone="muted" style={{ marginTop: 6, marginHorizontal: 6, fontSize: 13.5, lineHeight: 20 }}>
        {t('newBot.note')}
      </AppText>

      <Group label={t('newBot.name')}>
        <View style={{ padding: 10 }}>
          <TextInput
            {...field(problem === 'name')}
            ref={nameInput}
            value={name}
            onChangeText={(value) => {
              setName(value)
              if (problem === 'name' && value.trim()) setProblem(null)
            }}
            placeholder={t('newBot.namePlaceholder')}
            accessibilityLabel={t('newBot.name')}
            maxLength={FLEET_NAME_MAX}
            autoFocus
            autoCorrect={false}
            returnKeyType="next"
          />
        </View>
      </Group>
      {problem === 'name' ? fieldError(t('newBot.nameRequired')) : null}

      <Group label={t('newBot.instructions')} foot={t('newBot.instructionsHint')}>
        <View style={{ padding: 10 }}>
          <TextInput
            {...field(false)}
            value={instructions}
            onChangeText={setInstructions}
            placeholder={t('newBot.instructionsPlaceholder')}
            accessibilityLabel={t('newBot.instructions')}
            maxLength={FLEET_INSTRUCTIONS_MAX}
            multiline
            textAlignVertical="top"
            style={[field(false).style, { minHeight: 96, lineHeight: 22 }]}
          />
        </View>
      </Group>

      {choices.length ? (
        <Group label={t('newBot.environment')} foot={t('newBot.environmentFoot')}>
          {choices.map(({ environment, availability }) => (
            <Cell
              key={environment.id}
              label={environment.name}
              sub={
                availability === 'ready'
                  ? plural('bots.count', environment.botIds.length)
                  : t(UNAVAILABLE[availability], { max: FLEET_ENVIRONMENT_LIMITS.botsMax })
              }
              icon="server"
              role="radio"
              checked={environment.id === environmentId}
              disabled={availability !== 'ready' || busy}
              onPress={() => {
                setPicked(environment.id)
                if (problem === 'environment') setProblem(null)
              }}
            />
          ))}
        </Group>
      ) : (
        <Group label={t('newBot.environment')}>
          <AppText variant="sub" tone="muted" style={{ padding: 14 }}>
            {t('newBot.noEnvironments')}
          </AppText>
        </Group>
      )}
      {problem === 'environment' ? fieldError(t('newBot.environmentRequired')) : null}

      <Group label={t('setup.permissions')} foot={t('newBot.permissionsFoot')}>
        {CEILINGS.map((value) => (
          <Cell
            key={value}
            label={t(`ceiling.${value}.label`)}
            sub={t(`ceiling.${value}.desc`)}
            tone={value === 'full' ? 'brick' : 'ink'}
            role="radio"
            checked={ceiling === value}
            disabled={busy}
            leading={
              <View style={{ width: 22, alignItems: 'center' }}>
                <Icon
                  name={value === 'full' ? 'shield' : value === 'auto' ? 'sparkles' : 'hand'}
                  size={18}
                  color={value === 'full' ? palette.brick : palette.muted}
                />
              </View>
            }
            onPress={() => void chooseCeiling(value)}
          />
        ))}
      </Group>

      {peers.length ? (
        <Group label={t('newBot.peers')} foot={t('newBot.peersFoot')}>
          {peers.map((bot) => {
            const on = talksTo.includes(bot.id)
            return (
              <Cell
                key={bot.id}
                label={bot.name}
                sub={environmentName(bot.environmentId)}
                leading={<BotAvatar bot={bot} size={30} />}
                role="checkbox"
                checked={on}
                disabled={busy}
                onPress={() => setTalksTo((list) => (on ? list.filter((id) => id !== bot.id) : [...list, bot.id]))}
              />
            )
          })}
        </Group>
      ) : null}

      {issue ? (
        <AppText
          accessibilityRole="alert"
          style={{ marginTop: 14, marginHorizontal: 6, fontSize: 13.5, lineHeight: 19, color: palette.brick }}
        >
          {t(ISSUES[issue])}
        </AppText>
      ) : null}
      <Button
        label={t('newBot.submit')}
        size="lg"
        busy={busy}
        disabled={!online}
        style={{ marginTop: 18 }}
        onPress={() => void submit()}
      />
      <AppText variant="small" tone="muted" style={{ marginTop: 8, marginHorizontal: 6, textAlign: 'center' }}>
        {online
          ? environmentId
            ? t('newBot.joins', { environment: environmentName(environmentId) ?? '' })
            : t('newBot.chooseEnvironment')
          : t('newBot.offline')}
      </AppText>
    </SheetScreen>
  )
}
