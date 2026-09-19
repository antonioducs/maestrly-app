import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { validateStandaloneConversationDirectory } from '../standalone-conversation-service'
import { excludeFromGitInfo } from '../git-service'
import type { NavigationDirection } from '../mouse-navigation'
import { getConversation } from '../store'
import { NAVIGATION_FILE, SELECTION_REL_DIR } from './vscode-ext-source'

/** Send workbench back/forward through the bridge extension's file channel. */
export async function requestVSCodeNavigation(convId: string, direction: NavigationDirection): Promise<void> {
  const conversation = getConversation(convId)
  const cwd = conversation?.cwd
  if (!cwd) return
  const dir = path.join(cwd, SELECTION_REL_DIR)
  try {
    if (conversation.scope === 'standalone') await validateStandaloneConversationDirectory(conversation)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, NAVIGATION_FILE), JSON.stringify({ direction, ts: Date.now() }))
    if (conversation?.scope !== 'standalone') await excludeFromGitInfo(cwd, [`${SELECTION_REL_DIR}/${NAVIGATION_FILE}`])
  } catch {
    /* best-effort */
  }
}
