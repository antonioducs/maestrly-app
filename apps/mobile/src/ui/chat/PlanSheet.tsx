import {
  MobileBridgeError,
  type FleetSelectionOption,
  type MobileConversation,
  type MobileMaestroProfile,
  type MobilePlan,
  type MobilePlanImplementation,
  type MobilePlanOptions,
} from '@maestrly/bot-fleet-protocol'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  canRevise,
  clearDraft,
  draftComments,
  draftEdited,
  lineDiff,
  type PlanBlock,
  planBlocks,
  planDecision,
  type PlanDecisionArgs,
} from '../../chats/plan-review'
import { useChats, useChatsController } from '../../chats/react'
import { chatEffortChoices, optionFor } from '../../chats/selectors'
import type { ChatsState } from '../../chats/state'
import { effortLabel } from '../../fleet/format'
import { useI18n } from '../../i18n'
import type { Translate } from '../../i18n/translate'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { confirm } from '../confirm'
import { AssistantMarkdown } from '../conversation/AssistantMarkdown'
import { useConversation } from '../conversation/CueCard'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { Cell } from '../primitives/Cell'
import { Group } from '../primitives/Group'
import { IconButton } from '../primitives/IconButton'
import { Pills } from '../primitives/Pills'
import { Segmented } from '../primitives/Segmented'
import { AppText } from '../primitives/Text'
import { ModelList } from '../sheets/ModelList'
import { PlanBadge } from './PlanCard'
import { planErrorText, usePlanDraft } from './usePlanDraft'

type Mode = 'read' | 'edit' | 'diff'
type Page = 'plan' | 'maestro' | 'handoff' | 'handoff-model'
/** `legacy`: the host predates `planOptions` and takes only the action and a general comment. */
type Options = { state: 'loading' } | { state: 'full'; value: MobilePlanOptions } | { state: 'legacy' | 'failed' }
type Busy = 'approve' | 'revise' | 'discard' | 'maestro' | 'standard' | null

export type PlanDecided = { ok: boolean; conversationId?: string }

/**
 * The whole plan in a sheet of its own, with everything the desktop's Plan tab does: read it and comment on its
 * parts, edit it, see what changed since the last version, and decide it: approve it here, build it in a new Maestro
 * or standard conversation, request changes or discard it. The decisions stay at the bottom while the plan scrolls.
 */
