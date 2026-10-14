import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'

/** Enough source to read on a phone; a block may hold up to 200,000 characters. */
const SOURCE_SHOWN = 20_000

/**
 * An interactive interface in a reply. Maestrly on a computer runs it in an isolated frame; the phone does not run
 * the model's code, so it names the interface and can show its source.
 */
export function InterfaceCard({ html, complete }: { html: string; complete: boolean }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const source = html.length > SOURCE_SHOWN ? `${html.slice(0, SOURCE_SHOWN)}\n…` : html
  return (
    <View
      style={{
        marginBottom: 10,
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: palette.raised,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          aria-hidden
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.brassSoft,
          }}
        >
          <Icon name="sparkles" size={19} color={palette.brass} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText style={{ fontSize: 15, lineHeight: 20, fontFamily: fonts.bodySemi }}>{t('interface.title')}</AppText>
          <AppText variant="small" tone="muted" accessibilityLiveRegion="polite">
            {complete ? t('interface.onComputer') : t('interface.writing')}
          </AppText>
        </View>
        {complete && html.trim() ? (
          <Button
            label={open ? t('interface.hideCode') : t('interface.showCode')}
            size="sm"
            variant="secondary"
            onPress={() => setOpen((value) => !value)}
          />
        ) : null}
      </View>
      {open ? (
        <ScrollView
          horizontal
          style={{ maxHeight: 320, borderRadius: 12, backgroundColor: palette.codeBg }}
          contentContainerStyle={{ padding: 12 }}
        >
          <AppText
            selectable
            style={{ fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 20, color: palette.codeInk }}
          >
            {source}
          </AppText>
        </ScrollView>
      ) : null}
    </View>
  )
}
