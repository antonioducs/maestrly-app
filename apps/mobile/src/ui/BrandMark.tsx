import { View } from 'react-native'
import Svg, { G, Path } from 'react-native-svg'
import { BOTTOM_ARC, GLYPH_TRANSFORM, LEFT_FOOT, M_PATH, MARK_BOX, RIGHT_FOOT, RING_STROKE, TOP_ARC } from './brand'

const VIEWBOX = `${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.size} ${MARK_BOX.size}`

/** The Maestrly mark on its tile: an M with two inner feet in an open ring. */
export function BrandMark({ size, radius }: { size: number; radius?: number }) {
  return (
    <View
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? size * 0.25,
        backgroundColor: '#131514',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Svg width={size * 0.8} height={size * 0.8} viewBox={VIEWBOX}>
        <Path d={TOP_ARC} fill="none" stroke="#C9A86A" strokeWidth={RING_STROKE} strokeLinecap="round" />
        <Path d={BOTTOM_ARC} fill="none" stroke="#C9A86A" strokeWidth={RING_STROKE} strokeLinecap="round" />
        <G transform={GLYPH_TRANSFORM} fill="#EDEAE3" fillRule="evenodd">
          <Path d={M_PATH} />
          <Path d={LEFT_FOOT} />
          <Path d={RIGHT_FOOT} />
        </G>
      </Svg>
    </View>
  )
}
