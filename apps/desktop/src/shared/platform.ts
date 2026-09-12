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
  workspaceId: string
  connectionId: string
  organizationId: string
  projectId: string
  boardId: string
  cardId?: string
  repositoryBindingId?: string
}

export interface EmbeddedRunnerView { mode?:'personal'|'team'; deviceId?:string;ownerUserId?:string; state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'; error?: string }

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
