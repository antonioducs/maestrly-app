const workspacePackages = ['protocol', 'client-sdk', 'runner-core']

export function missingWorkspaceBuilds(entries) {
  const files = new Set(entries.map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, '')))
  return workspacePackages
    .map((name) => `node_modules/@maestrly/${name}/dist/index.js`)
    .filter((entry) => !files.has(entry))
}