export function PlanSheet({
  conversation,
  plan,
  draftKey,
  onClose,
  onDecide,
  onBuiltElsewhere,
}: {
  conversation: Pick<MobileConversation, 'id'>
  plan: MobilePlan
  draftKey: string
  onClose: () => void
  onDecide: (decision: PlanDecisionArgs) => Promise<PlanDecided>
  onBuiltElsewhere: (conversationId: string) => void
}) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const chats = useChatsController()
  const { online } = useConversation()
  const insets = useSafeAreaInsets()
  const [draft, setDraft] = usePlanDraft(draftKey, plan)
  const [options, setOptions] = useState<Options>({ state: 'loading' })
  const [mode, setMode] = useState<Mode>(plan.previousText ? 'diff' : 'read')
  const [page, setPage] = useState<Page>('plan')
  const [editingLine, setEditingLine] = useState<number | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)

  const loadOptions = useCallback(() => {
    chats
      .planOptions(conversation.id)
      .then((value) => setOptions({ state: 'full', value }))
      .catch((cause: unknown) =>
        setOptions({
          state: cause instanceof MobileBridgeError && cause.code === 'unknown-channel' ? 'legacy' : 'failed',
        })
      )
  }, [chats, conversation.id])
  useEffect(() => {
    if (online) loadOptions()
  }, [loadOptions, online])

  const full = options.state === 'full'
  const review = full ? options.value.review : null
  const maestro = full ? options.value.maestro : null
  const newConversation = full && options.value.newConversation
  const locked = !!review || busy !== null || !online
  const comments = draftComments(draft)
  const edited = draftEdited(plan, draft)
  const revisable = canRevise(plan, draft)
  const modes: Mode[] = [
    'read',
    ...(full ? (['edit'] as const) : []),
    ...(plan.previousText ? (['diff'] as const) : []),
  ]

  async function decide(action: 'approve' | 'revise' | 'discard', implementation?: MobilePlanImplementation) {
    if (action === 'discard') {
      const sure = await confirm({
        title: t('plan.discardTitle'),
        message: t('plan.discardBody'),
        confirmLabel: t('plan.discard'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      })
      if (!sure) return
    }
    setBusy(implementation?.target ?? action)
    setError(null)
    try {
      const result = await onDecide(
        planDecision(plan, draft, action, {
          full,
          implementation,
          words: {
            general: t('plan.words.general'),
            lines: t('plan.words.lines'),
            line: (ref, text) => t('plan.words.line', { ref, text }),
          },
        })
      )
      clearDraft(draftKey)
      AccessibilityInfo.announceForAccessibility(
        result.conversationId ? t('plan.announce.elsewhere') : t(`plan.announce.${action}`)
      )
      onClose()
      if (result.conversationId) onBuiltElsewhere(result.conversationId)
    } catch (cause) {
      setError(planErrorText(cause, t))
      // A review started on the computer meanwhile: show it holding the plan.
      if (cause instanceof MobileBridgeError && cause.code === 'review-active') loadOptions()
    } finally {
      setBusy(null)
    }
  }

  const errorLine =
    error || !online ? (
      <AppText accessibilityRole="alert" style={{ fontSize: 13, lineHeight: 18, color: palette.brick }}>
        {error ?? t('cue.offline')}
      </AppText>
    ) : null

  let content: ReactNode
  if (page === 'maestro' && maestro)
    content = (
      <MaestroPage
        profiles={maestro.profiles}
        lastUsedId={maestro.lastUsedId}
        locked={locked}
        busy={busy === 'maestro'}
        errorLine={errorLine}
        onBack={() => setPage('plan')}
        onStart={(profileId) => void decide('approve', { target: 'maestro', profileId })}
      />
    )
  else if ((page === 'handoff' || page === 'handoff-model') && newConversation)
    content = (
      <HandoffPage
        conversationId={conversation.id}
        picking={page === 'handoff-model'}
        locked={locked}
        busy={busy === 'standard'}
        errorLine={errorLine}
        onPage={setPage}
        onStart={(implementation) => void decide('approve', implementation)}
      />
    )
  else
    content = (
      <>
        <View style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 8 }}>
          <SheetTop eyebrow={t('cue.eyebrow')} closeLabel={t('common.close')} onClose={onClose} />
          <AppText variant="title" accessibilityRole="header" style={{ fontSize: 21, lineHeight: 26 }}>
            {plan.title || t('plan.title')}
          </AppText>
          {plan.version > 1 || comments.length || edited ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              {plan.version > 1 ? (
                <AppText variant="small" tone="muted">
                  {t('plan.version', { version: plan.version })}
                </AppText>
              ) : null}
              {comments.length ? <PlanBadge tone="brass" label={plural('plan.comments', comments.length)} /> : null}
              {edited ? <PlanBadge tone="moss" label={t('plan.edited')} /> : null}
            </View>
          ) : null}
          {modes.length > 1 ? (
            <Segmented
              label={t('plan.mode')}
              value={mode}
              options={modes.map((value) => ({
                value,
                label: t(value === 'read' ? 'plan.modeRead' : value === 'edit' ? 'plan.modeEdit' : 'plan.modeDiff'),
              }))}
              onChange={(value) => {
                setEditingLine(null)
                setMode(value)
              }}
            />
          ) : null}
          {review ? (
            <Notice
              icon="lock"
              tone="cue"
              text={t(
                review.target === 'code'
                  ? 'plan.review.code'
                  : `plan.review.${review.stage === 'running' ? 'plan' : review.stage}`
              )}
            />
          ) : options.state === 'legacy' ? (
            <Notice icon="alert" tone="plain" text={t('plan.outdated')} />
          ) : null}
        </View>
        <ScrollView
          style={{ flex: 1, borderTopWidth: 1, borderTopColor: palette.line }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {mode === 'edit' && full ? (
            <EditView
              text={draft.text}
              edited={edited}
              locked={locked}
              onChange={(text) => setDraft({ ...draft, text })}
              onUndo={() => setDraft({ ...draft, text: plan.text })}
            />
          ) : mode === 'diff' && plan.previousText ? (
            <DiffView before={plan.previousText} after={draft.text} version={plan.version - 1} />
          ) : (
            <ReadView
              text={draft.text}
              comments={draft.comments}
              editingLine={editingLine}
              locked={locked}
              onEdit={setEditingLine}
              onSave={(line, text) => {
                const next = { ...draft.comments }
                if (text.trim()) next[line] = text.trim()
                else delete next[line]
                setDraft({ ...draft, comments: next })
                setEditingLine(null)
              }}
              onCancel={() => setEditingLine(null)}
            />
          )}
        </ScrollView>
        <Dock>
          {errorLine}
          <TextInput
            value={draft.feedback}
            onChangeText={(feedback) => setDraft({ ...draft, feedback })}
            editable={!review && busy === null}
            multiline
            maxLength={10_000}
            placeholder={t('plan.feedback')}
            placeholderTextColor={palette.faint}
            accessibilityLabel={t('plan.feedback')}
            style={{
              minHeight: 42,
              maxHeight: 96,
              paddingTop: 10,
              paddingBottom: 10,
              paddingHorizontal: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: palette.line,
              backgroundColor: palette.raised,
              color: palette.ink,
              fontFamily: fonts.body,
              fontSize: 15,
              textAlignVertical: 'top',
            }}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              label={t('plan.approve')}
              style={{ flex: 1 }}
              busy={busy === 'approve'}
              disabled={locked}
              onPress={() => void decide('approve')}
            />
            <Button
              label={
                comments.length ? t('plan.requestChangesCount', { count: comments.length }) : t('plan.requestChanges')
              }
              accessibilityLabel={revisable ? undefined : `${t('plan.requestChanges')}. ${t('plan.reviseHint')}`}
              variant="secondary"
              style={{ flex: 1 }}
              busy={busy === 'revise'}
              disabled={locked || !revisable}
              onPress={() => void decide('revise')}
            />
          </View>
          {maestro || newConversation ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {maestro ? (
                <Button
                  label={t('plan.withMaestro')}
                  accessibilityLabel={t('plan.maestro.title')}
                  icon="sparkles"
                  size="sm"
                  variant="secondary"
                  style={{ flex: 1 }}
                  disabled={locked}
                  onPress={() => {
                    setError(null)
                    setPage('maestro')
                  }}
                />
              ) : null}
              {newConversation ? (
                <Button
                  label={t('plan.inNewChat')}
                  accessibilityLabel={t('plan.handoff.title')}
                  icon="plus"
                  size="sm"
                  variant="secondary"
                  style={{ flex: 1 }}
                  disabled={locked}
                  onPress={() => {
                    setError(null)
                    setPage('handoff')
                  }}
                />
              ) : null}
              <IconButton
                icon="trash"
                label={t('plan.discard')}
                color={palette.brick}
                size={20}
                disabled={locked}
                onPress={() => void decide('discard')}
              />
            </View>
          ) : (
            <Button
              label={t('plan.discard')}
              variant="danger"
              size="sm"
              busy={busy === 'discard'}
              disabled={locked}
              onPress={() => void decide('discard')}
            />
          )}
        </Dock>
      </>
    )

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
      onRequestClose={() => {
        if (page === 'handoff-model') setPage('handoff')
        else if (page !== 'plan') setPage('plan')
        else onClose()
      }}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{
          flex: 1,
          backgroundColor: palette.sheet,
          // An iOS page sheet starts below the status bar; elsewhere the sheet covers the screen.
          paddingTop: Platform.OS === 'ios' ? 6 : insets.top + 6,
        }}
      >
        <View style={{ flex: 1 }} accessibilityViewIsModal>
          {content}
        </View>
        <View style={{ height: insets.bottom, backgroundColor: palette.sheet }} />
      </KeyboardAvoidingView>
    </Modal>
  )
}

