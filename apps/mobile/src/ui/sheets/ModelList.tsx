import type { FleetSelection, FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import { useState } from 'react'
import { TextInput, View } from 'react-native'
import { groupOptions } from '../../fleet/setup'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { Icon } from '../icons'
import { Cell } from '../primitives/Cell'
import { Group } from '../primitives/Group'
import { AppText } from '../primitives/Text'

/** Every model the bot's accounts offer, by provider, with the bot's default on top. */
export function ModelList({
  botName,
  options,
  current,
  disabled,
  onPick,
}: {
  botName: string
  options: FleetSelectionOption[]
  current: FleetSelection | null
  disabled: boolean
  onPick: (option: FleetSelectionOption | null) => void
}) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const [query, setQuery] = useState('')
  const groups = groupOptions(options, query)
  const isCurrent = (option: FleetSelectionOption) =>
    current?.providerId === option.providerId && current.modelId === option.modelId
  return (
    <View>
      <View
        style={{
          height: 40,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          marginTop: 12,
          paddingHorizontal: 12,
          borderRadius: 12,
          backgroundColor: mix(palette.ink, palette.sheet, 0.07),
        }}
      >
        <Icon name="search" size={18} color={palette.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('setup.searchModels')}
          placeholderTextColor={palette.faint}
          accessibilityLabel={t('setup.searchModels')}
          autoCorrect={false}
          autoCapitalize="none"
          style={{ flex: 1, height: 40, color: palette.ink, fontFamily: fonts.body, fontSize: 16 }}
        />
      </View>
      {query.trim() ? null : (
        <Group>
          <Cell
            icon="bot"
            label={t('setup.botDefault')}
            sub={t('setup.botDefaultSub')}
            role="radio"
            checked={current === null}
            disabled={disabled}
            onPress={() => onPick(null)}
          />
        </Group>
      )}
      {groups.map((group) => (
        <Group key={group.provider} label={group.provider}>
          {group.options.map((option) => {
            const efforts = option.efforts.filter((effort) => !effort.includes('ultra')).length
            const sub = [
              efforts ? plural('setup.efforts', efforts) : t('setup.noEffortLevels'),
              option.fastMode ? t('setup.fast') : null,
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <Cell
                key={option.id}
                label={option.modelLabel}
                sub={sub}
                role="radio"
                checked={isCurrent(option)}
                disabled={disabled}
                onPress={() => onPick(option)}
              />
            )
          })}
        </Group>
      ))}
      {groups.length === 0 && query.trim() ? (
        <AppText variant="sub" tone="muted" style={{ marginTop: 16, marginHorizontal: 6 }}>
          {t('setup.noModels', { query: query.trim() })}
        </AppText>
      ) : null}
      <AppText variant="small" tone="muted" style={{ marginTop: 10, marginHorizontal: 6 }}>
        {t('setup.modelsFoot', { name: botName })}
      </AppText>
    </View>
  )
}
