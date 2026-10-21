import { View } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'

/**
 * Marks a conversation a bot started. Agent mode shows the same glyph bare in the composer's setup, so the bot's is
 * set on a tinted square, as the desktop sets it in a chip. Decorative: the rows and titles it sits in name the bot.
 */
export function BotMark({ size = 20 }: { size?: number }) {
  const { palette } = useTheme()
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        backgroundColor: palette.brassSoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name="bot" size={Math.round(size * 0.62)} color={palette.brass} />
    </View>
  )
}
