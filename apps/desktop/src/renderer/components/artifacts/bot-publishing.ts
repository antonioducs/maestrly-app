import type { ArtifactServerStatus } from '../../../shared/artifacts'
import type { FleetInstallerStatus } from '../../../shared/fleet-installer'

export function canOfferBotPublishing(features: readonly string[], status: ArtifactServerStatus | null): boolean {
  return features.includes('artifacts') && status?.state === 'ready'
}

/** Omit the field entirely for gateways that did not offer this choice. */
export function botPublishingRequest(offered: boolean, enabled: boolean): { publishArtifacts?: boolean } {
  return offered ? { publishArtifacts: enabled } : {}
}

/** A returned failed job is not a rejected IPC call: check its result before creating the first bot. */
export async function prepareBotEnvironment(
  api: {
    fleetInstallerStatus: () => Promise<FleetInstallerStatus>
    fleetInstallerProvideBotEnvironment: () => Promise<FleetInstallerStatus>
  },
  onPreparing: () => void
): Promise<void> {
  const status = await api.fleetInstallerStatus()
  if (!status.record?.artifactsOnly) return
  onPreparing()
  const prepared = await api.fleetInstallerProvideBotEnvironment()
  if (prepared.record?.artifactsOnly || prepared.job?.state !== 'succeeded') {
    throw new Error(prepared.job?.error?.detail ?? prepared.job?.error?.code ?? 'bot-environment-unavailable')
  }
}