function SheetTop({
  eyebrow,
  closeLabel,
  onClose,
  back,
}: {
  eyebrow?: string
  closeLabel?: string
  onClose?: () => void
  back?: { label: string; onPress: () => void }
}) {
  const { palette } = useTheme()
  return (
    <View>
      {Platform.OS === 'ios' ? (
        <View style={{ alignItems: 'center', paddingBottom: 4 }}>
          <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: palette.lineStrong }} />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }}>
        <View style={{ flex: 1, alignItems: 'flex-start' }}>
          {back ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={back.label}
              onPress={back.onPress}
              hitSlop={8}
              style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingRight: 8, marginLeft: -6 }}
            >
              <Icon name="chev-left" size={22} color={palette.brass} />
              <AppText numberOfLines={1} style={{ color: palette.brass, fontFamily: fonts.bodySemi }}>
                {back.label}
              </AppText>
            </Pressable>
          ) : eyebrow ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: palette.cue }} />
              <AppText
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  lineHeight: 14,
                  letterSpacing: 0.66,
                  color: palette.cueInk,
                  textTransform: 'uppercase',
                }}
              >
                {eyebrow}
              </AppText>
            </View>
          ) : null}
        </View>
        {onClose && closeLabel ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
            onPress={onClose}
            hitSlop={8}
            style={{ minHeight: 44, paddingLeft: 10, justifyContent: 'center' }}
          >
            <AppText style={{ color: palette.brass, fontFamily: fonts.bodySemi }}>{closeLabel}</AppText>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

function Notice({ icon, tone, text }: { icon: 'lock' | 'alert'; tone: 'cue' | 'plain'; text: string }) {
  const { palette } = useTheme()
  return (
    <View
      accessibilityRole="text"
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingVertical: 9,
        paddingHorizontal: 11,
        borderRadius: 12,
        backgroundColor: tone === 'cue' ? palette.cueSoft : palette.surface,
      }}
    >
      <Icon name={icon} size={16} color={tone === 'cue' ? palette.cueInk : palette.muted} />
      <AppText variant="sub" style={{ flex: 1, color: tone === 'cue' ? palette.cueInk : palette.muted }}>
        {text}
      </AppText>
    </View>
  )
}

