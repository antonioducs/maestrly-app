import { Alert, Platform } from 'react-native'

/**
 * Asks before something that cannot be undone. Native alerts focus Cancel first; React Native's web Alert does
 * nothing, so the web preview uses the browser's dialog.
 */
export function confirm(options: {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
}): Promise<boolean> {
  if (Platform.OS === 'web') {
    const browser = globalThis as { confirm?: (message: string) => boolean }
    return Promise.resolve(browser.confirm?.(`${options.title}\n\n${options.message}`) ?? false)
  }
  return new Promise((resolve) =>
    Alert.alert(
      options.title,
      options.message,
      [
        { text: options.cancelLabel, style: 'cancel', onPress: () => resolve(false) },
        {
          text: options.confirmLabel,
          style: options.destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    )
  )
}
