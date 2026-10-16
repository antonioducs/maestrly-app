/** Environment settings are separate from the controller's own Chat settings. */
export const ENVIRONMENT_SETTINGS_SECTIONS = [
  'accounts',
  'models',
  'skills',
  'tools',
  'plugins',
  'components',
  'preferences',
] as const

export type EnvironmentSettingsSection = (typeof ENVIRONMENT_SETTINGS_SECTIONS)[number]

export interface EnvironmentSettingsDraft {
  dirty: boolean
  save: () => Promise<boolean>
  discard: () => void
}
