import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetSelection, FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import type { FleetOutgoingAttachment } from '../../../preload/api-fleet'
import type { ChatSlashCommand } from '../../../shared/chat'
import { ChatComposer, type UIAttachment } from '@/components/chat/ChatComposer'
import { ChatPlusMenu } from '@/components/chat/ChatPlusMenu'
import { ChatSkillsMenu } from '@/components/chat/ChatSkillsMenu'
import { ChatModelChip } from '@/components/chat/ChatModelChip'
import { ChatPermModePicker } from '@/components/chat/ChatPermModePicker'
import { ChatContextMeterDisplay } from '@/components/chat/ChatContextMeter'
import { ChatReasoningPicker } from '@/components/chat/ChatReasoningPicker'
import { FastModeChip } from '@/components/chat/ChatFastModeToggle'
import { ChatMicButton } from '@/components/chat/ChatMicButton'
import { appendDictation } from '@/lib/dictation'
import { ContextCompactionStatus } from '@/components/chat/ContextCompactionStatus'
import { BackgroundCompactionStatus } from '@/components/chat/BackgroundCompactionStatus'
import { botChatComposerSource } from '@/components/chat/chat-composer-source'
import { backgroundCompactionState, compactionProgress } from '@/lib/fleet/compaction'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import {
  fleetUsageLimit,
  formatFleetTokens,
  formatFleetUsage,
  selectionPatch,
  validateAttachments,
} from '@/lib/fleet/composer'
import { hasEnvironments } from '@/lib/fleet/environments'
import { environmentScreenAvailability } from '@/lib/fleet/provisioning'
import { environmentOf } from '@/lib/fleet/selectors'
import type { FleetController } from '@/lib/fleet/use-fleet'

type PendingImage = { file: File; attachment: UIAttachment }

