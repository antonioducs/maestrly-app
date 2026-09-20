export interface PlatformConnectionView {
  id: string
  url: string
  name: string
  instanceId: string | null
  state: 'disconnected' | 'connecting' | 'authorizing' | 'connected' | 'incompatible' | 'unavailable'
  identity: { userId: string; email?: string } | null
  desktopClientId?:string
  credentialPersistence: 'secure' | 'memory' | 'none'
  error?: string
}

export interface DeviceAuthorizationView {
  connectionId: string
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  interval: number
}

export interface PlatformProjectBinding {
  /** Changes when the link is recreated; cached tools cannot survive unlink/relink. */
  revision?: string
  /** Display labels are cached for offline navigation; IDs remain authoritative. */
  projectName?: string
  boardName?: string
  organizationName?: string
  workspaceId: string
  connectionId: string
  organizationId: string
  projectId: string
  boardId: string
  cardId?: string
  repositoryBindingId?: string
}

export interface WorkspaceKanbanLink extends PlatformProjectBinding {
  url: string
  state: 'connected' | 'disconnected' | 'unavailable'
}

export interface EmbeddedRunnerView { mode?:'personal'|'team'; deviceId?:string;ownerUserId?:string; state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'; error?: string }

/**
 * What this computer currently offers for delegated stages, and what it is running right now. Read-only:
 * a stage is controlled from Maestrly, never from here.
 */
export interface DelegationStatusView {
  /** False when the executor is stopped, the server has no delegation capability, or nothing is publishable. */
  enabled: boolean
  /** Revision of the published inventory, so a mismatch with the server is visible. */
  revision: string | null
  issues: string[]
  workspaces: Array<{ key: string; label: string; branches: string[] }>
  selections: Array<{ selectionId: string; accountLabel: string; modelLabel: string; efforts: string[]; fastMode: boolean }>
  /** Stage attempts this computer admitted and has not finished reporting. */
  active: Array<{ attemptId: string; taskId: string; stageId: string; state: string }>
}

export interface RemotePlatformProject {
  organizationId: string
  organizationName: string
  projectId: string
  projectName: string
  repositories?:Array<{id:string;name:string;baseBranch?:string;cloneUrl?:string}>
  boards: Array<{ id: string; name: string }>
}

export interface DesktopExecutorSettings {
 mode:'personal'|'team';background:boolean;autoStart:boolean;connectionId?:string;providerIds:string[];
 allowCommands:boolean;allowWeb:boolean;allowAppTools:boolean;allowMcp:boolean;allowPush:boolean;skills:boolean;interactiveChat?:boolean;
}
export interface DesktopExecutionRecord {runId:string;cardId:string;title:string;conversationId:string;workspacePath:string;state:string;startedAt:number;summary?:string}
