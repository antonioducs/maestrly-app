import { FLEET_FILES_FEATURE, FLEET_MESSAGE_TEXT_MAX, type FleetBot } from '@maestrly/bot-fleet-protocol'
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import {
  AccessibilityInfo,
  Alert,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  TextInput,
  type TextInputInstance,
  useWindowDimensions,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { appendDictation } from '../../dictation/session'
import { useDictation } from '../../dictation/useDictation'
import { validateAttachments, type AttachmentIssue, type OutboxAttachment } from '../../fleet/attachments'
import { useFleet, useFleetController } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { IconButton } from '../primitives/IconButton'
import { AppText } from '../primitives/Text'
import { AttachmentChips } from './AttachmentChips'
import { AttachSheet } from './AttachSheet'
import { Listening } from './Listening'
import { SetupPill } from './SetupPill'
import { useClipboardImage } from './useClipboardImage'

/** Unsent text per conversation, kept while the app runs so leaving one and coming back keeps what was being written. */
const drafts = new Map<string, string>()
const MIN_HEIGHT = 44
/** The field grows with the text up to this share of the screen, then scrolls. */
const MAX_SHARE = 0.4
const MAX_HEIGHT_CAP = 360
const selectFiles = (state: FleetState) => state.features.includes(FLEET_FILES_FEATURE)
const selectOnline = (state: FleetState) => state.connection === 'open'

/** A failed send whose message is for the person, shown instead of the generic one. */
export class ShownError extends Error {}

/** Drops the draft of a conversation, such as the new chat's once it is sent. */
export const clearDraft = (key: string) => drafts.delete(key)

/**
 * The message field with its attachments, setup pill and send button, for a bot or a chat. Sending clears the field
 * at once: the message then shows in the conversation, waiting on the phone until the server takes it.
 */
export function ComposerShell({
  draftKey,
  placeholder,
  filesEnabled,
  setup,
  stopLabel,
  onStop,
  onSend,
  disabled,
  inputRef,
  initialText,
  editing = null,
  onEdit,
  onCancelEdit,
}: {
  draftKey: string
  placeholder: string
  filesEnabled: boolean
  setup: ReactNode
  /** Set while a turn runs: an empty field turns the send button into a stop button. */
  stopLabel: string | null
  onStop: () => Promise<unknown>
  onSend: (text: string, attachments: OutboxAttachment[]) => Promise<unknown>
  disabled?: boolean
  inputRef?: Ref<TextInputInstance>
  initialText?: string
  /** A message being edited: its text fills the field, and sending replaces the message with it. */
  editing?: { itemId: string; text: string } | null
  /** Rejects with an error whose message tells the person why the edit did not go through. */
  onEdit?: (text: string) => Promise<unknown>
  onCancelEdit?: () => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? initialText ?? '')
  const [attachments, setAttachments] = useState<OutboxAttachment[]>([])
  const [issue, setIssue] = useState<AttachmentIssue | null>(null)
  const window = useWindowDimensions()
  const maxHeight = Math.max(MIN_HEIGHT * 3, Math.min(MAX_HEIGHT_CAP, Math.round(window.height * MAX_SHARE)))
  // Only the web measures the text itself: a native multiline field already grows with it up to `maxHeight`.
  const [height, setHeight] = useState(MIN_HEIGHT)
  const [picking, setPicking] = useState(false)
  const [focused, setFocused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | boolean>(false)

  const latestText = useRef(text)
  latestText.current = text
  const field = useRef<TextInputInstance>(null)
  useImperativeHandle(inputRef, () => field.current as TextInputInstance)
  const editingId = editing?.itemId ?? null
  const editingRef = useRef(editingId)
  editingRef.current = editingId
  const showText = useCallback((value: string) => {
    // A web textarea never measures shorter than its height: shrink it, and the next measure grows it back.
    if (Platform.OS === 'web' && value.length < latestText.current.length) setHeight(MIN_HEIGHT)
    latestText.current = value
    setTextState(value)
  }, [])
  const setText = useCallback(
    (value: string) => {
      showText(value)
      // An edit is not a draft: the draft waits, as it was, until the edit ends.
      if (editingRef.current) return
      if (value) drafts.set(draftKey, value)
      else drafts.delete(draftKey)
    },
    [draftKey, showText]
  )
  const editingText = editing?.text ?? ''
  const wasEditing = useRef(false)
  useEffect(() => {
    if (editingId) {
      wasEditing.current = true
      setError(false)
      showText(editingText)
      const timer = setTimeout(() => field.current?.focus(), 50)
      return () => clearTimeout(timer)
    }
    if (!wasEditing.current) return
    wasEditing.current = false
    setError(false)
    showText(drafts.get(draftKey) ?? '')
  }, [editingId, editingText, draftKey, showText])
  const dictation = useDictation((heard) => setText(appendDictation(latestText.current, heard)))
  const listening = dictation.state.phase !== 'idle'
  const dictationIssue = dictation.state.phase === 'idle' ? dictation.state.issue : null
  const add = (picked: OutboxAttachment[]) => {
    const problem = validateAttachments(attachments, picked, filesEnabled)
    setIssue(problem)
    if (!problem) setAttachments((current) => [...current, ...picked])
  }
  const clipboard = useClipboardImage(!editingId)
  async function pasteImage() {
    try {
      const pasted = await clipboard.paste()
      if (pasted) add([pasted])
    } catch {
      setError(t('attach.pasteFailed'))
    }
  }
  const empty = !text.trim() && attachments.length === 0
  const stoppable = stopLabel !== null && empty && !editingId

  async function send() {
    if (empty || busy) return
    const body = text.trim()
    if (editingId && onEdit) {
      setBusy(true)
      setError(false)
      try {
        await onEdit(body)
        Keyboard.dismiss()
      } catch (cause) {
        setError(cause instanceof Error && cause.message ? cause.message : true)
      } finally {
        setBusy(false)
      }
      return
    }
    const files = attachments
    setBusy(true)
    setError(false)
    try {
      await onSend(body, files)
      setText('')
      setAttachments([])
      setIssue(null)
      // Sent, or waiting on the phone until the server is reachable: the keyboard makes way for the conversation.
      Keyboard.dismiss()
    } catch (cause) {
      // What was written stays in the field, to send again.
      setError(cause instanceof ShownError && cause.message ? cause.message : true)
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    try {
      await onStop()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: insets.bottom + 6 }}>
      {issue || error ? (
        <AppText
          accessibilityRole="alert"
          style={{ marginHorizontal: 8, marginBottom: 6, fontSize: 13, color: palette.brick }}
        >
          {issue ? t(`attach.error.${issue}`) : typeof error === 'string' ? error : t('composer.failed')}
        </AppText>
      ) : dictationIssue ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 8, marginBottom: 6 }}>
          <AppText accessibilityRole="alert" style={{ flex: 1, fontSize: 13, color: palette.brick }}>
            {t(`dictation.error.${dictationIssue}`)}
          </AppText>
          {dictationIssue === 'denied' ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => {
                dictation.dismiss()
                void Linking.openSettings().catch(() => {})
              }}
            >
              <AppText style={{ fontSize: 13, color: palette.brass, fontFamily: fonts.bodySemi }}>
                {t('dictation.openSettings')}
              </AppText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {editingId ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 8, marginBottom: 6 }}>
          <Icon name="pencil" size={14} color={palette.brass} />
          <AppText variant="small" style={{ flex: 1, color: palette.brass, fontFamily: fonts.bodySemi }}>
            {t('edit.editing')}
          </AppText>
          <Pressable accessibilityRole="button" hitSlop={12} disabled={busy} onPress={() => onCancelEdit?.()}>
            <AppText variant="small" tone="muted" style={{ fontFamily: fonts.bodySemi }}>
              {t('common.cancel')}
            </AppText>
          </Pressable>
        </View>
      ) : null}
      <View
        style={{
          paddingVertical: 8,
          paddingRight: 8,
          paddingLeft: 8,
          borderRadius: 26,
          borderWidth: 1,
          borderColor: palette.line,
          backgroundColor: palette.raised,
        }}
      >
        <AttachmentChips
          attachments={attachments}
          onRemove={(uri) => {
            setAttachments((current) => current.filter((item) => item.uri !== uri))
            setIssue(null)
          }}
        />
        {listening ? (
          <Listening
            starting={dictation.state.phase === 'starting'}
            text={dictation.state.phase === 'listening' ? dictation.state.text : ''}
          />
        ) : null}
        {clipboard.available && focused && !listening ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void pasteImage()}
            hitSlop={6}
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              marginLeft: 4,
              marginBottom: 2,
              paddingVertical: 6,
              paddingHorizontal: 11,
              borderRadius: 15,
              backgroundColor: pressed ? palette.line : palette.surface,
            })}
          >
            <Icon name="clipboard" size={14} color={palette.ink} />
            <AppText style={{ fontFamily: fonts.bodyMedium, fontSize: 13.5, lineHeight: 18 }}>
              {t('attach.pasteImage')}
            </AppText>
          </Pressable>
        ) : null}
        <TextInput
          ref={field}
          value={text}
          onFocus={() => {
            setFocused(true)
            clipboard.check()
          }}
          onBlur={() => setFocused(false)}
          onChangeText={(value) => {
            setText(value)
            if (dictationIssue) dictation.dismiss()
          }}
          multiline
          maxLength={FLEET_MESSAGE_TEXT_MAX}
          placeholder={placeholder}
          placeholderTextColor={palette.faint}
          accessibilityLabel={placeholder}
          onContentSizeChange={
            Platform.OS === 'web' ? (event) => setHeight(event.nativeEvent.contentSize.height) : undefined
          }
          scrollEnabled
          style={{
            display: listening ? 'none' : 'flex',
            minHeight: MIN_HEIGHT,
            maxHeight,
            // The reported content height already includes the padding; adding to it would grow the field forever.
            ...(Platform.OS === 'web' ? { height: Math.min(maxHeight, Math.max(MIN_HEIGHT, height)) } : null),
            paddingTop: 10,
            paddingBottom: 8,
            paddingHorizontal: 10,
            color: palette.ink,
            fontFamily: fonts.body,
            fontSize: 17,
            lineHeight: 24,
            textAlignVertical: 'top',
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          {listening ? (
            <IconButton
              icon="x"
              label={t('dictation.cancel')}
              onPress={dictation.cancel}
              style={{ width: 44, height: 44, borderRadius: 22 }}
            />
          ) : (
            <>
              <IconButton
                icon="plus"
                label={t('composer.attach')}
                // An edit keeps the message's attachments; it changes its text only.
                disabled={!!editingId}
                onPress={() => {
                  clipboard.check()
                  setPicking(true)
                }}
                style={{ width: 44, height: 44, borderRadius: 22 }}
              />
              {setup}
            </>
          )}
          <View style={{ flex: 1 }} />
          {(dictation.available || dictation.needsBuild) && !listening ? (
            <IconButton
              icon="mic"
              label={t('dictation.start')}
              disabled={disabled}
              onPress={() => {
                if (dictation.needsBuild) return Alert.alert(t('dictation.start'), t('dictation.needsBuild'))
                setError(false)
                dictation.start()
              }}
              size={21}
              style={{ width: 44, height: 44, borderRadius: 22 }}
            />
          ) : null}
          {listening ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('dictation.stop')}
              onPress={dictation.stop}
              hitSlop={4}
              style={({ pressed }) => ({
                width: 36,
                height: 36,
                marginLeft: 4,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: palette.ink,
                transform: [{ scale: pressed ? 0.94 : 1 }],
              })}
            >
              <Icon name="stop" size={16} color={palette.canvas} strokeWidth={2.2} />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={stoppable ? (stopLabel ?? '') : editingId ? t('edit.save') : t('composer.send')}
              aria-disabled={disabled || busy || (empty && !stoppable)}
              disabled={disabled || busy || (empty && !stoppable)}
              onPress={() => void (stoppable ? stop() : send())}
              hitSlop={4}
              style={({ pressed }) => ({
                width: 36,
                height: 36,
                marginLeft: 4,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: disabled || (empty && !stoppable) ? palette.lineStrong : palette.ink,
                transform: [{ scale: pressed ? 0.94 : 1 }],
              })}
            >
              <Icon
                name={stoppable ? 'stop' : editingId ? 'check' : 'arrow-up'}
                size={18}
                color={palette.canvas}
                strokeWidth={2.2}
              />
            </Pressable>
          )}
        </View>
      </View>
      <AttachSheet
        open={picking}
        onClose={() => setPicking(false)}
        filesEnabled={filesEnabled}
        onPicked={add}
        onPaste={clipboard.available ? pasteImage : undefined}
      />
    </View>
  )
}