function Dock({ children }: { children: ReactNode }) {
  const { palette } = useTheme()
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 10,
        gap: 8,
        borderTopWidth: 1,
        borderTopColor: palette.line,
        backgroundColor: palette.sheet,
      }}
    >
      {children}
    </View>
  )
}

function ReadView({
  text,
  comments,
  editingLine,
  locked,
  onEdit,
  onSave,
  onCancel,
}: {
  text: string
  comments: Record<number, string>
  editingLine: number | null
  locked: boolean
  onEdit: (line: number) => void
  onSave: (line: number, text: string) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const blocks = useMemo(() => planBlocks(text), [text])
  return (
    <View>
      {locked ? null : (
        <AppText variant="small" tone="muted" style={{ marginBottom: 12 }}>
          {t('plan.commentHint')}
        </AppText>
      )}
      {blocks.map((block) => (
        <BlockRow
          key={`${block.line}:${block.source.length}`}
          block={block}
          comment={comments[block.line] ?? null}
          editing={editingLine === block.line}
          locked={locked}
          onEdit={() => onEdit(block.line)}
          onSave={(value) => onSave(block.line, value)}
          onCancel={onCancel}
        />
      ))}
    </View>
  )
}

function BlockRow({
  block,
  comment,
  editing,
  locked,
  onEdit,
  onSave,
  onCancel,
}: {
  block: PlanBlock
  comment: string | null
  editing: boolean
  locked: boolean
  onEdit: () => void
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const canComment = block.commentable && !locked
  return (
    <View style={{ marginLeft: Math.min(block.indent, 12) * 3 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AssistantMarkdown text={block.source} streaming={false} />
        </View>
        <View style={{ width: 34, alignItems: 'flex-end' }}>
          {canComment || (block.commentable && comment) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={comment ? t('plan.editComment') : t('plan.comment')}
              aria-disabled={!canComment}
              disabled={!canComment}
              onPress={onEdit}
              hitSlop={8}
              style={({ pressed }) => ({
                width: 30,
                height: 30,
                borderRadius: 9,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: comment ? palette.brassSoft : pressed ? palette.surface : 'transparent',
              })}
            >
              <Icon
                name={comment ? 'message' : 'message-plus'}
                size={17}
                color={comment ? palette.brass : palette.faint}
              />
            </Pressable>
          ) : null}
        </View>
      </View>
      {editing ? (
        <CommentEditor initial={comment ?? ''} removable={!!comment} onSave={onSave} onCancel={onCancel} />
      ) : comment ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 8,
            marginTop: -2,
            marginBottom: 12,
            paddingVertical: 8,
            paddingHorizontal: 10,
            borderLeftWidth: 3,
            borderLeftColor: palette.brass,
            borderTopRightRadius: 10,
            borderBottomRightRadius: 10,
            backgroundColor: palette.brassSoft,
          }}
        >
          <AppText variant="sub" style={{ flex: 1 }}>
            {comment}
          </AppText>
          {locked ? null : (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable accessibilityRole="button" onPress={onEdit} hitSlop={8}>
                <AppText variant="label" tone="brass">
                  {t('plan.editCommentShort')}
                </AppText>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => onSave('')} hitSlop={8}>
                <AppText variant="label" tone="brick">
                  {t('plan.removeComment')}
                </AppText>
              </Pressable>
            </View>
          )}
        </View>
      ) : null}
    </View>
  )
}

