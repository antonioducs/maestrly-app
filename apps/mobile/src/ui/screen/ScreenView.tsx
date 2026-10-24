import { FLEET_SCREEN } from '@maestrly/bot-fleet-protocol'
import { useImperativeHandle, useMemo, useRef, useState } from 'react'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { parseScreenPageMessage, screenPageDocument, type ScreenPageCommand } from '../../screen/screen-page'
import { useTheme } from '../../theme/ThemeProvider'
import { screenPageTheme } from './screen-theme'
import type { ScreenViewProps } from './screen-view-props'

/**
 * The page's address. WebCodecs works only in a secure context, which a document with no address is not on every
 * platform; an https address in the reserved `.invalid` domain gives it one and resolves nowhere, and the page's
 * policy loads nothing from it anyway.
 */
const BASE_URL = 'https://screen.maestrly.invalid/'
/** The only page the web view loads: the document it was given. Every other navigation is refused. */
const initial = (url: string) => url === BASE_URL || /^about:blank(?:[#?]|$)/.test(url)

/** A command as a call of the page's one entry point; JSON is a JavaScript literal once its two line breaks are. */
const call = (command: ScreenPageCommand) =>
  `window.maestrlyScreen(${JSON.stringify(JSON.stringify(command))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')});true;`

/**
 * A bot's screen, drawn by a page in a web view of its own: its own process, no cookies, cache, files or network, and
 * no way to navigate. Commands wait until the page says it is ready; a page that reloads (its process ended, or the
 * theme changed) says so again, and the screen sends what it needs once more.
 */
export function ScreenView({ ref, label, onMessage }: ScreenViewProps) {
  const { palette } = useTheme()
  // Its type's props default to `& undefined`, which leaves none; `object` keeps them.
  const web = useRef<WebView<object>>(null)
  const ready = useRef(false)
  const queue = useRef<ScreenPageCommand[]>([])
  const [generation, setGeneration] = useState(0)
  const source = useMemo(
    () => ({ html: screenPageDocument('react-native', screenPageTheme(palette), FLEET_SCREEN), baseUrl: BASE_URL }),
    [palette]
  )
  useImperativeHandle(
    ref,
    () => ({
      send(command) {
        if (ready.current && web.current) web.current.injectJavaScript(call(command))
        else queue.current.push(command)
      },
    }),
    []
  )

  function receive(event: WebViewMessageEvent) {
    const message = parseScreenPageMessage(event.nativeEvent.data)
    if (!message) return
    if (message.t === 'ready') {
      ready.current = true
      for (const command of queue.current.splice(0)) web.current?.injectJavaScript(call(command))
    }
    onMessage(message)
  }
  const restart = () => {
    ready.current = false
    queue.current = []
    setGeneration((value) => value + 1)
  }

  return (
    <WebView
      key={generation}
      ref={web}
      accessibilityLabel={label}
      source={source}
      // Every address reaches the check below; any other origin list would hand it to the system to open.
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={(request) => initial(request.url)}
      onLoadStart={() => {
        ready.current = false
      }}
      onMessage={receive}
      onContentProcessDidTerminate={restart}
      onRenderProcessGone={restart}
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
      bounces={false}
      overScrollMode="never"
      setBuiltInZoomControls={false}
      textInteractionEnabled={false}
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
      androidLayerType="hardware"
      style={{ flex: 1, backgroundColor: palette.codeBg }}
      containerStyle={{ flex: 1 }}
    />
  )
}
