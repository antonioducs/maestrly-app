import {
  MobileBridgeError,
  type FleetInteractionResolution,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Pressable, type TextInputInstance, View } from 'react-native'
import { useChats, useChatsController } from '../../chats/react'
import { allConversations, type ChatsState } from '../../chats/state'
import type { PlanDecisionArgs } from '../../chats/plan-review'
import { editableItemId } from '../../fleet/transcript-search'
import { useI18n } from '../../i18n'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { confirm } from '../confirm'
import { ComposerShell } from '../composer/Composer'
import { OutboxRow } from '../composer/OutboxRow'
import { ConversationList, type ExtraRow } from '../conversation/ConversationList'
import { ConversationContext, type ConversationContextValue } from '../conversation/CueCard'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'
import { ChatHostBanner } from './ChatHostBanner'
import { ChatSetupPill } from './ChatSetupPill'
import { PlanCard } from './PlanCard'
import { PlanSheet } from './PlanSheet'

const selectOpen = (state: ChatsState) => state.bridge === 'open'

/** Where a chat came from, when an agent started it from another chat. */
function OriginLine({ conversationId }: { conversationId: string }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { setCurrent } = useServers()
  const name = useChats(
    useCallback(
      (state: ChatsState) => allConversations(state.lists).find((item) => item.id === conversationId)?.name ?? null,
      [conversationId]
    )
  )
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => setCurrent({ kind: 'chat', id: conversationId })}
      style={{
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minHeight: 44,
        paddingHorizontal: 10,
      }}
    >
      <Icon name="message" size={13} color={palette.muted} />
      <AppText variant="small" tone="muted" style={{ fontWeight: '600' }}>
        {name ? t('chat.origin', { name }) : t('chat.originUnknown')}
      </AppText>
      <Icon name="chev-right" size={12} color={palette.muted} />
    </Pressable>
  )
}

