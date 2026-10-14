import * as WebBrowser from 'expo-web-browser'
import type { ReactNode } from 'react'
import { Linking, Text, type ImageStyle, type TextStyle } from 'react-native'
import { Renderer } from 'react-native-marked'
import { imageLabel, safeLink } from '../links'

function open(url: string) {
  if (url.startsWith('mailto:')) void Linking.openURL(url).catch(() => {})
  else void WebBrowser.openBrowserAsync(url).catch(() => {})
}

/**
 * Renders a reply's links and images safely: links open only web pages and email, in the system's browser view, and
 * images are links to open rather than pictures loaded at once, since loading one tells its server what was shown.
 */
export class ReplyRenderer extends Renderer {
  constructor(private readonly words: { image: (name: string) => string; opens: string }) {
    super({ selectable: true })
  }

  private anchor(children: string | ReactNode[], href: string, styles?: TextStyle, label?: string): ReactNode {
    const url = safeLink(href)
    if (!url) return this.text(children, styles)
    return (
      <Text
        key={this.getKey()}
        selectable
        accessibilityRole="link"
        accessibilityHint={this.words.opens}
        accessibilityLabel={label}
        onPress={() => open(url)}
        style={styles}
      >
        {children}
      </Text>
    )
  }

  link(children: string | ReactNode[], href: string, styles?: TextStyle, title?: string): ReactNode {
    return this.anchor(children, href, styles, title)
  }

  image(uri: string, alt?: string, _style?: ImageStyle, title?: string): ReactNode {
    const name = this.words.image(imageLabel(uri, alt, title))
    return this.anchor(name, uri, { textDecorationLine: 'underline' })
  }

  linkImage(href: string, imageUrl: string, alt?: string, _style?: ImageStyle, title?: string): ReactNode {
    return this.anchor(this.words.image(imageLabel(imageUrl, alt, title)), href, { textDecorationLine: 'underline' })
  }
}
