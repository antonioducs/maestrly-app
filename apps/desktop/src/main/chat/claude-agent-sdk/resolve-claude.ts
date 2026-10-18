import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { isWin, winCliCandidates, whichBin } from '../../platform'

let cached: string | null = null

function linuxUsesMusl(): boolean {
  if (process.platform !== 'linux') return false
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  return !report?.header?.glibcVersionRuntime
}

/** SDK/CLI parity when optional native packages are installed; packaged lean builds may use the system fallback. */
export function bundledClaudeCandidate(): string | null {
  const supportedPlatform = ['darwin', 'linux', 'win32'].includes(process.platform)
  const supportedArch = process.arch === 'arm64' || process.arch === 'x64'
  if (!supportedPlatform || !supportedArch) return null
  const suffix = `${process.platform}-${process.arch}${linuxUsesMusl() ? '-musl' : ''}`
  const packageName = `@anthropic-ai/claude-agent-sdk-${suffix}`
  try {
    const manifest = createRequire(import.meta.url).resolve(`${packageName}/package.json`)
    return path.join(path.dirname(manifest), isWin ? 'claude.exe' : 'claude')
  } catch {
    return null
  }
}

function candidates(): string[] {
  const bundled = bundledClaudeCandidate()
  const system = isWin
    ? winCliCandidates('claude')
    : [
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        `${process.env.HOME ?? ''}/.npm-global/bin/claude`,
        '/usr/bin/claude',
        '/snap/bin/claude',
        `${process.env.HOME ?? ''}/.local/bin/claude`,
      ]
  return bundled ? [bundled, ...system] : system
}

/**
 * Resolve the executable used exclusively by the Claude Agent SDK provider. Only an executable that was found is
 * remembered: while none is, every call looks again, so Claude Code installed with the app open is picked up.
 */
export function resolveClaude(): string {
  if (cached) return cached
  for (const candidate of candidates()) {
    try {
      accessSync(candidate, constants.X_OK)
      cached = candidate
      return candidate
    } catch {
      // Next candidate.
    }
  }
  const found = whichBin('claude')
  if (found && path.isAbsolute(found)) {
    cached = found
    return found
  }
  // A bare name resolves through PATH at spawn time and fails with ENOENT when Claude Code is missing.
  return 'claude'
}

/** Forget the resolved executable, so the next resolution looks again (an explicit status refresh). */
export function clearClaudeCache(): void {
  cached = null
}
