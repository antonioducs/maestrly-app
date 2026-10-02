import type { FleetEnvironmentSettingsService } from '@maestrly/bot-fleet-protocol'
import { IMAGE_GEN_FLAG } from '../../../chat/image-gen'
import { getAppFlag, setAppFlag } from '../../../store/app-settings'
import { InstanceHttpError } from '../server'
import { settingsRevision, withSettingsRevision } from './revisions'

export const preferences: FleetEnvironmentSettingsService['preferences'] = async () => ({
  revision: settingsRevision('preferences'),
  imageGenEnabled: getAppFlag(IMAGE_GEN_FLAG, true),
})

export const setPreferences: FleetEnvironmentSettingsService['setPreferences'] = async (input) => {
  await withSettingsRevision('preferences', input.expectedRevision, () => {
    try {
      setAppFlag(IMAGE_GEN_FLAG, input.imageGenEnabled)
    } catch {
      throw new InstanceHttpError(503, 'INSTANCE_UNAVAILABLE', 'Preferences could not be saved.')
    }
  })
  return preferences({})
}
