import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const apiSettings = readFileSync(
  new URL('../../src/renderer/components/chat/ApiKeySettings.tsx', import.meta.url),
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
    expect(apiSettings).toContain("'codex-subscription': 'codex-runtime'")
    expect(apiSettings).toContain("'github-copilot-subscription': 'github-copilot-runtime'")
    expect(apiSettings).toContain("t('settings.componentInstallAndConnect')")
    expect(apiSettings).toContain('window.api.runtimeAssetRepair(runtimeId)')
    expect(apiSettings.indexOf('runtimeAssetInstall(runtimeId)')).toBeLessThan(
      apiSettings.indexOf('chatSubscriptionLogin(providerKind, accountId)')
    )
  })

  it('re-probes the account slot after install before allowing OAuth/reset', () => {
    const install = apiSettings.indexOf('window.api.runtimeAssetInstall(runtimeId)')
    const probe = apiSettings.indexOf('const recovered = await refreshStatus(true)')
    const login = apiSettings.indexOf('window.api.chatSubscriptionLogin(providerKind, accountId)')

    expect(install).toBeGreaterThanOrEqual(0)
    expect(probe).toBeGreaterThan(install)
    expect(probe).toBeLessThan(login)
    expect(apiSettings).toContain('recovered?.authenticated || recovered?.state === \'signed-in\'')
    expect(apiSettings).toContain('recovered?.state !== \'signed-out\'')
    expect(apiSettings).toContain('chatSubscriptionStatus(providerKind, force, accountId)')
  })

  it('refreshes the matching account card once when a managed runtime becomes ready', () => {
    expect(apiSettings).toContain("next.status.state === 'ready'")
    expect(apiSettings).toContain("previousState !== 'ready'")
    expect(apiSettings).toContain('!runtimeInstallInProgressRef.current')
    expect(apiSettings).toContain('void refreshStatus(true).finally')
  })

  it('shows all managed components through list/onChanged with install, cancel, repair, and remove actions', () => {
    expect(apiSettings).toContain('<RuntimeComponentsSettings />')
    expect(componentSettings).toContain('window.api.runtimeAssetList()')
    expect(componentSettings).toContain('window.api.onRuntimeAssetChanged')
    expect(componentSettings).toContain('window.api.runtimeAssetInstall(id)')
    expect(componentSettings).toContain('window.api.runtimeAssetCancel(asset.id)')
    expect(componentSettings).toContain('window.api.runtimeAssetRepair(id)')
    expect(componentSettings).toContain('window.api.runtimeAssetRemove(id)')
  })

  it('offers independent release controls only for updatable, installed components', () => {
    expect(componentSettings).toContain('isUpdatableRuntimeAssetId(asset.id)')
    expect(componentSettings).toContain("asset.status.state !== 'ready'")
    for (const call of [
      'window.api.runtimeAssetCheckUpdate(id)',
      'window.api.runtimeAssetUpdate(id)',
      'window.api.runtimeAssetRollback(id)',
      'window.api.runtimeAssetSetAutoUpdate(id,',
    ]) {
      expect(componentSettings).toContain(call)
    }
    // Update failures use their own translated copy and never reuse the installation's error slot.
    expect(componentSettings).toMatch(/settings\.componentUpdateError_\$\{update\.error\}/)
    expect(componentSettings).toContain('update.restartRequired')
    expect(componentSettings).toContain('disabled={locked}')
    expect(componentSettings).not.toMatch(/relaunch|app\.quit|restartApp/)
  })

  it('requires an explicit tunnel-client install before tunnel creation', () => {
    expect(webSettings).toContain("runtimeAssetStatus('tunnel-client')")
    expect(webSettings).toContain("runtimeAssetInstall('tunnel-client')")
    expect(webSettings).toContain("runtimeAssetRepair('tunnel-client')")
    expect(webSettings).toContain("tunnelAsset?.status.state !== 'ready'")
  })
})
