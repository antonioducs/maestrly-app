import { FLEET_NOTE_MAX, type FleetBot, type FleetScreenSurface } from '@maestrly/bot-fleet-protocol'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Switch,
  TextInput,
  View,
  type TextInputInstance,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFleet, useFleetController } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { GatewayError } from '../../gateway/client'
import { useI18n, type MessageKey } from '../../i18n'
import { prefs } from '../../prefs'
import type { ScreenKey } from '../../screen/keysyms'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { Icon, type IconName } from '../icons'
import { Button } from '../primitives/Button'
import { IconButton } from '../primitives/IconButton'
import { Sheet } from '../primitives/Sheet'
import { AppText } from '../primitives/Text'
import { ScreenView } from './ScreenView'
import type { ScreenViewHandle } from './screen-view-props'
import { useBotScreen, type ScreenIssue } from './use-bot-screen'

const KEYS: { key: ScreenKey; label: MessageKey; icon?: IconName }[] = [
  { key: 'Return', label: 'screen.key.return', icon: 'return' },
  { key: 'Tab', label: 'screen.key.tab' },
  { key: 'Escape', label: 'screen.key.escape' },
  { key: 'BackSpace', label: 'screen.key.backspace', icon: 'backspace' },
]

const ENDED: Record<ScreenIssue, { title: MessageKey; body: MessageKey; icon: IconName; retry: boolean }> = {
  error: { title: 'screen.ended.error.title', body: 'screen.ended.error.body', icon: 'wifi-off', retry: true },
  offline: { title: 'screen.ended.offline.title', body: 'screen.ended.offline.body', icon: 'pause', retry: true },
  conflict: { title: 'screen.ended.conflict.title', body: 'screen.ended.conflict.body', icon: 'laptop', retry: true },
  restart: { title: 'screen.ended.restart.title', body: 'screen.ended.restart.body', icon: 'restart', retry: false },
  unsupported: {
    title: 'screen.ended.unsupported.title',
    body: 'screen.ended.unsupported.body',
    icon: 'alert',
    retry: false,
  },
  // Control that ended reconnects to watch on its own; these only show if that fails too.
  released: { title: 'screen.ended.error.title', body: 'screen.ended.error.body', icon: 'wifi-off', retry: true },
  lost: { title: 'screen.ended.error.title', body: 'screen.ended.error.body', icon: 'wifi-off', retry: true },
}

/**
 * A bot's computer on the phone, to get it past what only its owner can do (a password, a code, a CAPTCHA): it opens
 * watching, framed on where the bot's pointer stopped; the owner takes control, taps and types through a field of the
 * phone, then gives the screen back with a note. It is not a remote desktop: no drag, right click or windows of its own.
 */
