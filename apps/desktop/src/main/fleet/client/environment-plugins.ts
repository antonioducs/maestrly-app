import type { FleetSettingsInput } from '@maestrly/bot-fleet-protocol'
import type { PluginOpErrorCode } from '../../../shared/plugins'
import { getMarketplace, listInstalled, readPluginSecrets } from '../../plugins/store'

/**
 * What a bot environment needs to install one of this computer's plugins on its own: the source, the exact commit,
 * the consent given here for that commit, whether it is on, and the values entered here. Built in the main process,
 * because those values never reach a renderer; they travel only to the environment, encrypted there on arrival.
 */
export function pluginBringPayload(
  key: string
): { ok: true; value: FleetSettingsInput<'bringPlugin'> } | { ok: false; error: PluginOpErrorCode } {
  const record = listInstalled()[key]
  if (!record || record.status !== 'ready') return { ok: false, error: 'unknown-plugin' }
  if (record.blocked?.length) return { ok: false, error: 'unavailable' }
  const source = getMarketplace(record.marketplaceId)
  if (!source) return { ok: false, error: 'unknown-marketplace' }
  const values = record.inputs?.length ? readPluginSecrets(key) : {}
  if (values === null) return { ok: false, error: 'secure-storage-unavailable' }
  return {
    ok: true,
    value: {
      source: {
        url: source.url,
        ref: source.ref,
        ...(source.sparsePaths.length ? { sparsePaths: source.sparsePaths } : {}),
      },
      name: record.name,
      commit: record.commit,
      consent: {
        consentFingerprint: record.consent.fingerprint,
        stdio: Object.keys(record.consent.stdio),
        executables: record.consent.executables,
      },
      enabled: record.enabled,
      ...(Object.keys(values).length ? { inputs: values } : {}),
    },
  }
}
