import { View } from 'react-native'
import Svg, { G, Path } from 'react-native-svg'

/** The Maestrly mark (prototypes/mobile-app/assets/mark.svg, from the desktop brand assets): an M in an open ring. */
const M_PATH =
  'M950 5686 c0 -2766 -7 -2520 73 -2448 23 21 87 75 142 119 305 247 352 286 368 305 16 19 17 113 17 1669 0 1151 3 ' +
  '1649 11 1649 9 0 335 -318 789 -770 108 -107 414 -409 680 -670 267 -261 613 -601 770 -755 599 -591 691 -680 703 ' +
  '-682 14 -3 118 96 517 491 162 160 549 541 860 846 637 625 1155 1137 1395 1378 89 89 167 162 174 162 10 0 12 ' +
  '-349 11 -1642 -1 -904 -1 -1648 -1 -1654 1 -6 56 -55 122 -110 67 -54 167 -136 223 -182 56 -46 117 -95 136 -110 ' +
  '19 -14 47 -37 62 -50 16 -14 33 -22 42 -19 24 9 24 4934 1 4943 -9 4 -35 -9 -63 -30 -52 -39 -408 -291 -532 -376 ' +
  '-87 -60 -204 -146 -351 -257 -52 -39 -164 -142 -249 -228 -85 -86 -407 -405 -714 -708 -308 -304 -634 -627 -725 ' +
  '-718 -91 -91 -331 -329 -533 -529 l-367 -363 -38 33 c-21 18 -218 211 -438 429 -1105 1095 -2014 1992 -2045 2018 ' +
  '-33 29 -201 155 -382 289 -46 34 -150 107 -233 163 -82 56 -175 120 -205 142 -30 22 -78 55 -105 74 -28 18 -57 40 ' +
  '-64 49 -7 9 -22 16 -32 16 -19 0 -19 -60 -19 -2474z'

export function BrandMark({ size, radius }: { size: number; radius?: number }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? size * 0.25,
        backgroundColor: '#131514',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Svg width={size * 0.8} height={size * 0.8} viewBox="-32.7 77.8 966.4 966.4">
        <Path d="M 188.9 241.4 A 413.0 413.0 0 0 1 711.7 241.1" fill="none" stroke="#C9A86A" strokeWidth={23.3} strokeLinecap="round" />
        <Path d="M 719.9 874.0 A 413.0 413.0 0 0 1 181.6 874.5" fill="none" stroke="#C9A86A" strokeWidth={23.3} strokeLinecap="round" />
        <G transform="translate(0,1120) scale(0.1,-0.1)" fill="#EDEAE3" fillRule="evenodd">
          <Path d={M_PATH} />
        </G>
      </Svg>
    </View>
  )
}
