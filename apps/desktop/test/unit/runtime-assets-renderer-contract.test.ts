import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import enChat from '../../src/shared/i18n/en/chat'
import ptBrChat from '../../src/shared/i18n/pt-BR/chat'
import { RUNTIME_ASSET_IDS } from '../../src/shared/runtime-assets'

const apiSettings = readFileSync(
  new URL('../../src/renderer/components/chat/ApiKeySettings.tsx', import.meta.url),
  'utf8'
)
const subscriptionAccount = readFileSync(
  new URL('../../src/renderer/components/chat/accounts/SubscriptionAccount.tsx', import.meta.url),
  'utf8'
)
const webSettings = readFileSync(
  new URL('../../src/renderer/components/chat/ChatGptWebSettings.tsx', import.meta.url),
  'utf8'
)
const componentSettings = readFileSync(
  new URL('../../src/renderer/components/chat/RuntimeComponentsSettings.tsx', import.meta.url),
  'utf8'
)

describe('managed runtime renderer contract', () => {
  it('gates Codex and Copilot login behind their explicit managed runtime installs', () => {
    expect(subscriptionAccount).toContain("'codex-subscription': 'codex-runtime'")
    expect(subscriptionAccount).toContain("'github-copilot-subscription': 'github-copilot-runtime'")
    expect(subscriptionAccount).toContain("t('settings.componentInstallAndConnect')")
    expect(subscriptionAccount).toContain('api.runtimeAssetRepair(runtimeId)')
    expect(subscriptionAccount.indexOf('runtimeAssetInstall(runtimeId)')).toBeLessThan(
      subscriptionAccount.indexOf('chatSubscriptionLogin(providerKind, accountId)')
    )
  })

  it('re-probes the account slot after install before allowing OAuth/reset', () => {
    const install = subscriptionAccount.indexOf('api.runtimeAssetInstall(runtimeId)')
    const probe = subscriptionAccount.indexOf('const recovered = await refreshStatus(true)')
    const login = subscriptionAccount.indexOf('api.chatSubscriptionLogin(providerKind, accountId)')

    expect(install).toBeGreaterThanOrEqual(0)
    expect(probe).toBeGreaterThan(install)
    expect(probe).toBeLessThan(login)
    expect(subscriptionAccount).toContain("recovered?.authenticated || recovered?.state === 'signed-in'")
    expect(subscriptionAccount).toContain("recovered?.state !== 'signed-out'")
    expect(subscriptionAccount).toContain('chatSubscriptionStatus(providerKind, force, accountId)')
  })

  it('never offers the runtime download when the build cannot sign in, and names the reason', () => {
    expect(subscriptionAccount).toContain("status?.errorCode === 'subscription-provider-not-configured'")
    expect(subscriptionAccount).toMatch(/const loginDisabled =[^;]*\bnotConfigured\b/)
    expect(subscriptionAccount).toContain("runtime.status.state !== 'ready' && !notConfigured")
    expect(subscriptionAccount).toContain('statusErrorText(recovered) ||')
    expect(subscriptionAccount).toContain('statusErrorText(result.status) || result.error ||')
    for (const catalog of [enChat.settings, ptBrChat.settings] as Record<string, unknown>[]) {
      expect(catalog.subscriptionNotConfigured).toEqual(expect.stringContaining('{{provider}}'))
      expect(catalog.subscriptionNotConfiguredShort).toEqual(expect.any(String))
    }
  })

  it('refreshes the matching account card once when a managed runtime becomes ready', () => {
    expect(subscriptionAccount).toContain("next.status.state === 'ready'")
    expect(subscriptionAccount).toContain("previousState !== 'ready'")
    expect(subscriptionAccount).toContain('!runtimeInstallInProgressRef.current')
    expect(subscriptionAccount).toContain('void refreshStatus(true).finally')
  })

  it('shows all managed components through list/onChanged with install, cancel, repair, and remove actions', () => {
    expect(apiSettings).toContain('<RuntimeComponentsSettings />')
    expect(componentSettings).toContain('api.runtimeAssetList()')
    expect(componentSettings).toContain('api.onRuntimeAssetChanged')
    expect(componentSettings).toContain('api.runtimeAssetInstall(id)')
    expect(componentSettings).toContain('api.runtimeAssetCancel(asset.id)')
    expect(componentSettings).toContain('api.runtimeAssetRepair(id)')
    expect(componentSettings).toContain('api.runtimeAssetRemove(id)')
  })

  it('offers independent release controls only for updatable, installed components', () => {
    expect(componentSettings).toContain('isUpdatableRuntimeAssetId(asset.id)')
    expect(componentSettings).toContain("asset.status.state !== 'ready'")
    for (const call of [
      'api.runtimeAssetCheckUpdate(id)',
      'api.runtimeAssetUpdate(id)',
      'api.runtimeAssetRollback(id)',
      'api.runtimeAssetSetAutoUpdate(id,',
    ]) {
      expect(componentSettings).toContain(call)
    }
    // Update failures use their own translated copy and never reuse the installation's error slot.
    expect(componentSettings).toMatch(/settings\.componentUpdateError_\$\{update\.error\}/)
    expect(componentSettings).toContain('update.restartRequired')
    expect(componentSettings).toContain('disabled={locked}')
    expect(componentSettings).not.toMatch(/relaunch|app\.quit|restartApp/)
  })

  it('names every runtime and the image-provided state in both catalogs', () => {
    for (const catalog of [enChat.settings, ptBrChat.settings] as Record<string, unknown>[]) {
      for (const id of RUNTIME_ASSET_IDS) {
        expect(catalog[`componentName_${id}`], id).toEqual(expect.any(String))
        expect(catalog[`componentRequiredBy_${id}`], id).toEqual(expect.any(String))
      }
      expect(catalog.componentProvidedByImage).toEqual(expect.any(String))
    }
    expect(componentSettings).toContain("t('settings.componentProvidedByImage')")
  })

  it('requires an explicit tunnel-client install before tunnel creation', () => {
    expect(webSettings).toContain("runtimeAssetStatus('tunnel-client')")
    expect(webSettings).toContain("runtimeAssetInstall('tunnel-client')")
    expect(webSettings).toContain("runtimeAssetRepair('tunnel-client')")
    expect(webSettings).toContain("tunnelAsset?.status.state !== 'ready'")
  })
})
