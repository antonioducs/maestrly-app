import Constants from 'expo-constants'
import { router } from 'expo-router'
import { useState } from 'react'
import { View } from 'react-native'
import { useI18n, type LocalePreference } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { useTheme, type ThemePreference } from '../theme/ThemeProvider'
import { confirm } from '../ui/confirm'
import { Button } from '../ui/primitives/Button'
import { Cell } from '../ui/primitives/Cell'
import { Group } from '../ui/primitives/Group'
import { Segmented } from '../ui/primitives/Segmented'
import { AppText } from '../ui/primitives/Text'
import { SheetScreen } from '../ui/SheetScreen'

export default function Settings() {
  const theme = useTheme()
  const { t, preference, setPreference } = useI18n()
  const { active, forget, deviceName } = useServers()
  const [busy, setBusy] = useState(false)
  const server = active?.name ?? ''

  async function unpair() {
    if (!active) return
    const sure = await confirm({
      title: t('settings.unpairTitle', { server }),
      message: t('settings.unpairBody', { server }),
      confirmLabel: t('settings.unpairConfirm'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    })
    if (!sure) return
    setBusy(true)
    try {
      await forget(active.id, { remote: true })
    } catch {
      // The server could not be told; forgetting it here leaves this phone listed there until `devices revoke`.
      const anyway = await confirm({
        title: t('settings.forgetTitle', { server }),
        message: t('settings.forgetBody'),
        confirmLabel: t('settings.forgetConfirm'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      })
      if (!anyway) {
        setBusy(false)
        return
      }
      await forget(active.id, { remote: false })
    }
    setBusy(false)
    router.dismissAll()
    router.replace('/')
  }

  return (
    <SheetScreen title={t('settings.title')} onDone={() => router.back()}>
      {active ? (
        <Group label={t('settings.server')}>
          <Cell icon="server" label={active.name} sub={active.origin.replace(/^https?:\/\//, '')} chevron onPress={() => router.push('/servers')} />
        </Group>
      ) : null}
      <AppText variant="label" tone="muted" accessibilityRole="header" style={{ marginTop: 18, marginBottom: 7, marginHorizontal: 6 }}>
        {t('settings.appearance')}
      </AppText>
      <Segmented<ThemePreference>
        label={t('settings.appearance')}
        value={theme.preference}
        onChange={theme.setPreference}
        options={[
          { value: 'system', label: t('theme.system') },
          { value: 'light', label: t('theme.light') },
          { value: 'dark', label: t('theme.dark') },
        ]}
      />
      <AppText variant="label" tone="muted" accessibilityRole="header" style={{ marginTop: 18, marginBottom: 7, marginHorizontal: 6 }}>
        {t('settings.language')}
      </AppText>
      <Segmented<LocalePreference>
        label={t('settings.language')}
        value={preference}
        onChange={setPreference}
        options={[
          { value: 'system', label: t('language.system') },
          { value: 'en', label: t('language.en') },
          { value: 'pt-BR', label: t('language.pt-BR') },
        ]}
      />
      {active ? (
        <Group label={t('settings.thisPhone')} foot={t('settings.unpairFoot', { server })}>
          <Cell label={t('settings.deviceName')} value={active.deviceName || deviceName} />
          <View style={{ padding: 4 }}>
            <Button label={t('settings.unpair', { server })} variant="danger" busy={busy} onPress={() => void unpair()} />
          </View>
        </Group>
      ) : null}
      <AppText variant="small" tone="faint" style={{ textAlign: 'center', marginTop: 24 }}>
        {t('settings.about', { version: Constants.expoConfig?.version ?? '' })}
      </AppText>
    </SheetScreen>
  )
}
