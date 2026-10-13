import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { View } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { AppText } from './Text'

/** A rounded group of cells with an optional label above and note below, as in iOS settings. */
export function Group({ label, foot, children }: { label?: string; foot?: ReactNode; children: ReactNode }) {
  const { palette } = useTheme()
  const items = Children.toArray(children).filter(isValidElement)
  return (
    <View style={label ? undefined : { marginTop: 12 }}>
      {label ? (
        <AppText
          variant="label"
          tone="muted"
          accessibilityRole="header"
          style={{ marginTop: 18, marginBottom: 7, marginHorizontal: 6 }}
        >
          {label}
        </AppText>
      ) : null}
      <View style={{ borderRadius: 14, overflow: 'hidden', backgroundColor: palette.group }}>
        {items.map((child, index) => (
          <Fragment key={child.key ?? index}>
            {index > 0 ? <View style={{ height: 1, marginLeft: 14, backgroundColor: palette.line }} /> : null}
            {child}
          </Fragment>
        ))}
      </View>
      {typeof foot === 'string' ? (
        <AppText variant="small" tone="muted" style={{ marginTop: 7, marginHorizontal: 6 }}>
          {foot}
        </AppText>
      ) : (
        foot
      )}
    </View>
  )
}
