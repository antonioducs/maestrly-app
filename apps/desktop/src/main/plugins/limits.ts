/** Hard limits for plugin sources and packages. The largest measured catalog plugin uses about 20% of `files`. */
export const PLUGIN_LIMITS = {
  files: 4_000,
  totalBytes: 64 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  pathChars: 400,
  depth: 24,
  jsonBytes: 256 * 1024,
  marketplaceBytes: 1024 * 1024,
  marketplaceEntries: 2_000,
  licenseBytes: 64 * 1024,
  logoBytes: 256 * 1024,
  treeEntries: 200_000,
  gitTimeoutMs: 120_000,
  stagingMaxAgeMs: 30 * 60_000,
  startupTimeoutMaxMs: 120_000,
  toolTimeoutMaxMs: 3_600_000,
} as const