/** A chat of the server's workspaces host: its conversation, live, and its composer. */
export function ChatConversation({ conversationId }: { conversationId: string }) {
  const { t } = useI18n()
  const chats = useChatsController()
  const { active, setCurrent } = useServers()
  const online = useChats(selectOpen)
  const view = useChats(useCallback((state: ChatsState) => state.views[conversationId], [conversationId]))
  const listed = useChats(
    useCallback(
      (state: ChatsState) => allConversations(state.lists).find((item) => item.id === conversationId) ?? null,
      [conversationId]
    )
  )
  const outbox = useChats(
    useCallback(
      (state: ChatsState) => state.outbox.filter((entry) => entry.conversationId === conversationId),
      [conversationId]
    )
  )
  const setup = useChats(useCallback((state: ChatsState) => state.setups[conversationId] ?? null, [conversationId]))
  const input = useRef<TextInputInstance>(null)
  const conversation = view?.conversation ?? listed
  const runtime = view?.runtime ?? null
  const busy = !!runtime && (runtime.streaming || runtime.compacting)

  useEffect(() => {
    chats.openConversation(conversationId)
    return () => chats.closeConversation(conversationId)
  }, [chats, conversationId])

  const items = view?.items ?? []
  // As on a computer: the person's last message, while no turn runs and nothing waits to be sent.
  const editableId = !busy && outbox.length === 0 ? editableItemId(items, 'chat') : null
  const [editing, setEditing] = useState<{ itemId: string; text: string } | null>(null)
  const startEdit = useCallback((itemId: string, text: string) => setEditing({ itemId, text }), [])
  const edit = useMemo(
    () => (editableId ? { itemId: editableId, start: startEdit } : undefined),
    [editableId, startEdit]
  )

  const focusComposer = useCallback(() => input.current?.focus(), [])
  const interactionFor = useCallback(
    (item: FleetTranscriptItem) =>
      item.kind === 'permission' && item.state === 'pending'
        ? item.requestId
        : item.kind === 'question' && item.state === 'pending'
          ? item.toolCallId
          : null,
    []
  )
  const resolve = useCallback(
    (interactionId: string, resolution: FleetInteractionResolution) => {
      if (resolution.kind === 'permission')
        return chats.respondPermission(conversationId, interactionId, resolution.reply)
      if (resolution.kind === 'question') return chats.answerQuestion(conversationId, interactionId, resolution.answers)
      if (resolution.kind === 'question_dismiss') return chats.answerQuestion(conversationId, interactionId, [])
      return Promise.reject(new Error('A chat has no requests for help'))
    },
    [chats, conversationId]
  )
  const imageSource = useCallback(
    (imageId: string) =>
      chats
        .image(conversationId, imageId)
        .then((image) => ({ uri: `data:${image.mediaType};base64,${image.dataBase64}` })),
    [chats, conversationId]
  )
  const openChat = useCallback((id: string) => setCurrent({ kind: 'chat', id }), [setCurrent])
  // From a permission request, as from the chat's setup: the same warning, then full access for the whole chat.
  const canAllowEverything = !!setup && setup.experience !== 'maestro' && setup.permMode !== 'full'
  const allowEverything = useCallback(async () => {
    const sure = await confirm({
      title: t('chat.setup.fullTitle'),
      message: t('setup.fullBody'),
      confirmLabel: t('setup.fullConfirm'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    })
    if (!sure) return false
    await chats.patchSetup(conversationId, { permMode: 'full' })
    return true
  }, [chats, conversationId, t])
  const context = useMemo<ConversationContextValue>(
    () => ({
      bot: null,
      name: conversation?.name ?? '',
      online,
      focusComposer,
      interactionFor,
      resolve,
      imageSource,
      openChat,
      sendMessage: async (text: string) => {
        await chats.send(conversationId, text, [])
      },
      ...(canAllowEverything ? { allowEverything } : {}),
      ...(edit ? { edit } : {}),
    }),
    [
      edit,
      conversation?.name,
      online,
      focusComposer,
      interactionFor,
      resolve,
      imageSource,
      openChat,
      canAllowEverything,
      allowEverything,
      chats,
      conversationId,
    ]
  )

  // A plan opens in a sheet of its own, kept here rather than in its card: the list may unmount a row it scrolls away.
  const [planOpen, setPlanOpen] = useState(false)
  const plan = runtime?.plan ?? null
  const planDraftKey = `${active?.id ?? ''}:${conversationId}`
  const decidePlan = useCallback(
    (decision: PlanDecisionArgs) => chats.decidePlan(conversationId, decision),
    [chats, conversationId]
  )
  useEffect(() => {
    if (!plan) setPlanOpen(false)
  }, [plan])

  const extras = useMemo<ExtraRow[]>(() => {
    const rows: ExtraRow[] = []
    if (plan)
      rows.push({
        key: `plan:${plan.version}`,
        node: <PlanCard plan={plan} draftKey={planDraftKey} onOpen={() => setPlanOpen(true)} onDecide={decidePlan} />,
      })
    for (const entry of outbox)
      rows.push({
        key: entry.id,
        node: (
          <OutboxRow
            entry={entry}
            waitingText={!online ? t('outbox.waiting') : busy ? t('user.queued') : t('outbox.sending')}
            failedReason={t(`outbox.error.${entry.error ?? 'generic'}`)}
            onRetry={() => void chats.retryOutbox(entry.id)}
            onDelete={() => void chats.deleteOutbox(entry.id)}
          />
        ),
      })
    return rows
  }, [plan, planDraftKey, decidePlan, outbox, online, busy, chats, t])

  const thinking =
    !!runtime?.streaming &&
    !items.some(
      (item) =>
        ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) ||
        (item.kind === 'tool' && item.state === 'running') ||
        // A turn waiting on an answer is not thinking.
        ((item.kind === 'permission' || item.kind === 'question') && item.state === 'pending')
    )

  return (
    <ConversationContext.Provider value={context}>
      <ChatHostBanner />
      <View style={{ flex: 1 }}>
        <ConversationList
          items={items}
          extras={extras}
          loaded={!!view?.loaded}
          loadingOlder={!!view?.loading && !!view.before}
          thinking={thinking}
          emptyText={view?.failed ? t('chat.loadFailed') : t('chat.empty')}
          onLoadOlder={() => void chats.loadOlder(conversationId)}
          hasOlder={!!view?.before}
          top={
            view?.sourceConversationId && !view.before ? (
              <OriginLine conversationId={view.sourceConversationId} />
            ) : undefined
          }
        />
      </View>
      <ComposerShell
        key={conversationId}
        draftKey={`${active?.id ?? ''}:chat:${conversationId}`}
        placeholder={
          conversation?.workspaceName
            ? t('composer.placeholder', { name: conversation.workspaceName })
            : t('chat.composer.ask')
        }
        filesEnabled
        setup={<ChatSetupPill conversationId={conversationId} />}
        stopLabel={runtime?.streaming ? t('chat.composer.stop') : null}
        onStop={() => chats.stopTurn(conversationId)}
        onSend={async (text, files) => {
          await chats.send(conversationId, text, files)
          AccessibilityInfo.announceForAccessibility(online ? t('announce.sent') : t('announce.queuedOffline'))
        }}
        inputRef={input}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onEdit={async (text) => {
          if (!editing) return
          try {
            await chats.edit(conversationId, editing.itemId, text)
          } catch (cause) {
            const code = cause instanceof MobileBridgeError ? cause.code : null
            throw new Error(
              code === 'unknown-channel'
                ? t('edit.error.outdated')
                : code === 'busy'
                  ? t('edit.error.busy')
                  : code === 'not-editable'
                    ? t('edit.error.notLast')
                    : t('edit.error.failed')
            )
          }
          setEditing(null)
        }}
      />
      {plan && planOpen ? (
        <PlanSheet
          key={`plan:${plan.version}`}
          conversation={{ id: conversationId }}
          plan={plan}
          draftKey={planDraftKey}
          onClose={() => setPlanOpen(false)}
          onDecide={decidePlan}
          onBuiltElsewhere={openChat}
        />
      ) : null}
    </ConversationContext.Provider>
  )
}
