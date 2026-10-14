import { spawnSync } from 'node:child_process'

// Bundles both platforms to catch resolution and syntax errors in CI; native builds are out of scope here.
const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['expo', 'export', '--platform', 'ios', '--platform', 'android', '--output-dir', 'dist', '--clear'],
  { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, EXPO_NO_TELEMETRY: '1', CI: '1' } }
)
process.exit(result.status ?? 1)
