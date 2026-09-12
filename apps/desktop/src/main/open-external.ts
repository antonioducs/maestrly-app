import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { resolveCode } from './vscode/resolve-code'
import { openInTerminal, spawnCli } from './platform'
import { tMain } from './i18n'

/**
 * Open a project root or conversation cwd in an external OS tool. Resolve dir from the store, never
 * arbitrary renderer input. Terminal/file manager are native; VS Code requires binary resolution
 * with GUI PATH handling.
 */
export type OpenTarget = 'terminal' | 'finder' | 'vscode'

/** Available targets: terminal and file manager always; editors only when installed. */
export function getOpenTargets(): { terminal: boolean; finder: boolean; vscode: boolean } {
  return { terminal: true, finder: true, vscode: !!resolveCode() }
}

export async function openExternal(dir: string, target: OpenTarget): Promise<{ ok: boolean; error?: string }> {
  const t = tMain('main')
  if (!dir || !existsSync(dir)) return { ok: false, error: t('openExternal.pathNotFound') }
  // Detach, unref, and ignore stdio so the external window lives independently; hide the Windows launcher
  // console.
  const launch = (bin: string, args: string[]) =>
    spawnCli(bin, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  try {
    switch (target) {
      case 'finder': {
        // shell.openPath opens Finder, Explorer, or the Linux file manager.
        const e = await shell.openPath(dir) // empty means success; nonempty means an error
        return e ? { ok: false, error: e } : { ok: true }
      }
      case 'terminal':
        openInTerminal(dir) // mac=open -a Terminal; win=cmd start; linux=x-terminal-emulator
        return { ok: true }
      case 'vscode': {
        const code = resolveCode()
        if (!code) return { ok: false, error: t('openExternal.vscodeNotFound') }
        launch(code, [dir])
        return { ok: true }
      }
      default:
        return { ok: false, error: t('openExternal.invalidTarget') }
    }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}
