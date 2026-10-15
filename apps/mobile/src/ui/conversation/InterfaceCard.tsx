import { GENUI_WIDGET_MAX_CHARS, type GenUiWidgetIssueKind } from '@maestrly/bot-fleet-protocol'
import * as WebBrowser from 'expo-web-browser'
import { useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { confirm } from '../confirm'
import { interfaceLink } from '../links'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { CardError, shownError, useConversation } from './CueCard'
import { InterfaceView } from './InterfaceView'

/** Enough source to read on a phone; a block may hold up to 200,000 characters. */
const SOURCE_SHOWN = 20_000
/** Problems listed under an interface; the bridge reports each once. */
const ISSUES_SHOWN = 5
/** The least time between two messages an interface may ask to send. */
const SEND_INTERVAL_MS = 1000

type Issue = { kind: GenUiWidgetIssueKind; detail: string }

/**
 * An interactive interface in a reply, running in an isolated web view once its block is complete. What it asks of
 * the app, sending a message as the person or opening a page, always waits for the person to agree: the phone cannot
 * tell a tap in the interface from the block's own code.
 */
export function InterfaceCard({ html, complete }: { html: string; complete: boolean }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { sendMessage } = useConversation()
  const [open, setOpen] = useState(false)
  const [issues, setIssues] = useState<Issue[]>([])
  const [error, setError] = useState<string | null>(null)
  const asking = useRef(false)
  const lastSend = useRef(0)
  const runs = complete && !!html.trim() && html.length <= GENUI_WIDGET_MAX_CHARS
  const source = html.length > SOURCE_SHOWN ? `${html.slice(0, SOURCE_SHOWN)}\n…` : html

  async function ask(run: () => Promise<void>) {
    // One question at a time: a block that asks again while one is open, or right after, is ignored.
    if (asking.current) return
    asking.current = true
    try {
      await run()
    } catch (cause) {
      setError(shownError(cause, t('interface.failed')))
    } finally {
      asking.current = false
    }
  }

  const onSend = (text: string) => {
    if (!sendMessage || Date.now() - lastSend.current < SEND_INTERVAL_MS) return
    void ask(async () => {
      const sure = await confirm({
        title: t('interface.sendTitle'),
        message: text,
        confirmLabel: t('interface.send'),
        cancelLabel: t('common.cancel'),
      })
      lastSend.current = Date.now()
      if (!sure) return
      setError(null)
      await sendMessage(text)
    })
  }

  const onOpen = (url: string) => {
    const link = interfaceLink(url)
    if (!link) return
    void ask(async () => {
      const sure = await confirm({
        title: t('interface.openTitle', { host: link.host }),
        message: link.url,
        confirmLabel: t('interface.open'),
        cancelLabel: t('common.cancel'),
      })
      if (sure) await WebBrowser.openBrowserAsync(link.url)
    })
  }

  const onIssue = (kind: GenUiWidgetIssueKind, detail: string) =>
    setIssues((current) => (current.length >= ISSUES_SHOWN ? current : [...current, { kind, detail }]))

  return (
    <View
      style={{
        marginBottom: 10,
        paddingVertical: 12,
        paddingHorizontal: runs ? 10 : 14,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: palette.raised,
        gap: 10,
      }}
    >
      {runs ? (
        <InterfaceView html={html} label={t('interface.title')} onSend={onSend} onOpen={onOpen} onIssue={onIssue} />
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: runs ? 4 : 0 }}>
        <View
          aria-hidden
          style={{
            width: runs ? 26 : 38,
            height: runs ? 26 : 38,
            borderRadius: runs ? 8 : 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.brassSoft,
          }}
        >
          <Icon name="sparkles" size={runs ? 14 : 19} color={palette.brass} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText style={{ fontSize: runs ? 13.5 : 15, lineHeight: 20, fontFamily: fonts.bodySemi }}>
            {t('interface.title')}
          </AppText>
          {runs ? null : (
            <AppText variant="small" tone="muted" accessibilityLiveRegion="polite">
              {complete ? t('interface.tooLong') : t('interface.writing')}
            </AppText>
          )}
        </View>
        {complete && html.trim() ? (
          <Button
            label={open ? t('interface.hideCode') : t('interface.showCode')}
            size="sm"
            variant="secondary"
            onPress={() => setOpen((value) => !value)}
          />
        ) : null}
      </View>
      {issues.length ? (
        <View style={{ gap: 2, paddingHorizontal: runs ? 4 : 0 }}>
          <AppText variant="small" tone="muted" style={{ fontWeight: '600' }}>
            {t('interface.issues')}
          </AppText>
          {issues.map((issue, index) => (
            <AppText key={`${issue.kind}:${index}`} variant="small" tone="muted" numberOfLines={2}>
              {`• ${t(`interface.issue.${issue.kind}`)}${issue.detail ? `: ${issue.detail}` : ''}`}
            </AppText>
          ))}
        </View>
      ) : null}
      <CardError text={error} />
      {open ? (
        <ScrollView
          horizontal
          style={{ maxHeight: 320, borderRadius: 12, backgroundColor: palette.codeBg }}
          contentContainerStyle={{ padding: 12 }}
        >
          <AppText
            selectable
            style={{ fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 20, color: palette.codeInk }}
          >
            {source}
          </AppText>
        </ScrollView>
      ) : null}
    </View>
  )
}
