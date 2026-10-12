import { FLEET_FILES_FEATURE, FLEET_MESSAGE_TEXT_MAX, type FleetBot } from '@maestrly/bot-fleet-protocol'
import { useCallback, useState, type Ref } from 'react'
import { AccessibilityInfo, Pressable, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { validateAttachments, type AttachmentIssue, type OutboxAttachment } from '../../fleet/attachments'
import { useFleet, useFleetController } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { IconButton } from '../primitives/IconButton'
import { AppText } from '../primitives/Text'
import { AttachmentChips } from './AttachmentChips'
import { AttachSheet } from './AttachSheet'
import { SetupPill } from './SetupPill'

/** Unsent text per bot, kept while the app runs so leaving a bot and coming back keeps what was being written. */
const drafts = new Map<string, string>()
const MAX_HEIGHT = 140
const selectFiles = (state: FleetState) => state.features.includes(FLEET_FILES_FEATURE)
const selectOnline = (state: FleetState) => state.connection === 'open'

export function Composer({ bot, inputRef }: { bot: FleetBot; inputRef?: Ref<TextInput> }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  const controller = useFleetController()
  const serverFiles = useFleet(selectFiles)
  const online = useFleet(selectOnline)
  const [text, setTextState] = useState(() => drafts.get(bot.id) ?? '')
  const [attachments, setAttachments] = useState<OutboxAttachment[]>([])
  const [issue, setIssue] = useState<AttachmentIssue | null>(null)
  const [height, setHeight] = useState(24)
  const [picking, setPicking] = useState(false)
  const filesEnabled = serverFiles && bot.capabilities.includes(FLEET_FILES_FEATURE)

  const setText = useCallback(
    (value: string) => {
      setTextState(value)
      if (value) drafts.set(bot.id, value)
      else drafts.delete(bot.id)
    },
    [bot.id]
  )
  const add = (picked: OutboxAttachment[]) => {
    const problem = validateAttachments(attachments, picked, filesEnabled)
    setIssue(problem)
    if (!problem) setAttachments((current) => [...current, ...picked])
  }
  const empty = !text.trim() && attachments.length === 0
  const stoppable = bot.status === 'working' && empty

  async function send() {
    if (empty) return
    const body = text.trim()
    const files = attachments
    setText('')
    setAttachments([])
    setIssue(null)
    await controller.send(bot.id, body, files)
    AccessibilityInfo.announceForAccessibility(online ? t('announce.sent') : t('announce.queuedOffline'))
  }

  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: insets.bottom + 6 }}>
      {issue ? (
        <AppText accessibilityRole="alert" style={{ marginHorizontal: 8, marginBottom: 6, fontSize: 13, color: palette.brick }}>
          {t(`attach.error.${issue}`)}
        </AppText>
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
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={FLEET_MESSAGE_TEXT_MAX}
          placeholder={t('composer.placeholder', { name: bot.name })}
          placeholderTextColor={palette.faint}
          accessibilityLabel={t('composer.placeholder', { name: bot.name })}
          onContentSizeChange={(event) => setHeight(event.nativeEvent.contentSize.height)}
          style={{
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
          <IconButton icon="plus" label={t('composer.attach')} onPress={() => setPicking(true)} style={{ width: 38, height: 38, borderRadius: 19 }} />
          <SetupPill bot={bot} />
          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={stoppable ? t('composer.stop', { name: bot.name }) : t('composer.send')}
            aria-disabled={empty && !stoppable}
            disabled={empty && !stoppable}
            onPress={() => (stoppable ? void controller.action(bot.id, 'cancel') : void send())}
            hitSlop={4}
            style={({ pressed }) => ({
              width: 36,
              height: 36,
              marginLeft: 4,
              borderRadius: 18,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: empty && !stoppable ? palette.lineStrong : palette.ink,
              transform: [{ scale: pressed ? 0.94 : 1 }],
            })}
          >
            <Icon name={stoppable ? 'stop' : 'arrow-up'} size={18} color={palette.raised} strokeWidth={2.2} />
          </Pressable>
        </View>
      </View>
      <AttachSheet open={picking} onClose={() => setPicking(false)} filesEnabled={filesEnabled} onPicked={add} />
    </View>
  )
}