/** The composer of a bot's conversation. */
export function Composer({
  bot,
  inputRef,
  editing,
  onEdit,
  onCancelEdit,
}: {
  bot: FleetBot
  inputRef?: Ref<TextInputInstance>
  editing?: { itemId: string; text: string } | null
  onEdit?: (text: string) => Promise<unknown>
  onCancelEdit?: () => void
}) {
  const { t } = useI18n()
  const { active } = useServers()
  const controller = useFleetController()
  const serverFiles = useFleet(selectFiles)
  const online = useFleet(selectOnline)
  return (
    <ComposerShell
      draftKey={`${active?.id ?? ''}:bot:${bot.id}`}
      placeholder={t('composer.placeholder', { name: bot.name })}
      filesEnabled={serverFiles && bot.capabilities.includes(FLEET_FILES_FEATURE)}
      setup={<SetupPill bot={bot} />}
      stopLabel={bot.status === 'working' ? t('composer.stop', { name: bot.name }) : null}
      onStop={() => controller.action(bot.id, 'cancel')}
      onSend={async (text, files) => {
        await controller.send(bot.id, text, files)
        AccessibilityInfo.announceForAccessibility(online ? t('announce.sent') : t('announce.queuedOffline'))
      }}
      inputRef={inputRef}
      editing={editing}
      onEdit={onEdit}
      onCancelEdit={onCancelEdit}
    />
  )
}