export function BotScreen({
  bot,
  surface,
  deviceId,
  giveOnOpen,
  onClose,
}: {
  bot: FleetBot
  surface: FleetScreenSurface
  deviceId: string
  /** Opens on the sheet that gives the screen back, as the conversation's card asks. */
  giveOnOpen?: boolean
  onClose: () => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  const controller = useFleetController()
  const name = bot.name
  const page = useRef<ScreenViewHandle>(null)
  const input = useRef<TextInputInstance>(null)
  const help = useFleet(
    useCallback(
      (state: FleetState) =>
        state.inbox.find((item) => item.botId === bot.id && item.interaction.kind === 'help')?.interaction ?? null,
      [bot.id]
    )
  )
  const [toast, setToast] = useState<{ text: string; tone: 'plain' | 'cue' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((text: string, tone: 'plain' | 'cue' = 'plain') => {
    setToast({ text, tone })
    AccessibilityInfo.announceForAccessibility(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2800)
  }, [])
  useEffect(() => () => void (toastTimer.current && clearTimeout(toastTimer.current)), [])

  const screen = useBotScreen({
    controller,
    bot,
    surface,
    deviceId,
    page,
    stopLabel: t('screen.stop', { name }),
    onWatchTap: () => showToast(t('screen.watchTap')),
    onControlLost: () => showToast(t('screen.controlLost', { name }), 'cue'),
  })
  const control = screen.mode === 'control'
  const live = screen.phase === 'live'
  // What a tap while watching said no longer holds once this phone controls the screen.
  useEffect(() => {
    if (control) setToast((current) => (current?.tone === 'plain' ? null : current))
  }, [control])
  const other = bot.takeover.state === 'human' && bot.takeover.deviceId !== deviceId ? bot.takeover.deviceName : null

  // --- Taking control and giving it back. ---
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState<'give' | 'conflict' | null>(giveOnOpen ? 'give' : null)
  const [conflictDevice, setConflictDevice] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [resume, setResume] = useState(true)
  const [giveError, setGiveError] = useState<string | null>(null)
  const [takeError, setTakeError] = useState<string | null>(null)
  async function take() {
    setBusy(true)
    setTakeError(null)
    try {
      await controller.takeover(bot.id)
    } catch (cause) {
      if (cause instanceof GatewayError && cause.code === 'CONFLICT') {
        setConflictDevice(bot.takeover.deviceId !== deviceId ? bot.takeover.deviceName : null)
        setSheet('conflict')
      } else setTakeError(t('screen.take.failed'))
    } finally {
      setBusy(false)
    }
  }
  async function giveBack() {
    setBusy(true)
    setGiveError(null)
    screen.giving(true)
    try {
      await controller.releaseTakeover(bot.id, note.trim() || null, resume)
      AccessibilityInfo.announceForAccessibility(t('screen.given'))
      setSheet(null)
      onClose()
    } catch {
      screen.giving(false)
      setGiveError(t('screen.give.failed'))
      // The gateway ends the control session before it asks the bot; a refused release keeps the takeover.
      screen.reconnect()
    } finally {
      setBusy(false)
    }
  }
  // A takeover from here that ended elsewhere closes its sheet.
  useEffect(() => {
    if (!control && sheet === 'give') setSheet(null)
  }, [control, sheet])

  // --- The gesture guide, the first time this phone controls a screen. ---
  const [guide, setGuide] = useState(false)
  useEffect(() => {
    if (!control || !live) return
    let cancelled = false
    void prefs.get('prefs.screenGuide').then((seen) => {
      if (!cancelled && !seen) setGuide(true)
    })
    return () => {
      cancelled = true
    }
  }, [control, live])
  const closeGuide = () => {
    setGuide(false)
    void prefs.set('prefs.screenGuide', '1')
  }

  // --- Typing through the phone's own field, where its keyboard can offer the code a text message brought. ---
  const [text, setText] = useState('')
  const [keyboard, setKeyboard] = useState(false)
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true))
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false))
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])
  const sendText = () => {
    if (!text) return
    if (screen.typeText(text)) setText('')
    else showToast(t('screen.type.offline'))
  }

  const status = control
    ? { text: t('screen.controlling'), color: palette.cueInk }
    : other
      ? { text: t('screen.watchingOther', { device: other }), color: palette.muted }
      : { text: t('screen.watching'), color: palette.muted }
  const ended = screen.phase === 'ended' && screen.issue ? ENDED[screen.issue] : null

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'web' ? undefined : 'padding'}
      style={{ flex: 1, backgroundColor: palette.canvas, paddingTop: insets.top }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          paddingLeft: 4,
          paddingRight: 12,
          paddingBottom: 8,
        }}
      >
        <IconButton icon="chev-down" label={t('screen.close')} onPress={onClose} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="heading" numberOfLines={1} accessibilityRole="header">
            {t('screen.title', { name })}
          </AppText>
          <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View
              style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: control ? palette.cue : palette.faint }}
            />
            <AppText variant="small" numberOfLines={1} style={{ color: status.color, flexShrink: 1 }}>
              {status.text}
            </AppText>
          </View>
        </View>
        {control ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('screen.done')}
            disabled={busy}
            onPress={() => {
              input.current?.blur()
              setGiveError(null)
              setSheet('give')
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              height: 36,
              paddingLeft: 10,
              paddingRight: 14,
              borderRadius: 10,
              backgroundColor: palette.cue,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Icon name="check" size={18} color="#1f201e" strokeWidth={2.2} />
            <AppText style={{ fontFamily: fonts.bodySemi, fontSize: 14.5, color: '#1f201e' }}>
              {t('screen.done')}
            </AppText>
          </Pressable>
        ) : null}
      </View>

      {help && help.kind === 'help' ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            marginHorizontal: 10,
            marginBottom: 8,
            paddingVertical: 7,
            paddingLeft: 12,
            paddingRight: 7,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: mix(palette.cue, palette.line, 0.55),
            backgroundColor: palette.cueSoft,
          }}
        >
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: palette.cue }} />
          <AppText numberOfLines={2} style={{ flex: 1, fontSize: 13.5, lineHeight: 18 }}>
            {help.reason}
          </AppText>
          {screen.view.stop ? <Chip icon="target" label={t('screen.goToStop')} onPress={screen.focusStop} /> : null}
        </View>
      ) : null}

      <View
        style={{
          flex: 1,
          minHeight: 0,
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: palette.line,
          backgroundColor: palette.codeBg,
        }}
      >
        <ScreenView ref={page} label={t('screen.label', { name })} onMessage={screen.onPageMessage} />
        {live && (!screen.view.fit || (!help && screen.view.stop)) ? (
          <View
            pointerEvents="box-none"
            style={{ position: 'absolute', right: 10, bottom: 10, flexDirection: 'row', gap: 6 }}
          >
            {!help && screen.view.stop ? (
              <Chip icon="target" label={t('screen.goToStop')} onPress={screen.focusStop} dark />
            ) : null}
            {!screen.view.fit ? <Chip icon="fit" label={t('screen.fit')} onPress={screen.fit} dark /> : null}
          </View>
        ) : null}
        {screen.phase === 'connecting' ? (
          <Overlay>
            <ActivityIndicator color={palette.codeInk} />
            <AppText variant="sub" style={{ color: palette.codeInk, textAlign: 'center' }}>
              {t('screen.connecting', { name })}
            </AppText>
          </Overlay>
        ) : null}
        {ended ? (
          <Overlay>
            <View
              accessibilityRole="alert"
              style={{
                alignItems: 'center',
                gap: 8,
                maxWidth: 300,
                padding: 20,
                borderRadius: 18,
                borderWidth: 1,
                borderColor: palette.lineStrong,
                backgroundColor: palette.sheet,
              }}
            >
              <Icon name={ended.icon} size={28} color={screen.issue === 'error' ? palette.brick : palette.muted} />
              <AppText style={{ fontFamily: fonts.bodySemi, fontSize: 16, textAlign: 'center' }}>
                {t(ended.title, { name })}
              </AppText>
              <AppText variant="sub" tone="muted" style={{ textAlign: 'center', marginBottom: 6 }}>
                {t(screen.issue === 'error' && control ? 'screen.ended.error.bodyControl' : ended.body, { name })}
              </AppText>
              {ended.retry ? (
                <Button label={t('screen.reconnect')} icon="restart" size="sm" onPress={screen.reconnect} />
              ) : null}
            </View>
          </Overlay>
        ) : null}
        {guide && control && live && sheet === null ? <Guide onClose={closeGuide} /> : null}
        {toast ? (
          <View
            pointerEvents="none"
            accessibilityLiveRegion="polite"
            style={{
              position: 'absolute',
              top: 12,
              left: 24,
              right: 24,
              alignItems: 'center',
            }}
          >
            <AppText
              variant="sub"
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 10,
                borderWidth: 1,
                overflow: 'hidden',
                textAlign: 'center',
                borderColor: toast.tone === 'cue' ? mix(palette.cue, palette.line, 0.55) : palette.lineStrong,
                backgroundColor: toast.tone === 'cue' ? palette.cueSoft : palette.sheet,
                color: palette.ink,
              }}
            >
              {toast.text}
            </AppText>
          </View>
        ) : null}
      </View>

      <View
        style={{
          gap: 8,
          paddingHorizontal: 12,
          paddingTop: 10,
          paddingBottom: keyboard ? 8 : insets.bottom + 10,
          backgroundColor: palette.canvas,
        }}
      >
        {control ? (
          <>
            <View
              accessibilityRole="toolbar"
              accessibilityLabel={t('screen.keys')}
              style={{ flexDirection: 'row', gap: 6 }}
            >
              {KEYS.map((item) => (
                <Pressable
                  key={item.key}
                  accessibilityRole="button"
                  accessibilityLabel={t(item.label)}
                  disabled={!live}
                  onPress={() => screen.pressKey(item.key)}
                  style={({ pressed }) => ({
                    ...(item.key === 'BackSpace' ? { width: 54 } : { flex: 1 }),
                    height: 36,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 5,
                    borderRadius: 9,
                    borderWidth: 1,
                    borderColor: pressed ? palette.lineStrong : palette.line,
                    backgroundColor: pressed ? palette.group : palette.surface,
                    opacity: live ? 1 : 0.45,
                  })}
                >
                  {item.icon ? <Icon name={item.icon} size={16} color={palette.ink} /> : null}
                  {item.key === 'BackSpace' ? null : (
                    <AppText variant="mono" style={{ fontSize: 12.5 }}>
                      {t(item.label)}
                    </AppText>
                  )}
                </Pressable>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                ref={input}
                value={text}
                onChangeText={setText}
                onSubmitEditing={sendText}
                submitBehavior="submit"
                editable={live}
                placeholder={t('screen.type.placeholder')}
                placeholderTextColor={palette.faint}
                accessibilityLabel={t('screen.type.placeholder')}
                maxLength={FLEET_NOTE_MAX}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                // The code a text message brought shows above the keyboard, ready to type.
                textContentType="oneTimeCode"
                autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
                returnKeyType="send"
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 44,
                  paddingHorizontal: 14,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: palette.lineStrong,
                  backgroundColor: palette.surface,
                  color: palette.ink,
                  fontFamily: fonts.body,
                  fontSize: 15,
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('screen.type.send')}
                disabled={!text || !live}
                onPress={sendText}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: palette.ink,
                  opacity: !text || !live ? 0.4 : pressed ? 0.85 : 1,
                })}
              >
                <Icon name="arrow-up" size={20} color={palette.canvas} />
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <AppText variant="sub" tone="muted" style={{ marginHorizontal: 2 }}>
              {other ? t('screen.hint.other', { device: other }) : t('screen.hint.view', { name })}
            </AppText>
            <Button
              label={busy ? t('screen.taking') : t('screen.take')}
              icon="hand"
              size="lg"
              busy={busy}
              disabled={!live || other !== null}
              onPress={() => void take()}
            />
            {takeError ? (
              <AppText accessibilityRole="alert" variant="sub" style={{ color: palette.brick }}>
                {takeError}
              </AppText>
            ) : null}
          </>
        )}
      </View>

      <Sheet
        open={sheet === 'give'}
        title={t('screen.give.title', { name })}
        onClose={() => (busy ? undefined : setSheet(null))}
      >
        <View style={{ gap: 10, paddingHorizontal: 4 }}>
          <AppText variant="sub" tone="muted" style={{ fontSize: 14.5, lineHeight: 20 }}>
            {t('screen.give.body', { name })}
          </AppText>
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={FLEET_NOTE_MAX}
            placeholder={t('screen.give.notePlaceholder')}
            placeholderTextColor={palette.faint}
            accessibilityLabel={t('screen.give.note', { name })}
            style={{
              minHeight: 64,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderWidth: 1,
              borderRadius: 12,
              borderColor: palette.line,
              backgroundColor: palette.raised,
              color: palette.ink,
              fontFamily: fonts.body,
              fontSize: 15,
              textAlignVertical: 'top',
            }}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {(['screen.give.quickSigned', 'screen.give.quickDone'] as const).map((key) => (
              <Chip key={key} label={t(key)} onPress={() => setNote(t(key))} />
            ))}
          </View>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: palette.line,
              backgroundColor: palette.raised,
            }}
          >
            <View style={{ flex: 1 }}>
              <AppText style={{ fontFamily: fonts.bodySemi, fontSize: 15 }}>{t('screen.give.continue')}</AppText>
              <AppText variant="sub" tone="muted">
                {t('screen.give.continueSub', { name })}
              </AppText>
            </View>
            <Switch
              accessibilityLabel={t('screen.give.continue')}
              value={resume}
              onValueChange={setResume}
              trackColor={{ true: palette.moss, false: palette.lineStrong }}
            />
          </View>
          <Button
            label={resume ? t('screen.give.submitContinue') : t('screen.give.submit')}
            size="lg"
            busy={busy}
            onPress={() => void giveBack()}
          />
          <Button label={t('screen.give.keep')} variant="ghost" disabled={busy} onPress={() => setSheet(null)} />
          {giveError ? (
            <AppText accessibilityRole="alert" variant="sub" style={{ color: palette.brick, textAlign: 'center' }}>
              {giveError}
            </AppText>
          ) : null}
        </View>
      </Sheet>

      <Sheet
        open={sheet === 'conflict'}
        title={
          conflictDevice ? t('screen.conflict.title', { device: conflictDevice }) : t('screen.conflict.titleUnknown')
        }
        onClose={() => setSheet(null)}
      >
        <View style={{ gap: 10, paddingHorizontal: 4 }}>
          <AppText variant="sub" tone="muted" style={{ fontSize: 14.5, lineHeight: 20 }}>
            {conflictDevice ? t('screen.conflict.body', { device: conflictDevice }) : t('screen.conflict.bodyUnknown')}
          </AppText>
          <Button
            label={t('screen.conflict.retry')}
            size="lg"
            busy={busy}
            onPress={() => {
              setSheet(null)
              void take()
            }}
          />
          <Button label={t('screen.conflict.watch')} variant="ghost" onPress={() => setSheet(null)} />
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  )
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 20,
        backgroundColor: 'rgba(12,13,12,0.55)',
      }}
    >
      {children}
    </View>
  )
}

