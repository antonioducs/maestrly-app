/**
 * Stub for `node-pty`, whose Electron ABI native binary cannot load in Vitest Node. Mapped through
 * `resolve.alias`. It remains a safeguard for transitive imports.
 */
export function spawn(): never {
  throw new Error('[test] node-pty.spawn is unavailable under Vitest (stub)')
}
export default { spawn }