export function BotComposer({
  bot,
  fleet,
  onOpenScreen,
  onOpenSettings,
  onOpenEnvironmentScreen,
}: {
  bot: FleetBot
  fleet: FleetController
  onOpenScreen: () => void
  onOpenSettings: () => void
  /** A bot of an environment manages skills, accounts and MCP servers on its environment's screen. */
  onOpenEnvironmentScreen?: () => void
}) {
  const { t } = useTranslation('fleet')
  const [draft, setDraft] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const imagesRef = useRef(images)
  imagesRef.current = images
  const [options, setOptions] = useState<FleetSelectionOption[]>([])
  const [current, setCurrent] = useState<FleetSelection | null>(null)
  const [commands, setCommands] = useState<ChatSlashCommand[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onOpenScreenRef = useRef(onOpenScreen)
  onOpenScreenRef.current = onOpenScreen
  const onOpenEnvironmentScreenRef = useRef(onOpenEnvironmentScreen)
  onOpenEnvironmentScreenRef.current = onOpenEnvironmentScreen
  // An environment still on an image from before environments has no environment screen: its settings open in the
  // bot's browser area, with a takeover, as they did before environments.
  const environment = hasEnvironments(fleet.state.connection)
    ? environmentOf(fleet.state.snapshot.environments, bot)
    : undefined
  const oldImage = environment !== undefined && environmentScreenAvailability(environment) === 'restart-environment'
  const environmentId = hasEnvironments(fleet.state.connection) && !oldImage ? bot.environmentId : null
  const takeoverStateRef = useRef(bot.takeover.state)
  takeoverStateRef.current = bot.takeover.state
  // `bot` changes on every status/usage event; keep the source (and the command reload it drives) stable.
  const botSource = useMemo(
    () =>
      botChatComposerSource(
        { id: bot.id, ceiling: bot.ceiling },
        () => onOpenScreenRef.current(),
        () => takeoverStateRef.current
      ),
    [bot.id, bot.ceiling]
  )
  // Skills, accounts and MCP servers belong to the bot's environment. Its Maestrly shows its settings on the
  // environment screen, never in the bot's browser area, and that screen needs no takeover of the bot.
  const source = useMemo(
    () =>
      environmentId && botSource.bot
        ? {
            ...botSource,
            bot: {
              ...botSource.bot,
              manage: async (target: 'skills' | 'mcp') => {
                await window.api.fleetEnvironmentUiOpen(environmentId, target)
                onOpenEnvironmentScreenRef.current?.()
              },
            },
          }
        : botSource,
    [botSource, environmentId]
  )
  const locked = ['paused', 'human', 'offline', 'starting', 'setup'].includes(bot.status)

  const reloadCommands = useCallback(() => {
    void source
      .chatCommands()
      .then((result) =>
        setCommands([
          { name: 'compact', description: t('chat:view.cmdCompact'), kind: 'action', action: 'compact' },
          ...result.skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            kind: 'skill' as const,
            argumentHint: skill.argumentHint,
          })),
          ...result.prompts.map((prompt) => ({
            name: prompt.name,
            description: prompt.description,
            kind: 'prompt' as const,
            content: prompt.content,
          })),
          ...result.project.map((project) => ({
            name: project.name,
            description: project.description,
            kind: 'project' as const,
            content: project.content,
          })),
        ])
      )
      .catch((cause) => setError(fleetErrorMessage(cause)))
  }, [source, t])
  useEffect(() => {
    if (locked) return
    reloadCommands()
    const onSkillsChanged = () => reloadCommands()
    window.addEventListener('maestrly:skills-changed', onSkillsChanged)
    return () => window.removeEventListener('maestrly:skills-changed', onSkillsChanged)
  }, [locked, reloadCommands])
  useEffect(() => {
    if (locked) return
    let alive = true
    void window.api
      .fleetListSelections(bot.id)
      .then((result) => {
        if (!alive) return
        setOptions(result.options)
        setCurrent(result.current)
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [bot.id, locked])
  useEffect(() => {
    setDraft('')
    setImages((previous) => {
      previous.forEach(({ attachment }) => URL.revokeObjectURL(attachment.previewUrl ?? ''))
      return []
    })
    setError(null)
  }, [bot.id])
  useEffect(
    () => () => imagesRef.current.forEach(({ attachment }) => URL.revokeObjectURL(attachment.previewUrl ?? '')),
    []
  )

  const addFiles = (files: File[]) => {
    if (!files.length) return
    const issue = validateAttachments(
      imagesRef.current.map((image) => image.file),
      files
    )
    if (issue) {
      setError(t(`composer.attachmentError.${issue}`))
      return
    }
    setImages((previous) => [
      ...previous,
      ...files.map((file) => ({
        file,
        attachment: {
          id: crypto.randomUUID(),
          name: file.name,
          mediaType: file.type,
          kind: 'image' as const,
          byteSize: file.size,
          previewUrl: URL.createObjectURL(file),
        },
      })),
    ])
    setError(null)
  }
  const removeAttachment = (id: string) =>
    setImages((previous) =>
      previous.filter((image) => {
        if (image.attachment.id !== id) return true
        URL.revokeObjectURL(image.attachment.previewUrl ?? '')
        return false
      })
    )
  const changeSelection = async (change: {
    model?: FleetSelectionOption | null
    reasoning?: string | null
    fastMode?: boolean
  }) => {
    const next = selectionPatch(current, change)
    if (!next && !('model' in change)) return
    try {
      setError(null)
      await source.bot?.updateSelection(next)
      const result = await window.api.fleetListSelections(bot.id)
      setOptions(result.options)
      setCurrent(result.current)
      await fleet.refresh()
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    }
  }
  const send = async (text: string) => {
    if (busy || locked) return
    setBusy(true)
    setError(null)
    try {
      const attachments: FleetOutgoingAttachment[] = await Promise.all(
        imagesRef.current.map(async ({ file }) => ({
          name: file.name,
          mediaType: file.type as FleetOutgoingAttachment['mediaType'],
          data: new Uint8Array(await file.arrayBuffer()),
        }))
      )
      await window.api.fleetSendMessage(bot.id, text.trim(), attachments)
      setDraft('')
      setImages((previous) => {
        previous.forEach(({ attachment }) => URL.revokeObjectURL(attachment.previewUrl ?? ''))
        return []
      })
      await fleet.loadTranscript(bot.id)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const compact = async () => {
    setError(null)
    try {
      const result = await source.chatCompact()
      if (!result.ok)
        setError(
          t(`composer.compactError.${result.error ?? 'failed'}`, { defaultValue: t('composer.compactError.failed') })
        )
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    }
  }
  const option = options.find((item) => item.providerId === current?.providerId && item.modelId === current.modelId)
  const usage = bot.usage && formatFleetUsage(bot.usage)
  const usagePct =
    bot.usage?.contextUsedTokens != null && bot.usage.contextWindowTokens
      ? bot.usage.contextUsedTokens / bot.usage.contextWindowTokens
      : null
  const usageLimit = bot.usage ? fleetUsageLimit(bot.usage, bot.compaction) : null
  return (
    <>
      <ChatComposer
        value={draft}
        onChange={setDraft}
        streaming={bot.status === 'working'}
        sendWhileStreaming
        disabled={locked || busy}
        disabledPlaceholder={
          locked
            ? bot.status === 'setup' && bot.activity?.kind === 'setup' && bot.activity.need === 'compaction'
              ? t('composer.setupCompaction')
              : t(`composer.${bot.status}`)
            : undefined
        }
        placeholder={t('composer.placeholder', { name: bot.name })}
        onSend={({ text }) => void send(text)}
        onStop={() =>
          void window.api.fleetBotAction(bot.id, 'cancel').catch((cause) => setError(fleetErrorMessage(cause)))
        }
        attachments={images.map((image) => image.attachment)}
        onAddFiles={addFiles}
        onRemoveAttachment={removeAttachment}
        commands={commands}
        onPickCommand={(command) => {
          if (command.kind === 'action' && command.action === 'compact') {
            setDraft('')
            void compact()
          } else
            setDraft(
              command.kind === 'skill'
                ? `/${command.name} `
                : (command.content ?? '').replace(/\$ARGUMENTS/g, '').trim()
            )
        }}
        micSlot={
          <ChatMicButton
            onTranscribed={(text) => setDraft((previous) => appendDictation(previous, text))}
            onAutoSend={(text) => {
              if (busy || locked) return false
              void send(appendDictation(draft, text))
              return true
            }}
            disabled={locked || busy}
          />
        }
        leftSlot={
          <>
            <ChatPlusMenu
              conversationId={bot.id}
              mode="agent"
              onAddFiles={addFiles}
              fontScale={1}
              onFontScale={() => {}}
              source={source}
              manageMcpLabel={environmentId ? t('composer.manageMcpEnvironment') : t('composer.manageMcp')}
            />
            <ChatSkillsMenu
              conversationId={bot.id}
              onChanged={reloadCommands}
              source={source}
              manageSkillsLabel={environmentId ? t('composer.manageSkillsEnvironment') : t('composer.manageSkills')}
              emptySkillsLabel={t('composer.noSkills')}
            />
            {option && option.efforts.length > 0 && (
              <ChatReasoningPicker
                value={current?.reasoning ?? 'off'}
                efforts={option.efforts}
                allowUltra={false}
                onChange={(reasoning) => void changeSelection({ reasoning: reasoning === 'off' ? null : reasoning })}
              />
            )}
            {option?.fastMode && (
              <FastModeChip
                enabled={current?.fastMode ?? false}
                onToggle={() => void changeSelection({ fastMode: !current?.fastMode })}
              />
            )}
            <ChatModelChip
              conversationId={bot.id}
              source={source}
              value={bot.selection}
              defaultLabel={t('composer.defaultModel')}
              onSelect={(model) =>
                void changeSelection({
                  model:
                    options.find((item) => item.providerId === model.providerId && item.modelId === model.modelId) ??
                    null,
                })
              }
              onSelectDefault={() => void changeSelection({ model: null })}
            />
          </>
        }
        metaSlot={
          <>
            <ChatPermModePicker conversationId={bot.id} source={source} />
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
              <ContextCompactionStatus progress={compactionProgress(bot.compactionState?.progress)} />
              <BackgroundCompactionStatus
                conversationId={bot.id}
                state={backgroundCompactionState(bot.compactionState?.background)}
                onRetry={() => source.chatBackgroundCompactionRetry()}
                onOpenSettings={onOpenSettings}
              />
              {usage && (
                <ChatContextMeterDisplay
                  text={usage}
                  title={
                    t('composer.usageTooltip', {
                      quality:
                        bot.usage?.contextQuality === 'measured' ? t('composer.measured') : t('composer.estimated'),
                    }) +
                    (usageLimit !== null
                      ? ' ' + t('composer.usageLimited', { limit: formatFleetTokens(usageLimit) })
                      : '')
                  }
                  pct={usagePct}
                  activeLimit={usageLimit !== null}
                />
              )}
            </div>
          </>
        }
      />
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  )
}
