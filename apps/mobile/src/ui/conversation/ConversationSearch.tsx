import { createContext, useContext, useEffect, useRef } from 'react'
import { ActivityIndicator, TextInput, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { IconButton } from '../primitives/IconButton'
import { AppText } from '../primitives/Text'

/** Whether the open conversation shows its search: the header opens it, the conversation runs it. */
export type ConversationSearchControl = { open: boolean; setOpen: (open: boolean) => void }
export const ConversationSearchContext = createContext<ConversationSearchControl>({ open: false, setOpen: () => {} })
export const useConversationSearch = () => useContext(ConversationSearchContext)

/** The search field over a conversation: how many messages hold the text, and a way to go through them. */
export function ConversationSearchBar({
  query,
  onQuery,
  position,
  count,
  more,
  loading,
  onOlder,
  onNewer,
  onClose,
}: {
  query: string
  onQuery: (query: string) => void
  /** The match shown, from the newest (0); null with none. */
  position: number | null
  count: number
  /** Older messages that are not loaded yet may hold more. */
  more: boolean
  loading: boolean
  onOlder: () => void
  onNewer: () => void
  onClose: () => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const input = useRef<TextInput>(null)
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])
  const searched = query.trim() !== ''
  const label = !searched
    ? ''
    : count === 0
      ? more
        ? t('search.noneLoaded')
        : t('search.none')
      : t('search.position', { index: (position ?? 0) + 1, count: more ? `${count}+` : count })
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        marginHorizontal: 12,
        marginTop: 4,
        marginBottom: 6,
        paddingLeft: 12,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: palette.raised,
      }}
    >
      <Icon name="search" size={17} color={palette.muted} />
      <TextInput
        ref={input}
        value={query}
        onChangeText={onQuery}
        placeholder={t('search.placeholder')}
        placeholderTextColor={palette.faint}
        accessibilityLabel={t('search.placeholder')}
        returnKeyType="search"
        onSubmitEditing={onOlder}
        submitBehavior="submit"
        autoCorrect={false}
        style={{
          flex: 1,
          minWidth: 0,
          height: 44,
          paddingHorizontal: 8,
          color: palette.ink,
          fontFamily: fonts.body,
          fontSize: 16,
        }}
      />
      {loading ? <ActivityIndicator size="small" color={palette.muted} /> : null}
      {label ? (
        <AppText
          variant="small"
          tone="muted"
          accessibilityLiveRegion="polite"
          style={{ fontFamily: fonts.mono, fontSize: 12, marginHorizontal: 4 }}
        >
          {label}
        </AppText>
      ) : null}
      <IconButton
        icon="chev-up"
        label={t('search.older')}
        size={19}
        disabled={!searched || (!more && (position === null || position >= count - 1))}
        onPress={onOlder}
      />
      <IconButton
        icon="chev-down"
        label={t('search.newer')}
        size={19}
        disabled={!searched || position === null || position <= 0}
        onPress={onNewer}
      />
      <IconButton icon="x" label={t('search.close')} size={19} onPress={onClose} />
    </View>
  )
}
