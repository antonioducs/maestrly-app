import type { FloatTab } from './tool-tabs'
import type { SubagentProfileRulesV1 } from './subagent-profiles'
import type { ChatGptWebCapabilities, ChatMode, ChatSkillSelection } from './chat'
import type { ConversationExperience } from './conversation-experience'
import type { MaestroConfigV1 } from './maestro'

export type ConversationMode = 'worktree' | 'local'
export type ConversationStatus = 'idle' | 'working' | 'ready' | 'waiting' | 'asking' | 'error'
/** Participating repository in a multi-repository conversation, with its isolated worktree/branch. */
export interface ConvRepo {
  workspaceId: string
  repoTop: string // repository root
  branch: string
  base: string
  worktreePath: string // external repository worktree under userData (#143)
  linkName: string // symlink name within the aggregator, e.g. backend
}
/** Floating-window position and size in DIPs, persisted across restarts. */
export interface FloatingBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Per-conversation UI preferences stored as ui_prefs JSON. */
export interface ConvUiPrefs {
  /** Automatically derive a title until the user names this conversation. */
  autoName?: boolean
  /** Main drawer tab order, using shared tool-tab keys. */
  mainTabOrder?: string[]
  /** Drawer tabs currently open (on-demand tab bar), using shared tool-tab keys. */
  openTabs?: string[]
  /** Active drawer tab among openTabs. */
  activeTab?: string
  /** Ordered browser tabs restored when reopening the app. */
  browserTabs?: { url: string; title?: string }[]
  /** Active browser-tab index within browserTabs. */
  browserActive?: number
  /** Last Companion ChatGPT conversation, resumable with a new MCP session. */
  chatGptWebUrl?: string
  /** Nonsecret MCP capability salt persists across resumes and rotates when Companion data is cleared. */
  chatGptWebSessionScope?: string
  /** Capability policy selected for this conversation's ChatGPT Web companion. */
  chatGptWebCapabilities?: ChatGptWebCapabilities
  /** Fingerprint of the policy/config used by the remote conversation's latest pairing. */
  chatGptWebPairedCapabilityFingerprint?: string
  /**
   * Per-detached-tab window bounds. Missing values are tolerated and patches merge for older database
   * compatibility.
   */
  floating?: Partial<Record<FloatTab, FloatingBounds>>
  /** Per-conversation Chat provider/model selection. */
  chat?: {
    providerId?: string
    modelId?: string
    /** Permission mode: full, ask, or auto; default inherits the global setting. */
    permMode?: 'full' | 'ask' | 'auto'
    /** Standard behavior mode. Design shares Agent capabilities while applying a prototype-focused harness. */
    mode?: ChatMode
    /**
     * Reasoning/thinking level, usually the provider's raw effort. maestrly-ultra is a local sentinel
     * intercepted before transport; off means none.
     */
    reasoning?: string
    /** Fast/Priority for embedded Codex; absent means Standard. */
    fastMode?: boolean
    /**
     * Runtime image rejection overrides catalog claims. Runner sets this to stop resending attachments;
     * model changes clear it.
     */
    imagesUnsupported?: boolean
    /**
     * Conversation app-tool enablement, disabled MCP servers, and image-generation override; absent image
     * setting inherits global chat.imageGen.
     */
    tools?: { app?: boolean; mcpDisabled?: string[]; imageGen?: boolean }
    /**
     * Conversation-only skill overrides map names to on/off; missing entries inherit global/base skill
     * selection.
     */
    skills?: Record<string, 'on' | 'off'>
    /** Conversation base skill selection; absent means all for legacy compatibility. */
    skillSelection?: ChatSkillSelection
    /** Optional deterministic subagent rules; absent inherits global rules. */
    subagentProfiles?: SubagentProfileRulesV1
    /** Enable deterministic profiles by default; false directly inherits the parent. */
    subagentProfilesEnabled?: boolean
    /** Allow subagent delegation, default on for legacy compatibility. */
    subagentsEnabled?: boolean
  }
  /** Maestro settings are an override; absence inherits the global Maestro configuration. */
  maestro?: { config?: MaestroConfigV1; projectScoped?: boolean }
  /** Plan-panel draft keyed by current plan version/hash. */
  planDraft?: {
    version: number
    planHash: string
    text: string
    feedback: string
    lineComments: Record<number, string>
    mode: 'read' | 'edit' | 'diff'
  }
}

interface ConversationBase {
  id: string
  name: string
  cwd: string // worktree or local root; multi-repository uses the aggregator
  status: ConversationStatus
  createdAt: number
  /** Zero means active; one means reversibly archived and hidden by default. */
  archived: number
  /** Pin timestamp, or null when unpinned. */
  pinnedAt: number | null
  /** Last creation/open/hook activity timestamp for sorting and relative-time display. */
  lastActivityAt: number
  /** Participating repositories in position order, with the primary first; multi-repository only. */
  repos?: ConvRepo[]
  /** Conversation UI preferences, including tab order and browser restoration. */
  uiPrefs?: ConvUiPrefs
}

export interface ProjectConversation extends ConversationBase {
  scope: 'project'
  workspaceId: string
  branch: string
  mode: ConversationMode
  /** Structural experience chosen at creation; an idle Maestro conversation may hand off to Standard. */
  experience: ConversationExperience
  /** One means multi-repository aggregator cwd; zero means single repository. */
  isMulti: number
}

export interface StandaloneConversation extends ConversationBase {
  scope: 'standalone'
  workspaceId: null
  branch: null
  mode: null
  experience: 'standard'
  isMulti: 0
  repos?: never
}

export type Conversation = ProjectConversation | StandaloneConversation
