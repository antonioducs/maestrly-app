import { Text, View } from 'react-native'
import { fonts } from '../theme/tokens'
import { useTheme } from '../theme/ThemeProvider'

export default function Index() {
  const { palette } = useTheme()
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.canvas }}>
      <Text style={{ fontFamily: fonts.display, fontSize: 34, color: palette.ink }}>Maestrly</Text>
    </View>
  )
}