function CommentEditor({
  initial,
  removable,
  onSave,
  onCancel,
}: {
  initial: string
  removable: boolean
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const [value, setValue] = useState(initial)
  return (
    <View
      style={{
        marginTop: -2,
        marginBottom: 12,
        padding: 10,
        gap: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: palette.cue,
        backgroundColor: palette.cueSoft,
      }}
    >
      <TextInput
        value={value}
        onChangeText={setValue}
        multiline
        autoFocus
        maxLength={4000}
        placeholder={t('plan.commentPlaceholder')}
        placeholderTextColor={palette.faint}
        accessibilityLabel={t('plan.comment')}
        style={{
          minHeight: 64,
          maxHeight: 160,
          paddingVertical: 8,
          paddingHorizontal: 10,
          borderRadius: 9,
          backgroundColor: palette.raised,
          color: palette.ink,
          fontFamily: fonts.body,
          fontSize: 15,
          textAlignVertical: 'top',
        }}
      />
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
        {removable ? (
          <Button label={t('plan.removeComment')} variant="danger" size="sm" onPress={() => onSave('')} />
        ) : null}
        <Button label={t('common.cancel')} variant="ghost" size="sm" onPress={onCancel} />
        <Button
          label={t('plan.saveComment')}
          size="sm"
          disabled={!value.trim() && !removable}
          onPress={() => onSave(value)}
        />
      </View>
    </View>
  )
}

function EditView({
  text,
  edited,
  locked,
  onChange,
  onUndo,
}: {
  text: string
  edited: boolean
  locked: boolean
  onChange: (text: string) => void
  onUndo: () => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  return (
    <View style={{ gap: 10 }}>
      <AppText variant="small" tone="muted">
        {t('plan.editHint')}
      </AppText>
      <TextInput
        value={text}
        onChangeText={onChange}
        editable={!locked}
        multiline
        scrollEnabled={false}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        accessibilityLabel={t('plan.editLabel')}
        style={{
          minHeight: 320,
          padding: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: palette.line,
          backgroundColor: palette.raised,
          color: palette.ink,
          fontFamily: fonts.mono,
          fontSize: 13,
          lineHeight: 20,
          textAlignVertical: 'top',
        }}
      />
      {edited && !locked ? (
        <Button label={t('plan.undoEdits')} variant="ghost" size="sm" icon="restart" onPress={onUndo} />
      ) : null}
    </View>
  )
}

function DiffView({ before, after, version }: { before: string; after: string; version: number }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const rows = useMemo(() => lineDiff(before, after), [before, after])
  const changed = rows.some((row) => row.kind !== 'same')
  return (
    <View style={{ gap: 10 }}>
      <AppText variant="small" tone="muted">
        {changed ? t('plan.diffSince', { version }) : t('plan.noChanges')}
      </AppText>
      <View style={{ borderRadius: 12, borderWidth: 1, borderColor: palette.line, overflow: 'hidden' }}>
        {rows.map((row, index) => (
          <View
            // Rows have no identity of their own; the list is rebuilt whenever either version changes.
            key={index}
            style={{
              flexDirection: 'row',
              gap: 8,
              paddingVertical: 2,
              paddingHorizontal: 10,
              backgroundColor:
                row.kind === 'add'
                  ? mix(palette.moss, palette.sheet, 0.14)
                  : row.kind === 'del'
                    ? mix(palette.brick, palette.sheet, 0.14)
                    : 'transparent',
            }}
          >
            <AppText
              aria-hidden
              style={{ width: 10, fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 19, color: palette.faint }}
            >
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
            </AppText>
            <AppText
              accessibilityLabel={row.kind === 'same' ? undefined : `${row.kind === 'add' ? '+' : '−'} ${row.text}`}
              style={{
                flex: 1,
                fontFamily: fonts.mono,
                fontSize: 12.5,
                lineHeight: 19,
                color: row.kind === 'add' ? palette.moss : row.kind === 'del' ? palette.brick : palette.muted,
              }}
            >
              {row.text || ' '}
            </AppText>
          </View>
        ))}
      </View>
    </View>
  )
}

const profileLabel = (profile: MobileMaestroProfile, t: Translate) =>
  profile.source === 'global'
    ? t('plan.maestro.global')
    : profile.source === 'builtin' && isStrategy(profile.strategy)
      ? t(`plan.maestro.strategy.${profile.strategy}`)
      : profile.name

const STRATEGIES = ['balanced', 'best-quality', 'fast', 'economy'] as const
const isStrategy = (value: string): value is (typeof STRATEGIES)[number] =>
  (STRATEGIES as readonly string[]).includes(value)

function MaestroPage({
  profiles,
  lastUsedId,
  locked,
  busy,
  errorLine,
  onBack,
  onStart,
}: {
  profiles: MobileMaestroProfile[]
  lastUsedId: string | null
  locked: boolean
  busy: boolean
  errorLine: ReactNode
  onBack: () => void
  onStart: (profileId: string) => void
}) {
  const { t, plural } = useI18n()
  const usable = (profile: MobileMaestroProfile | undefined) => !!profile?.orchestrator
  const [selected, setSelected] = useState<string | null>(() => {
    const last = profiles.find((profile) => profile.id === lastUsedId)
    return (usable(last) ? last : profiles.find(usable))?.id ?? null
  })
  const chosen = profiles.find((profile) => profile.id === selected)
  return (
    <>
      <View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
        <SheetTop back={{ label: t('common.back'), onPress: onBack }} />
        <AppText variant="title" accessibilityRole="header">
          {t('plan.maestro.title')}
        </AppText>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}>
        <AppText variant="sub" tone="muted" style={{ marginHorizontal: 4, lineHeight: 19 }}>
          {t('plan.maestro.body')}
        </AppText>
        {profiles.length ? (
          <Group>
            {profiles.map((profile) => {
              const strategy = isStrategy(profile.strategy) ? t(`plan.maestro.strategy.${profile.strategy}`) : null
              const sub = profile.orchestrator
                ? [
                    profile.source === 'custom' ? strategy : null,
                    profile.orchestrator.modelId,
                    plural('plan.maestro.agents', profile.agents.length),
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : t('plan.maestro.noOrchestrator')
              return (
                <Cell
                  key={profile.id}
                  icon="sparkles"
                  label={profileLabel(profile, t)}
                  sub={sub}
                  role="radio"
                  checked={profile.id === selected}
                  disabled={!profile.orchestrator || locked}
                  onPress={() => setSelected(profile.id)}
                />
              )
            })}
          </Group>
        ) : (
          <AppText tone="muted" style={{ marginTop: 16, marginHorizontal: 4 }}>
            {t('plan.maestro.none')}
          </AppText>
        )}
        {chosen?.agents.length ? (
          <AppText variant="small" tone="muted" style={{ marginTop: 8, marginHorizontal: 6 }} numberOfLines={3}>
            {chosen.agents.join(' · ')}
          </AppText>
        ) : null}
      </ScrollView>
      <Dock>
        {errorLine}
        <Button
          label={t('plan.maestro.start')}
          icon="sparkles"
          busy={busy}
          disabled={locked || !chosen?.orchestrator}
          onPress={() => chosen && onStart(chosen.id)}
        />
      </Dock>
    </>
  )
}

function HandoffPage({
  conversationId,
  picking,
  locked,
  busy,
  errorLine,
  onPage,
  onStart,
}: {
  conversationId: string
  picking: boolean
  locked: boolean
  busy: boolean
  errorLine: ReactNode
  onPage: (page: Page) => void
  onStart: (implementation: MobilePlanImplementation) => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const chats = useChatsController()
  const { active } = useServers()
  const models = useChats(useCallback((state: ChatsState) => state.models, []))
  const setup = useChats(useCallback((state: ChatsState) => state.setups[conversationId] ?? null, [conversationId]))
  const [selection, setSelection] = useState<{ providerId: string; modelId: string } | null>(null)
  const [reasoning, setReasoning] = useState('off')
  const [fastMode, setFastMode] = useState(false)
  const [placement, setPlacement] = useState<'shared' | 'worktree'>('shared')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void chats.loadModels().catch(() => {})
    if (!setup) void chats.loadSetup(conversationId).catch(() => {})
  }, [chats, conversationId, setup])

  const options = models?.options ?? []
  // It starts from this chat's own settings, as the desktop does; only what the chosen model offers is kept.
  useEffect(() => {
    if (ready || !models || !setup) return
    const start = setup.selection ?? models.defaultSelection
    const option = optionFor(models.options, start)
    setSelection(start)
    setReasoning(chatEffortChoices(option).includes(setup.reasoning) ? setup.reasoning : 'off')
    setFastMode(setup.fastMode && !!option?.fastMode)
    setReady(true)
  }, [models, setup, ready])

  const option = optionFor(options, selection)
  const efforts = chatEffortChoices(option)
  const pick = (picked: FleetSelectionOption | null) => {
    if (!picked) return
    setSelection({ providerId: picked.providerId, modelId: picked.modelId })
    if (!chatEffortChoices(picked).includes(reasoning)) setReasoning('off')
    if (!picked.fastMode) setFastMode(false)
    onPage('handoff')
  }

  if (picking)
    return (
      <>
        <View style={{ paddingHorizontal: 16 }}>
          <SheetTop back={{ label: t('common.back'), onPress: () => onPage('handoff') }} />
          <AppText variant="title" accessibilityRole="header">
            {t('plan.handoff.chooseModel')}
          </AppText>
        </View>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <ModelList
            options={options}
            current={selection}
            disabled={false}
            onPick={pick}
            defaultChoice={null}
            foot={t('plan.handoff.modelsFoot', { server: active?.name ?? '' })}
          />
        </ScrollView>
      </>
    )

  return (
    <>
      <View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
        <SheetTop back={{ label: t('common.back'), onPress: () => onPage('plan') }} />
        <AppText variant="title" accessibilityRole="header">
          {t('plan.handoff.title')}
        </AppText>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}>
        <AppText variant="sub" tone="muted" style={{ marginHorizontal: 4, lineHeight: 19 }}>
          {t('plan.handoff.body')}
        </AppText>
        <Group label={t('setup.model')}>
          <Cell
            icon="sparkles"
            label={option?.modelLabel ?? selection?.modelId ?? t('plan.handoff.chooseModel')}
            sub={option?.providerLabel ?? null}
            chevron
            disabled={!ready || locked}
            onPress={() => onPage('handoff-model')}
          />
          {option?.fastMode ? (
            <Cell
              icon="zap"
              label={t('setup.fast')}
              sub={t('setup.fastDesc')}
              trailing={
                <Switch
                  accessibilityLabel={t('setup.fast')}
                  value={fastMode}
                  disabled={locked}
                  onValueChange={setFastMode}
                  trackColor={{ true: palette.brass, false: palette.lineStrong }}
                />
              }
            />
          ) : null}
        </Group>
        {efforts.length ? (
          <Group label={t('setup.effort')}>
            <Pills
              label={t('setup.effort')}
              value={reasoning}
              disabled={locked}
              options={efforts.map((effort) => ({
                value: effort,
                label: effort === 'off' ? t('setup.effortDefault') : effortLabel(effort, t),
              }))}
              onChange={setReasoning}
            />
          </Group>
        ) : null}
        <Group label={t('plan.handoff.where')}>
          <Cell
            icon="folder"
            label={t('plan.handoff.shared')}
            sub={t('plan.handoff.sharedSub')}
            role="radio"
            checked={placement === 'shared'}
            disabled={locked}
            onPress={() => setPlacement('shared')}
          />
          <Cell
            icon="branch"
            label={t('plan.handoff.worktree')}
            sub={t('plan.handoff.worktreeSub')}
            role="radio"
            checked={placement === 'worktree'}
            disabled={locked}
            onPress={() => setPlacement('worktree')}
          />
        </Group>
      </ScrollView>
      <Dock>
        {errorLine}
        <Button
          label={t('plan.handoff.start')}
          busy={busy}
          disabled={locked || !selection || !ready}
          onPress={() =>
            selection &&
            onStart({
              target: 'standard',
              settings: {
                ...selection,
                reasoning: efforts.includes(reasoning) ? reasoning : 'off',
                fastMode: !!option?.fastMode && fastMode,
              },
              placement,
            })
          }
        />
      </Dock>
    </>
  )
}