function Chip({ icon, label, onPress, dark }: { icon?: IconName; label: string; onPress: () => void; dark?: boolean }) {
  const { palette } = useTheme()
  const color = dark ? palette.codeInk : palette.ink
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        height: 30,
        paddingHorizontal: 10,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: dark ? 'rgba(255,255,255,0.1)' : palette.lineStrong,
        backgroundColor: dark ? 'rgba(12,13,12,0.86)' : pressed ? palette.surface : 'transparent',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={15} color={color} /> : null}
      <AppText style={{ fontFamily: fonts.bodyMedium, fontSize: 13, color }}>{label}</AppText>
    </Pressable>
  )
}

const GUIDE: { icon: IconName; title: MessageKey; text: MessageKey }[] = [
  { icon: 'tap', title: 'screen.guide.tapTitle', text: 'screen.guide.tap' },
  { icon: 'drag', title: 'screen.guide.dragTitle', text: 'screen.guide.drag' },
  { icon: 'pinch', title: 'screen.guide.pinchTitle', text: 'screen.guide.pinch' },
  { icon: 'keyboard', title: 'screen.guide.typeTitle', text: 'screen.guide.type' },
]

/** How touches drive the screen, once: the first time this phone controls one. */
function Guide({ onClose }: { onClose: () => void }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  return (
    <View
      accessibilityViewIsModal
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        backgroundColor: 'rgba(12,13,12,0.74)',
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 320,
          padding: 18,
          paddingTop: 16,
          borderRadius: 18,
          borderWidth: 1,
          borderColor: palette.lineStrong,
          backgroundColor: palette.sheet,
        }}
      >
        <AppText
          style={{
            fontFamily: fonts.mono,
            fontSize: 11,
            lineHeight: 14,
            letterSpacing: 0.66,
            textTransform: 'uppercase',
            color: palette.cueInk,
          }}
        >
          {t('screen.controlling')}
        </AppText>
        <View style={{ gap: 12, marginTop: 12, marginBottom: 16 }}>
          {GUIDE.map((row) => (
            <View key={row.icon} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Icon name={row.icon} size={26} color={palette.brass} />
              <AppText style={{ flex: 1, fontSize: 14.5, lineHeight: 19, color: palette.muted }}>
                <AppText style={{ fontFamily: fonts.bodySemi, fontSize: 14.5, color: palette.ink }}>
                  {t(row.title)}
                </AppText>{' '}
                {t(row.text)}
              </AppText>
            </View>
          ))}
        </View>
        <Button label={t('screen.guide.ok')} size="sm" onPress={onClose} />
      </View>
    </View>
  )
}
