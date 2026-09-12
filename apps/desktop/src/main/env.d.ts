// Build-time environment injected into the Electron main process.
interface ImportMetaEnv {
  /** Isolated application channel: prod, beta, or dev. */
  readonly MAIN_VITE_CHANNEL?: string
  /** Optional public client IDs for user-enabled third-party providers. */
  readonly MAIN_VITE_GITHUB_COPILOT_CLIENT_ID?: string
  readonly MAIN_VITE_XAI_OAUTH_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
