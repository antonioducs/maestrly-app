import type { AuthStatus, DelegatedCredential, LegacyCredential, ModelCatalogEntry } from '@maestrly/host-protocol'
export interface AccountProvider {
  healthy?(): boolean
  status(): Promise<AuthStatus>
  startDevice(): Promise<AuthStatus>
  startApiKey(apiKey: string): Promise<AuthStatus>
  cancel(): Promise<AuthStatus>
  logout(): Promise<AuthStatus>
  models(): Promise<ModelCatalogEntry[]>
  credential(forceRefresh: boolean): Promise<DelegatedCredential>
  importCredential?(credential: LegacyCredential): Promise<void>
  close(): Promise<void>
}
export type AccountProviderFactory = (accountId: string) => Promise<AccountProvider>
