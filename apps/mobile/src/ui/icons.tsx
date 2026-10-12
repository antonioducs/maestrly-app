import { memo } from 'react'
import { View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { ICON_PATHS } from './icon-paths'

export type IconName = keyof typeof ICON_PATHS

/** A line icon in the current color. Icons are decorative: the control around them carries the label. */
export const Icon = memo(function Icon({
  name,
  size = 20,
  color,
  strokeWidth = 1.8,
}: {
  name: IconName
  size?: number
  color: string
  strokeWidth?: number
}) {
  const xml = `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name].replaceAll('currentColor', color)}</svg>`
  // On the web the SVG becomes a DOM element, so the accessibility props go on a native view around it.
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  )
})
