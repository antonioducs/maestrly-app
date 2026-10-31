import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('multi-account selection surfaces', () => {
  it('keeps the exact provider slot in every chat model picker', () => {
    const chip = source('src/renderer/components/chat/ChatModelChip.tsx')
    const rows = source('src/renderer/components/chat/model-picker-rows.ts')
    const settings = source('src/renderer/components/chat/model-settings/SelectionBodies.tsx')
    const candidate = source('src/renderer/components/chat/subagent-profiles/CandidateFields.tsx')

    expect(rows).toContain('providerId: provider.id, providerName: provider.name')
    expect(chip).toMatch(/key=\{`\$\{r\.providerId\}::\$\{r\.modelId\}`\}/)
    // The default model and the image interpreter pick an account slot, not a provider kind.
    expect(settings).toContain('options={providers.map((provider) => ({ id: provider.id, label: provider.name }))}')
    expect(candidate).toContain('id: provider.id')
    expect(candidate).toContain('.chatSubagentProfilesModelCatalog(candidate.providerId)')
  })

  it('shares family-aware rotation messages across admission and persisted errors', () => {
    for (const file of ['ChatView.tsx', 'ChatMessageList.tsx']) {
      expect(source(`src/renderer/components/chat/${file}`)).toContain('subscriptionExhaustionMessageKey')
    }
    const accounts = source('src/renderer/components/chat/accounts/AccountsSettingsPanel.tsx')
    expect(accounts).toContain('subscriptionFailover.supportedKinds')
    expect(accounts).toContain('showSubscriptionFailover')
    expect(accounts).not.toContain('showCodexFailover')
    expect(source('src/renderer/components/chat/ChatView.tsx')).toContain('labelForSubscriptionProvider')
  })

  it('keeps configurator and quick usage identities account-scoped', () => {
    const configurator = source('src/renderer/components/chat/MaestroConfigurator.tsx')
    const usage = source('src/renderer/components/chat/quick-subscription-usage.ts')

    expect(configurator).toContain('state.catalog.providers.map((provider) => provider.id)')
    expect(configurator).toContain('providerFilter={providerFilter}')
    expect(usage).toContain('providerId: provider.id')
    expect(usage).toContain('accountId: provider.accountId ?? null')
  })

  it('offers the active-account entry in every model selection surface', () => {
    const selectionSurfaces = [
      'src/renderer/components/chat/ChatModelChip.tsx',
      'src/renderer/components/chat/ChatView.tsx',
      'src/renderer/components/chat/model-picker-rows.ts',
      'src/renderer/components/chat/model-settings/BackgroundTasks.tsx',
      'src/renderer/components/chat/model-settings/ModelsAgentsSettings.tsx',
      'src/renderer/components/chat/model-settings/SelectionBodies.tsx',
      'src/renderer/components/chat/subagent-profiles/CandidateFields.tsx',
      'src/renderer/components/chat/subagent-profiles/SubagentProfileRulesEditor.tsx',
    ]
    for (const file of selectionSurfaces) expect(source(file), file).toContain('chatProviderChoices(')

    // Names shown for a stored selection must resolve the entry too.
    for (const file of [
      'src/renderer/components/UsagePanel.tsx',
      'src/renderer/components/chat/SubagentSessionPanel.tsx',
    ]) {
      expect(source(file), file).toContain('chatProviderChoices(')
    }
    // Failover labels read the physical accounts the chat view keeps.
    expect(source('src/renderer/components/chat/ChatView.tsx')).toContain('setChatProviders(cfg.providers)')
  })

  it('keeps account management and usage on the physical accounts', () => {
    const accountSurfaces = [
      'src/renderer/components/chat/accounts/account-entries.ts',
      'src/renderer/components/chat/accounts/AddAccountDialog.tsx',
      'src/renderer/components/chat/accounts/FailoverRouteEditor.tsx',
      'src/renderer/components/chat/quick-subscription-usage.ts',
    ]
    for (const file of accountSurfaces) expect(source(file), file).not.toContain('chatProviderChoices')
  })
})
