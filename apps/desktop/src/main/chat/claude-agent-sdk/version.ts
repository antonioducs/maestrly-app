/** Oldest Claude Code the Agent SDK integration accepts, within the same major release. */
export const CLAUDE_CODE_COMPATIBLE_VERSION = '2.1.263'

function versionParts(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  return [major, minor, patch]
}

export function isCompatibleClaudeCodeVersion(version: string): boolean {
  const current = versionParts(version)
  const minimum = versionParts(CLAUDE_CODE_COMPATIBLE_VERSION)
  if (current[0] !== minimum[0]) return false
  if (current[1] !== minimum[1]) return current[1] > minimum[1]
  return current[2] >= minimum[2]
}
