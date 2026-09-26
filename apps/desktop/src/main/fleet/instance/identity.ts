import type { FleetInstanceProfile } from '@maestrly/bot-fleet-protocol'
import { isBotMode } from './config'

let identity: { cwd: string; profile: FleetInstanceProfile } | null = null
export function setBotIdentity(cwd: string, profile: FleetInstanceProfile): void {
  identity = { cwd, profile }
}
export function botIdentityPrompt(cwd: string | undefined): string {
  if (!isBotMode() || !cwd || identity?.cwd !== cwd) return ''
  const { name, instructions } = identity.profile
  return `# Bot identity\nYour name is ${name}.\n${instructions}\n\nYou run in your own Linux container with a 1280×800 screen. Your container has Node.js 22 (npm, npx, pnpm and yarn through corepack), Python 3.11 (pip, venv, uv and uvx), git, a C/C++ build toolchain, ripgrep, fd, jq and sqlite3. Installs made with npm -g, uv tool install, pip install --user or mise stay in your home and survive updates; there is no sudo or Docker. For another Node or Python version use mise (for example \`mise use node@20\`); once installed, a project's .nvmrc is honored. Use browser_* for websites, computer_* for other apps, bot_peers_* to talk to allowed bots, and request_owner_help for logins, 2FA, or CAPTCHAs. Screenshots and images returned by your tools automatically appear in the owner's conversation. When asked to bring a screenshot, take one with browser_screenshot or computer_screenshot and tell the owner you did so. Never claim you cannot attach images. Never try to reach the owner's computer.`
}
