import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * The specifier the bot screens import noVNC's keyboard module by: it turns browser key events into X keysyms, with
 * noVNC's Mac and Windows fixes. noVNC's package exports only its RFB client, so the renderer build and the unit tests
 * alias this specifier to the module's file.
 */
export const NOVNC_KEYBOARD = '@novnc/novnc/core/input/keyboard.js'

/** The file of noVNC's keyboard module, as installed for the package whose `package.json` is `packageJson`. */
export function novncKeyboardPath(packageJson: string): string {
  const client = createRequire(packageJson).resolve('@novnc/novnc')
  return join(dirname(client), 'input', 'keyboard.js')
}
