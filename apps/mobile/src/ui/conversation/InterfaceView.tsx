import { GENUI_WIDGET_MAX_HEIGHT, parseGenUiWidgetMessage } from '@maestrly/bot-fleet-protocol'
import { useMemo, useState } from 'react'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { useTheme } from '../../theme/ThemeProvider'
import { interfaceDocument, interfaceTheme } from './interface-document'
import type { InterfaceViewProps } from './interface-view-props'

/** The only page the web view loads: the document it was given. Every other navigation is refused. */
const INITIAL = /^about:blank(?:[#?]|$)/

/**
 * An interactive answer, running in a web view of its own: its own process, no cookies, cache or file access, no
 * windows, and no way to navigate. It reaches the app only through messages, each checked before the app acts on it.
 */
export function InterfaceView({ html, label, onSend, onOpen, onIssue }: InterfaceViewProps) {
  const { palette, scheme } = useTheme()
  const [height, setHeight] = useState(120)
  const source = useMemo(
    () => ({ html: interfaceDocument(html, interfaceTheme(palette), 'react-native', scheme) }),
    [html, palette, scheme]
  )

  function onMessage(event: WebViewMessageEvent) {
    let data: unknown
    try {
      data = JSON.parse(event.nativeEvent.data)
    } catch {
      return
    }
    const message = parseGenUiWidgetMessage(data)
    if (!message) return
    if (message.type === 'size') setHeight(Math.max(1, Math.min(message.height, GENUI_WIDGET_MAX_HEIGHT)))
    else if (message.type === 'send') onSend(message.text)
    else if (message.type === 'open') onOpen(message.url)
    else if (message.type === 'issue') onIssue(message.kind, message.detail)
  }

  return (
    <WebView
      accessibilityLabel={label}
      source={source}
      // Every address reaches the check below; any other origin list would hand it to the system to open.
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={(request) => INITIAL.test(request.url)}
      onMessage={onMessage}
      incognito
      cacheEnabled={false}
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      allowsLinkPreview={false}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      mixedContentMode="never"
      mediaPlaybackRequiresUserAction
      scrollEnabled={false}
      overScrollMode="never"
      showsVerticalScrollIndicator={false}
      style={{ height, backgroundColor: 'transparent' }}
      containerStyle={{ height, flex: 0 }}
    />
  )
}
