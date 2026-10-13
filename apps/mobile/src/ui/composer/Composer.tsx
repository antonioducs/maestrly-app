import { FLEET_FILES_FEATURE, FLEET_MESSAGE_TEXT_MAX, type FleetBot } from '@maestrly/bot-fleet-protocol'
import { useCallback, useRef, useState, type ReactNode, type Ref } from 'react'
import { AccessibilityInfo, Linking, Pressable, TextInput, View } from 'react-native'
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

/** Unsent text per conversation, kept while the app runs so leaving one and coming back keeps what was being written. */
const drafts = new Map<string, string>()
const MAX_HEIGHT = 140
const selectFiles = (state: FleetState) => state.features.includes(FLEET_FILES_FEATURE)
const selectOnline = (state: FleetState) => state.connection === 'open'

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
  inputRef?: Ref<TextInput>
  initialText?: string
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? initialText ?? '')
  const [attachments, setAttachments] = useState<OutboxAttachment[]>([])
  const [issue, setIssue] = useState<AttachmentIssue | null>(null)
  const [height, setHeight] = useState(24)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  const latestText = useRef(text)
  latestText.current = text
  const setText = useCallback(
    (value: string) => {
      latestText.current = value
      setTextState(value)
      if (value) drafts.set(draftKey, value)
      else drafts.delete(draftKey)
    },
    [draftKey]
  )
  const dictation = useDictation((heard) => setText(appendDictation(latestText.current, heard)))
  const listening = dictation.state.phase !== 'idle'
  const dictationIssue = dictation.state.phase === 'idle' ? dictation.state.issue : null
  const add = (picked: OutboxAttachment[]) => {
    const problem = validateAttachments(attachments, picked, filesEnabled)
    setIssue(problem)
    if (!problem) setAttachments((current) => [...current, ...picked])
  }
  const empty = !text.trim() && attachments.length === 0
  const stoppable = stopLabel !== null && empty

  async function send() {
    if (empty || busy) return
    const body = text.trim()
    const files = attachments
    setBusy(true)
    setError(false)
    try {
      await onSend(body, files)
      setText('')
      setAttachments([])
      setIssue(null)
    } catch {
      // What was written stays in the field, to send again.
      setError(true)
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
          {issue ? t(`attach.error.${issue}`) : t('composer.failed')}
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
      <View
        style={{
          paddingVertical: 6,
          paddingRight: 6,
          paddingLeft: 8,
          borderRadius: 24,
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
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={(value) => {
            setText(value)
            if (dictationIssue) dictation.dismiss()
          }}
          multiline
          maxLength={FLEET_MESSAGE_TEXT_MAX}
          placeholder={placeholder}
          placeholderTextColor={palette.faint}
          accessibilityLabel={placeholder}
          onContentSizeChange={(event) => setHeight(event.nativeEvent.contentSize.height)}
          style={{
            display: listening ? 'none' : 'flex',
            minHeight: 34,
            // The reported content height already includes the padding; adding to it would grow the field forever.
            height: Math.min(MAX_HEIGHT, Math.max(34, height)),
            paddingTop: 6,
            paddingBottom: 4,
            paddingHorizontal: 8,
            color: palette.ink,
            fontFamily: fonts.body,
            fontSize: 16,
            lineHeight: 22,
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
                onPress={() => setPicking(true)}
                style={{ width: 44, height: 44, borderRadius: 22 }}
              />
              {setup}
            </>
          )}
          <View style={{ flex: 1 }} />
          {dictation.available && !listening ? (
            <IconButton
              icon="mic"
              label={t('dictation.start')}
              disabled={disabled}
              onPress={() => {
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
              accessibilityLabel={stoppable ? (stopLabel ?? '') : t('composer.send')}
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
              <Icon name={stoppable ? 'stop' : 'arrow-up'} size={18} color={palette.canvas} strokeWidth={2.2} />
            </Pressable>
          )}
        </View>
      </View>
      <AttachSheet open={picking} onClose={() => setPicking(false)} filesEnabled={filesEnabled} onPicked={add} />
    </View>
  )
}

/** The composer of a bot's conversation. */
export function Composer({ bot, inputRef }: { bot: FleetBot; inputRef?: Ref<TextInput> }) {
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
    />
  )
}
