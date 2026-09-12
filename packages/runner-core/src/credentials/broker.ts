export type ProviderCredentialName = 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY'

export class CredentialBroker {
  constructor(private readonly credentials: Partial<Record<ProviderCredentialName, string>>) {}

  forProvider(provider: 'codex' | 'claude-agent'): Record<string, string> {
    const key = provider === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
    const value = this.credentials[key]
    if (!value) throw new Error(`${key} is not configured for this runner.`)
    return { [key]: value }
  }
}
