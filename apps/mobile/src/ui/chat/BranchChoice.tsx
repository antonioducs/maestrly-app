import type { MobileBranches } from '@maestrly/bot-fleet-protocol'
import { validBranchName, type BranchDraft } from '../../chats/branch'
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, TextInput, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { Segmented } from '../primitives/Segmented'
import { Sheet } from '../primitives/Sheet'
import { AppText } from '../primitives/Text'

function Row({
  label,
  value,
  placeholder,
  onPress,
}: {
  label: string
  value: string | null
  placeholder: string
  onPress: () => void
}) {
  const { palette } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value ?? placeholder}`}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 46,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: pressed ? palette.line : palette.raised,
      })}
    >
      <AppText tone="muted" style={{ fontSize: 15 }}>
        {label}
      </AppText>
      <View
        style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}
      >
        {value ? <Icon name="branch" size={14} color={palette.muted} /> : null}
        <AppText
          numberOfLines={1}
          variant={value ? 'mono' : 'body'}
          tone={value ? 'ink' : 'faint'}
          style={{ flexShrink: 1, fontSize: value ? 13.5 : 15 }}
        >
          {value ?? placeholder}
        </AppText>
      </View>
      <Icon name="chev-right" size={16} color={palette.faint} />
    </Pressable>
  )
}

/** Every branch of the workspace, local first, with a search for workspaces that have many. */
function BranchPicker({
  open,
  title,
  branches,
  selected,
  onClose,
  onPick,
}: {
  open: boolean
  title: string
  branches: MobileBranches
  selected: string | null
  onClose: () => void
  onPick: (name: string) => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const items = useMemo(
    () =>
      [
        ...branches.local.map((name) => ({ name, remote: null as string | null })),
        ...branches.remote.map((item) => ({ name: item.name, remote: item.remote })),
      ].filter((item) => !q || item.name.toLowerCase().includes(q)),
    [branches, q]
  )
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <View
        style={{
          height: 40,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 12,
          marginBottom: 8,
          borderRadius: 12,
          backgroundColor: palette.surface,
        }}
      >
        <Icon name="search" size={16} color={palette.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('branch.search')}
          placeholderTextColor={palette.faint}
          accessibilityLabel={t('branch.search')}
          autoCorrect={false}
          autoCapitalize="none"
          style={{ flex: 1, minWidth: 0, height: 40, color: palette.ink, fontFamily: fonts.body, fontSize: 16 }}
        />
      </View>
      <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
        {items.length === 0 ? (
          <AppText variant="sub" tone="muted" style={{ padding: 12 }}>
            {t('branch.none')}
          </AppText>
        ) : null}
        {items.map((item) => {
          const checked = item.name === selected
          return (
            <Pressable
              key={`${item.remote ?? ''}:${item.name}`}
              accessibilityRole="radio"
              aria-checked={checked}
              accessibilityLabel={item.remote ? `${item.name}, ${item.remote}` : item.name}
              onPress={() => {
                onPick(item.name)
                setQuery('')
              }}
              style={({ pressed }) => ({
                minHeight: 46,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingHorizontal: 12,
                borderRadius: 12,
                backgroundColor: pressed ? palette.surface : 'transparent',
              })}
            >
              <Icon name="branch" size={16} color={palette.muted} />
              <AppText numberOfLines={1} variant="mono" style={{ flex: 1, minWidth: 0, fontSize: 14 }}>
                {item.name}
              </AppText>
              {item.name === branches.defaultBranch ? (
                <AppText variant="small" tone="faint">
                  {t('branch.default')}
                </AppText>
              ) : item.remote ? (
                <AppText variant="small" tone="faint">
                  {item.remote}
                </AppText>
              ) : null}
              {checked ? <Icon name="check" size={18} color={palette.brass} /> : null}
            </Pressable>
          )
        })}
      </ScrollView>
    </Sheet>
  )
}

/** Where a new chat of a workspace works, as on the desktop: a new branch from a base, or an existing branch. */
export function BranchChoice({
  branches,
  draft,
  onChange,
}: {
  branches: MobileBranches
  draft: BranchDraft
  onChange: (draft: BranchDraft) => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const [picking, setPicking] = useState<'base' | 'existing' | null>(null)
  const name = draft.name.trim()
  const invalid = draft.mode === 'new' && name !== '' && !validBranchName(name)
  return (
    <View style={{ alignSelf: 'stretch', gap: 8, marginTop: 4 }}>
      <Segmented
        label={t('branch.label')}
        options={[
          { value: 'new', label: t('branch.new') },
          { value: 'existing', label: t('branch.existing') },
        ]}
        value={draft.mode}
        onChange={(mode) => onChange({ ...draft, mode })}
      />
      {draft.mode === 'new' ? (
        <>
          <View
            style={{
              minHeight: 46,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: invalid ? palette.brick : 'transparent',
              backgroundColor: palette.raised,
            }}
          >
            <Icon name="branch" size={16} color={palette.muted} />
            <TextInput
              value={draft.name}
              onChangeText={(value) => onChange({ ...draft, name: value })}
              placeholder={t('branch.namePlaceholder')}
              placeholderTextColor={palette.faint}
              accessibilityLabel={t('branch.name')}
              autoCorrect={false}
              autoCapitalize="none"
              spellCheck={false}
              style={{ flex: 1, minWidth: 0, height: 46, color: palette.ink, fontFamily: fonts.mono, fontSize: 14 }}
            />
          </View>
          {invalid ? (
            <AppText variant="small" accessibilityRole="alert" style={{ color: palette.brick, marginHorizontal: 4 }}>
              {t('branch.invalid')}
            </AppText>
          ) : null}
          <Row
            label={t('branch.from')}
            value={draft.base ?? branches.defaultBranch}
            placeholder={t('branch.choose')}
            onPress={() => setPicking('base')}
          />
        </>
      ) : (
        <Row
          label={t('branch.label')}
          value={draft.existing}
          placeholder={t('branch.choose')}
          onPress={() => setPicking('existing')}
        />
      )}
      <BranchPicker
        open={picking !== null}
        title={picking === 'base' ? t('branch.from') : t('branch.existing')}
        branches={branches}
        selected={picking === 'base' ? (draft.base ?? branches.defaultBranch) : draft.existing}
        onClose={() => setPicking(null)}
        onPick={(picked) => {
          setPicking(null)
          if (picking === 'base') onChange({ ...draft, base: picked === branches.defaultBranch ? null : picked })
          else onChange({ ...draft, existing: picked })
        }}
      />
    </View>
  )
}
