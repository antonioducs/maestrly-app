import { useState } from 'react'
import { View } from 'react-native'
import { ArtifactOpenError, type ArtifactOpenIssue, type ArtifactPublication } from '../../artifacts/artifacts'
import { useOpenArtifact } from '../../artifacts/useOpenArtifact'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'

/** A page an agent published, with a way to open the version it published. */
export function ArtifactCard({ artifact }: { artifact: ArtifactPublication }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const open = useOpenArtifact()
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<ArtifactOpenIssue | null>(null)
  return (
    <View
      style={{
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: palette.raised,
        gap: 8,
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
          <Icon name="artifact" size={19} color={palette.brass} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText numberOfLines={2} style={{ fontSize: 15, lineHeight: 20, fontFamily: fonts.bodySemi }}>
            {artifact.title || t('artifact.untitled')}
          </AppText>
          <AppText variant="small" tone="muted">
            {t('artifact.version', { version: artifact.version })}
          </AppText>
        </View>
        <Button
          label={t('artifact.open')}
          accessibilityLabel={t('artifact.openNamed', { title: artifact.title || t('artifact.untitled') })}
          size="sm"
          variant="secondary"
          busy={busy}
          onPress={() => {
            setBusy(true)
            setIssue(null)
            open(artifact)
              .catch((error: unknown) => setIssue(error instanceof ArtifactOpenError ? error.issue : 'offline'))
              .finally(() => setBusy(false))
          }}
        />
      </View>
      {issue ? (
        <AppText
          accessibilityRole="alert"
          variant="small"
          style={{ color: issue === 'demo' ? palette.muted : palette.brick }}
        >
          {t(`artifact.error.${issue}`)}
        </AppText>
      ) : null}
    </View>
  )
}
