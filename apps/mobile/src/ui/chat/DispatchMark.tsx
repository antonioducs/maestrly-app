import { View } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'

/**
 * Marks a chat an agent started from another chat, on a tinted square as the bot's mark is, in the violet the desktop
 * sidebar uses for it. Decorative: the row it sits in names the chat it came from.
 */
export function DispatchMark({ size = 20 }: { size?: number }) {
  const { palette } = useTheme()
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        backgroundColor: palette.plumSoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name="dispatch" size={Math.round(size * 0.62)} color={palette.plum} />
    </View>
  )
}
