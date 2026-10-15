import type { FleetEnvironment, FleetLifecycle } from '@maestrly/bot-fleet-protocol'
import { useCallback, useState } from 'react'
import { Pressable, View } from 'react-native'
import { workspacesEnvironments } from '../../chats/environments'
import { useFleet } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'
import { Sheet } from '../primitives/Sheet'
import { AppText } from '../primitives/Text'

/** What a workspaces environment's state means for its chats: they open, they are on their way, or they wait. */
export function environmentState(lifecycle: FleetLifecycle): 'running' | 'starting' | 'stopped' {
  if (lifecycle === 'running') return 'running'
  return lifecycle === 'creating' || lifecycle === 'starting' || lifecycle === 'restarting' ? 'starting' : 'stopped'
}

function TintDot({ environment }: { environment: FleetEnvironment }) {
  const { palette } = useTheme()
  return (
    <View
      aria-hidden
      style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: environment.tint ?? palette.brass }}
    />
  )
}

/**
 * The workspaces environment whose chats the menu shows, for a server with several: one per scope of the owner's
 * work, each with its own workspaces and chats. Choosing another shows its chats.
 */
export function EnvironmentSwitcher({ onChosen }: { onChosen: () => void }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { environmentId, setEnvironment } = useServers()
  const environments = useFleet(useCallback((state: FleetState) => workspacesEnvironments(state.environments), []))
  const [open, setOpen] = useState(false)
  if (environments.length < 2) return null
  const shown = environments.find((item) => item.id === environmentId) ?? environments[0]
  const stateOf = (environment: FleetEnvironment) => t(`env.state.${environmentState(environment.lifecycle)}`)

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('env.switcher', { name: shown.name, state: stateOf(shown) })}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          marginHorizontal: 8,
          paddingHorizontal: 12,
          minHeight: 44,
          borderRadius: 12,
          backgroundColor: pressed ? palette.surface : 'transparent',
        })}
      >
        <TintDot environment={shown} />
        <AppText numberOfLines={1} style={{ flexShrink: 1, fontSize: 14.5, fontWeight: '600' }}>
          {shown.name}
        </AppText>
        <AppText variant="small" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
          {stateOf(shown)}
        </AppText>
        <Icon name="chev-down" size={16} color={palette.faint} />
      </Pressable>
      <Sheet open={open} title={t('env.choose')} onClose={() => setOpen(false)}>
        <AppText variant="sub" tone="muted" style={{ marginHorizontal: 4, marginBottom: 8 }}>
          {t('env.chooseBody')}
        </AppText>
        <View accessibilityRole="radiogroup">
          {environments.map((environment) => {
            const checked = environment.id === shown.id
            return (
              <Pressable
                key={environment.id}
                accessibilityRole="radio"
                accessibilityState={{ checked }}
                accessibilityLabel={`${environment.name}, ${stateOf(environment)}`}
                onPress={() => {
                  setOpen(false)
                  if (!checked) setEnvironment(environment.id)
                  onChosen()
                }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  minHeight: 52,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                  backgroundColor: pressed || checked ? palette.surface : 'transparent',
                })}
              >
                <TintDot environment={environment} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <AppText numberOfLines={1} style={{ fontSize: 16, fontWeight: '600' }}>
                    {environment.name}
                  </AppText>
                  <AppText variant="small" tone="muted">
                    {stateOf(environment)}
                  </AppText>
                </View>
                {checked ? <Icon name="check" size={18} color={palette.brass} /> : null}
              </Pressable>
            )
          })}
        </View>
      </Sheet>
    </>
  )
}
