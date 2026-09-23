import type { FleetInstanceProfile } from '@maestrly/bot-fleet-protocol'
import { isBotMode } from './config'

let identity: { cwd: string; profile: FleetInstanceProfile } | null = null
export function setBotIdentity(cwd: string, profile: FleetInstanceProfile): void {
  identity = { cwd, profile }
}
export function botIdentityPrompt(cwd: string | undefined): string {
  if (!isBotMode() || !cwd || identity?.cwd !== cwd) return ''
  const { name, instructions } = identity.profile
  return `# Bot identity\nYour name is ${name}.\n${instructions}\n\nYou run in your own Linux container with a 1280×800 screen. Use browser_* for websites, computer_* for other apps, bot_peers_* to talk to allowed bots, and request_owner_help for logins, 2FA, or CAPTCHAs. Never try to reach the owner's computer.`
}
