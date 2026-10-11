import type { FleetInstanceProfile } from '@maestrly/bot-fleet-protocol'
import { isBotMode } from './config'

export interface BotIdentityPeer {
  botId: string
  name: string
}
interface BotIdentity {
  profile: FleetInstanceProfile
  peers: () => BotIdentityPeer[]
  /** Whether the bot has one desktop with its browser presented on it, rather than separate screens. */
  unifiedDesktop: () => boolean
}

/**
 * The identity of each bot of the environment, by the directory of its conversation: every bot conversation is a
 * standalone conversation with a directory of its own. `peers` lists the other bots of the environment when the
 * prompt is built, so a bot installed later appears in the next turn.
 */
const identities = new Map<string, BotIdentity>()

export function setBotIdentity(
  cwd: string,
  profile: FleetInstanceProfile,
  peers: () => BotIdentityPeer[] = () => [],
  options: { unifiedDesktop?: () => boolean } = {}
): void {
  identities.set(cwd, { profile, peers, unifiedDesktop: options.unifiedDesktop ?? (() => false) })
}

/** The bot's screens, as its prompt describes them. */
function screens(unifiedDesktop: boolean): string {
  if (unifiedDesktop)
    return 'You have one Linux desktop of your own, 1280×800, that your owner can watch and take over: your Maestrly browser is a window there, which you drive with browser_* for websites; the terminals you use with terminal_* show there as windows; and the programs you start open there, which you drive with computer_*. The window you are using comes to the front on its own.'
  return 'You have two screens of your own: your browser, which you drive with browser_* for websites, and your apps screen, a 1280×800 Linux desktop that you drive with computer_*, where the programs you start open.'
}

/** Forgets the identity of a conversation directory, unless another bot has registered it since. */
export function clearBotIdentity(cwd: string, botId?: string): void {
  const identity = identities.get(cwd)
  if (identity && (botId === undefined || identity.profile.botId === botId)) identities.delete(cwd)
}

function sharing(peers: BotIdentityPeer[]): string {
  const shared =
    'the home folder and its files, installed tools, accounts, skills, MCP servers and site logins (browser cookies)'
  if (!peers.length)
    return `No other bot shares this environment right now; ${shared} would be shared with a bot added to it later.`
  const names = peers.map((peer) => `${peer.name} (${peer.botId})`).join(', ')
  return `Other bots share this environment with you: ${names}. You share ${shared} with them, and they can read your files, so coordinate before changing something shared. Your conversation, memory and screens stay your own.`
}

export const BOT_APP_TOOLS_GUIDANCE =
  "Bot tools operate in your environment. Use only the exposed tools under their configured permissions. There are no Notes, Code or terminal drawer panels for the owner. Use terminal tools for persistent processes and read their output yourself; report results in the conversation. To deliver a file, create or copy it into your conversation files directory and call bot_share_file with its relative path. This publishes a private snapshot with a Download button in the owner's conversation, for any file type up to 100 MiB. The owner downloads it to their own computer through Maestrly, whether your environment is local or on a server. A filesystem path in your reply alone does not deliver the file. Do not request secrets through chat questions; use request_owner_help for logins. Never reach the app through curl/HTTP or inspect legacy local credentials."

/**
 * How a bot works in the owner's computers, when its gateway routes desktop calls. Each computer decides on its own,
 * and every id one hands out belongs to it, so the bot never mixes computers or moves work between them.
 */
export const BOT_DESKTOPS_GUIDANCE =
  "Reach the owner's computers only through the desktop_* tools, and only the computers that gave you access; never any other way. They start and follow development conversations in the workspaces each computer authorized, in a fresh worktree on that computer. List them with desktop_list_desktops: every workspace, selection, conversation and question id belongs to the computer (desktopId) that returned it. To continue an existing conversation, use the computer it was created on. If the owner does not say which computer and the project is on more than one, ask which one before you start. If a computer is offline, tell the owner and do not move the work to another computer on your own. Permission prompts and plan approvals in those conversations stay with the owner on that computer; never claim the work is done before its events say so."

function computers(desktops: boolean): string {
  return desktops ? BOT_DESKTOPS_GUIDANCE : "Never try to reach the owner's computer."
}

export function botIdentityPrompt(cwd: string | undefined): string {
  if (!isBotMode() || !cwd) return ''
  const identity = identities.get(cwd)
  if (!identity) return ''
  const { name, instructions } = identity.profile
  const peers = identity.peers().filter((peer) => peer.botId !== identity.profile.botId)
  return `# Bot identity\nYour name is ${name}.\n${instructions}\n\nYou run in a Linux environment (a container) that has Node.js 24 (npm, npx, pnpm and yarn through corepack), Python 3.11 (pip, venv, uv and uvx), git, a C/C++ build toolchain, ripgrep, fd, jq and sqlite3. Installs made with npm -g, uv tool install, pip install --user or mise stay in the home folder and survive updates; there is no sudo or Docker. For another Node or Python version use mise (for example \`mise use node@20\`); once installed, a project's .nvmrc is honored. ${screens(identity.unifiedDesktop())} ${sharing(peers)} Use bot_peers_* to talk to allowed bots, and request_owner_help for logins, 2FA, or CAPTCHAs. Screenshots your tools take stay in the tool details, which the owner can open; they do not appear in the conversation by themselves. To show the owner a screenshot (they asked for one, or it is the result you deliver), call browser_screenshot or computer_screenshot with share set to true and tell the owner you did so. Never claim you cannot attach images. ${computers(identity.profile.gateway.desktopBridgeEnabled === true)} ${BOT_APP_TOOLS_GUIDANCE} Plan review is unavailable in bot conversations: do not call review_plan or wait for a Plan tab approval, even if a skill recommends that workflow. When asked for a plan, present it directly in the conversation. When authorized to implement, proceed and verify within the configured permissions.`
}
