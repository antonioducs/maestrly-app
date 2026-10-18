import { DICTATION_PROVIDERS, type DictationProvider } from '@maestrly/bot-fleet-protocol'
import { useState } from 'react'
import { TextInput, View } from 'react-native'
import { DEMO_SERVER } from '../../demo/demo-source'
import { effectiveDictationChoice, type DictationChoice } from '../../dictation/preference'
import { dictationSettingsView } from '../../dictation/settings-model'
import { useI18n } from '../../i18n'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { confirm } from '../confirm'
import { Button } from '../primitives/Button'
import { Segmented } from '../primitives/Segmented'
import { AppText } from '../primitives/Text'

const PROVIDERS: DictationProvider[] = ['openai', 'groq']

/**
 * Where this phone's dictation is transcribed, and the bot server's key for it. The key goes to the server, which
 * checks it with the provider before keeping it; the phone keeps nothing but the choice.
 */
export function DictationSettings() {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { active, controller, dictation, setDictationChoice, refreshDictation } = useServers()
  const [provider, setProvider] = useState<DictationProvider>('openai')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const demo = active?.id === DEMO_SERVER.id
  const status = dictation.status
  const view = dictationSettingsView({ features: active?.features ?? [], demo, status })
  const choice: DictationChoice = active
    ? effectiveDictationChoice(dictation.choice, {
        features: active.features,
        configured: status ? status.configured : null,
        demo,
      })
    : 'phone'
  const providerLabel = (id: DictationProvider) => DICTATION_PROVIDERS[id].label

  async function save() {
    if (!controller || !key.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await controller.source.call('dictationKeySet', { body: { provider, key: key.trim() } })
      if ('error' in result) {
        setMessage(
          t(result.error === 'key-rejected' ? 'settings.dictationKeyRejected' : 'settings.dictationKeyUnchecked')
        )
        return
      }
      setKey('')
      await refreshDictation()
    } catch {
      setMessage(t('settings.dictationKeyUnchecked'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!controller) return
    const sure = await confirm({
      title: t('settings.dictationKeyRemoveTitle'),
      message: t('settings.dictationKeyRemoveBody'),
      confirmLabel: t('settings.dictationKeyRemove'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    })
    if (!sure) return
    setBusy(true)
    try {
      await controller.source.call('dictationKeyDelete')
      await refreshDictation()
    } catch {
      setMessage(t('composer.failed'))
    } finally {
      setBusy(false)
    }
  }

  const note =
    view.serverOption === 'old-server'
      ? t('settings.dictationOldServer')
      : view.serverOption === 'no-key'
        ? t('settings.dictationNoKey')
        : null
  const foot =
    choice === 'server' && status?.provider
      ? t('settings.dictationFootServer', { provider: providerLabel(status.provider) })
      : t('settings.dictationFootPhone')

  return (
    <View>
      <AppText
        variant="label"
        tone="muted"
        accessibilityRole="header"
        style={{ marginTop: 18, marginBottom: 7, marginHorizontal: 6 }}
      >
        {t('settings.dictation')}
      </AppText>
      {view.serverOption === 'available' ? (
        <Segmented<DictationChoice>
          label={t('settings.dictation')}
          value={choice}
          onChange={setDictationChoice}
          options={[
            { value: 'phone', label: t('settings.dictationPhone') },
            { value: 'server', label: t('settings.dictationServer') },
          ]}
        />
      ) : (
        <Segmented<DictationChoice>
          label={t('settings.dictation')}
          value="phone"
          onChange={() => {}}
          options={[{ value: 'phone', label: t('settings.dictationPhone') }]}
        />
      )}
      <AppText variant="small" tone="muted" style={{ marginTop: 7, marginHorizontal: 6 }}>
        {note ? `${note} ${foot}` : foot}
      </AppText>
      {view.keyForm ? (
        <View style={{ marginTop: 14, marginHorizontal: 6, gap: 8 }}>
          {status?.configured && status.provider ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <AppText variant="small" style={{ flex: 1 }}>
                {t('settings.dictationKeyState', {
                  provider: providerLabel(status.provider),
                  hint: status.keyHint ?? '',
                })}
              </AppText>
              <Button
                label={t('settings.dictationKeyRemove')}
                variant="ghost"
                size="sm"
                disabled={busy}
                onPress={() => void remove()}
              />
            </View>
          ) : null}
          <Segmented<DictationProvider>
            label={t('settings.dictationProvider')}
            value={provider}
            onChange={setProvider}
            options={PROVIDERS.map((id) => ({ value: id, label: providerLabel(id) }))}
          />
          <TextInput
            value={key}
            onChangeText={(value) => {
              setKey(value)
              setMessage(null)
            }}
            placeholder={t('settings.dictationKeyPlaceholder')}
            placeholderTextColor={palette.faint}
            accessibilityLabel={t('settings.dictationKeyPlaceholder')}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            editable={!busy}
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            style={{
              height: 46,
              paddingHorizontal: 14,
              borderWidth: 1,
              borderRadius: 14,
              borderColor: message ? palette.brick : palette.line,
              backgroundColor: palette.raised,
              color: palette.ink,
              fontFamily: fonts.mono,
              fontSize: 15,
            }}
          />
          {message ? (
            <AppText variant="small" accessibilityRole="alert" style={{ color: palette.brick }}>
              {message}
            </AppText>
          ) : null}
          <Button
            label={t('settings.dictationKeySave')}
            size="sm"
            busy={busy}
            disabled={busy || !key.trim()}
            onPress={() => void save()}
          />
        </View>
      ) : null}
    </View>
  )
}
