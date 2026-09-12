export class ProviderProxy {
  private readonly origins: Set<string>
  constructor(origins: string[]) {
    this.origins = new Set(origins.map((origin) => new URL(origin).origin))
  }

  async request(url: string, init: RequestInit): Promise<Response> {
    const target = new URL(url)
    if (!this.origins.has(target.origin) || target.protocol !== 'https:') throw new Error('Provider destination is not authorized.')
    if (!['GET', 'POST'].includes(init.method ?? 'GET')) throw new Error('Provider operation is not authorized.')
    return fetch(target, { ...init, redirect: 'error' })
  }
}
